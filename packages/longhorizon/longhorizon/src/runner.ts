/**
 * Long-horizon runner plugin: the one-shot driver that creates or resumes a
 * run, seeds its durable snapshot and requirements, installs the Task State
 * section, drives it through verified completion, and exits with the run's
 * status code. The model proposes progress; only host-side verification
 * evidence for every required requirement at the current revision allows the
 * run to conclude as `done`. Mounted as the `@deepseek-ai/dsh-longhorizon/runner`
 * row.
 * @module @deepseek-ai/dsh-longhorizon/runner
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  buildEvidence,
  continueMessage,
  derivedFor,
  evidenceEquivalent,
  allRequiredVerified,
  latestEvidenceForRequirement,
  installTaskStateSection,
  lastTurnEnd,
  renderTrajectory,
  verifyRequirement,
  writeTrajectory,
  type LongHorizonService,
  type TaskRequirement,
  type TaskSnapshot,
  type VerificationEvidence,
} from './index.ts'
import { budgetExhausted, finalExitCode, isTerminalStatus } from './guards.ts'

/** Stable Cordis plugin name. */
export const name = 'longhorizon-runner'

/** Services required before the one-shot run can start. */
export const inject = ['agentDefaultModel', 'agents', 'longhorizon', 'sessions', 'systemPrompt']

/** One verifier specification declared in runner config. */
type RequirementVerifierConfig =
  | { type: 'artifact'; path: string }
  | { type: 'command'; command: string[] }

/** One requirement declaration in runner config (additive over the legacy artifacts surface). */
interface RequirementConfig {
  id: string
  description: string
  required: boolean
  verifier: RequirementVerifierConfig
}

const VerifierSchema: z<RequirementVerifierConfig> = z.union([
  z.object({ type: z.const('artifact'), path: z.string().required() }),
  z.object({ type: z.const('command'), command: z.array(z.string()).min(1).required() }),
])

const RequirementSpecSchema: z<RequirementConfig> = z.object({
  id: z.string().required(),
  description: z.string().required(),
  required: z.boolean().default(true),
  verifier: VerifierSchema,
})

/** Plugin config: the task plus the run tunables. */
export interface Config {
  /** The prompt text for this run (fresh start) or the immediate continuation instruction (resume). */
  task: string
  /** Resume the persisted run with this session id instead of creating a fresh session. */
  resumeSessionId?: string
  /** Hard cap on agent steps; overrides the controller default for this run. */
  maxSteps?: number
  /** Write the run's readable trajectory markdown to this path. */
  trajectoryPath?: string
  /** Workspace root; defaults to the invocation cwd. */
  workspace?: string
  /** Declared required artifact requirements (legacy surface; maps to artifact verifiers). */
  artifacts?: string[]
  /** Optional host-side verification command (legacy surface; becomes a command requirement). */
  artifactVerify?: string[]
  /** Explicit requirement declarations; when present, used verbatim over the legacy mapping. */
  requirements?: RequirementConfig[]
  /** Facts file path relative to the workspace. */
  factsFile?: string
}

export const Config: z<Config> = z.object({
  task: z.string().required(),
  resumeSessionId: z.string().required(false),
  maxSteps: z.number().step(1).min(1).required(false),
  trajectoryPath: z.string().required(false),
  workspace: z.string().required(false),
  artifacts: z.array(z.string()).required(false),
  artifactVerify: z.array(z.string()).required(false),
  requirements: z.array(RequirementSpecSchema).required(false),
  factsFile: z.string().required(false),
})

/** Process-facing effects of one run: output streams plus the launcher's bounded exit request. */
interface RunnerIo {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
  /** Request process exit with `code` after the tree disposes. */
  exit(code: number): void
}

/** The process streams the runner writes to; tests substitute captures. */
export const internals: { stdout: RunnerIo['stdout']; stderr: RunnerIo['stderr'] } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/** Narrow a content block to a text block, or return undefined. */
function textOf(block: { readonly type?: string; readonly text?: unknown }): string | undefined {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/** Aggregate the last assistant text and turn outcome in one owned interval. */
function summarize(events: readonly SessionEvent[], firstSeq: number): { text: string; reason: SessionEvent<'turn/end'>['data']['reason'] | undefined } {
  let started = false
  let text = ''
  let reason: SessionEvent<'turn/end'>['data']['reason'] | undefined
  for (const event of events) {
    if (event.seq < firstSeq) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = event.data.message.content.map(textOf).filter((part): part is string => part !== undefined).join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') reason = event.data.reason
  }
  return { text, reason }
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: RunnerIo, error: unknown): void {
  io.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Resolve the run's requirements from config. The legacy `artifacts` surface
 * maps to required artifact verifiers and `artifactVerify` to a required
 * command verifier; when the explicit `requirements` surface is present it is
 * used verbatim. The default run always carries at least the REPORT.md
 * artifact requirement, so a run with no verifiable conditions is not
 * expressible through the happy path.
 */
export function resolveRequirements(config: Config): TaskRequirement[] {
  // schemastery coerces an absent optional array to `[]`, so absence is an
  // EMPTY list, not undefined — an explicit empty list is not a declaration.
  if (config.requirements !== undefined && config.requirements.length > 0) {
    return config.requirements.map(requirement => ({
      id: requirement.id,
      description: requirement.description,
      required: requirement.required,
      verifier: requirement.verifier,
    }))
  }
  const artifacts = config.artifacts !== undefined && config.artifacts.length > 0 ? config.artifacts : ['REPORT.md']
  const requirements: TaskRequirement[] = artifacts.map(path => ({
    id: `artifact:${path}`,
    description: `Produce artifact ${path}`,
    required: true,
    verifier: { type: 'artifact', path },
  }))
  if (config.artifactVerify !== undefined && config.artifactVerify.length > 0) {
    requirements.push({
      id: 'command:verify',
      description: 'Host verification command passes',
      required: true,
      verifier: { type: 'command', command: config.artifactVerify },
    })
  }
  return requirements
}

/**
 * Host-side verification of every requirement under the current snapshot,
 * appending durable evidence only when the outcome or content identity
 * changed since the latest check. Re-verified each drive-loop idle, so a
 * mutated artifact is caught by a fresh hash.
 */
function refreshEvidence(session: Session, snapshot: TaskSnapshot, workspace: string, service: LongHorizonService): void {
  for (const requirement of snapshot.requirements) {
    const outcome = verifyRequirement(requirement.verifier, workspace)
    const latest = latestEvidenceForRequirement(session.events, requirement.id, snapshot.taskRevision)
    const evidence: VerificationEvidence = buildEvidence(requirement, outcome, snapshot.taskRevision)
    if (latest === undefined || !evidenceEquivalent(latest, evidence)) {
      service.appendEvidence(session, evidence)
    }
  }
}

/** The unverified required conditions' names, as a human-readable comma list. */
function unverifiedNames(snapshot: TaskSnapshot, events: readonly SessionEvent[]): { names: string[]; text: string } {
  const names = snapshot.requirements
    .filter(requirement => requirement.required
      && latestEvidenceForRequirement(events, requirement.id, snapshot.taskRevision)?.status !== 'passed')
    .map(requirement => requirement.description)
  return { names, text: names.join(', ') }
}

/**
 * Mount the demo runner: seed state, install the section, then drive the run
 * to a verified conclusion (or a terminal status without one).
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated runner config.
 */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('longhorizon-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: RunnerIo = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch((error: unknown) => { fail(io, error) })
}

async function run(ctx: Context, config: Config, io: RunnerIo): Promise<void> {
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const service = ctx.longhorizon
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const workspace = config.workspace ?? process.cwd()
  const factsPath = join(workspace, config.factsFile ?? '.run/facts.md')
  const maxSteps = config.maxSteps ?? 100

  const sessionId = config.resumeSessionId === undefined ? SessionId(`session-${randomUUID()}`) : SessionId(config.resumeSessionId)
  const selection = defaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const resume = config.resumeSessionId !== undefined

  // Create or resume the agent; the durable snapshot is seeded or verified
  // against the live session right after, since `session.append` needs it.
  const installSelection = (agentCtx: Context): void => {
    const selected: ModelSelectionRef = { current: selection, assembled: undefined }
    installModelSelection(agentCtx, selected)
  }
  const handle: AgentHandle = resume
    ? await agents.resume({ resumeSessionId: sessionId, agentOptions, setup: installSelection })
    : await agents.create({
      sessionId,
      meta: { cwd: workspace },
      agentOptions,
      setup: installSelection,
    })
  const agent = handle.agent

  // Resume-terminal guard: fold the durable state first and report a terminal
  // run immediately — a completed/errored/stalled/budget-exhausted snapshot
  // must never execute another agent turn.
  let terminal: TaskSnapshot | undefined
  if (resume) {
    const existing = service.snapshot(agent.session)
    if (existing === undefined) throw new Error(`longhorizon-runner: no task state found for --resume ${sessionId}`)
    if (isTerminalStatus(existing.status)) {
      terminal = existing
    } else if (existing.requirements.length === 0) {
      throw new Error('longhorizon-runner: resumed snapshot declares no verifiable requirements (created by an older longhorizon); refusing to run without verification evidence')
    }
  } else {
    service.append(agent.session, 'create', {
      taskId: sessionId,
      objective: config.task,
      status: 'running',
      maxSteps,
      replanCount: 0,
      planRevisionCount: 0,
      taskRevision: 1,
      replanRequired: false,
      requirements: resolveRequirements(config),
      updatedAt: Date.now(),
    })
  }

  installTaskStateSection(agent.ctx, service, agent.session, factsPath)
  io.stdout.write(`run session: ${sessionId}\n`)
  const firstSeq = agent.session.seq

  try {
    if (terminal !== undefined) {
      // Zero additional LLM/agent execution on a terminal resume.
      await conclude(ctx, config, io, agent, terminal, firstSeq)
      return
    }

    // Drive to a verified conclusion: loop while the completion gate wants
    // more work. `done` is reachable ONLY through all-required-passing
    // evidence at the current revision; text-only endings never complete.
    let firstFollowup = true
    for (;;) {
      await agent.whenIdle()
      const snapshot = service.snapshot(agent.session)
      if (snapshot === undefined) break
      if (isTerminalStatus(snapshot.status)) break
      const lastEnd = lastTurnEnd(agent.session.events)
      if (lastEnd !== undefined && lastEnd.reason.kind === 'error') break
      refreshEvidence(agent.session, snapshot, workspace, service)
      const current = service.snapshot(agent.session) ?? snapshot
      if (allRequiredVerified(current, agent.session.events)) break
      if (budgetExhausted(derivedFor(agent.session).stepCount, snapshot.maxSteps)) break
      const prompt: UserMessage = firstFollowup
        ? createUserMessage({ content: [{ type: 'text', text: resume ? `Resume: continue from recorded state. ${config.task}` : config.task }], source: { kind: 'user' } })
        : continueMessage(unverifiedNames(current, agent.session.events).text)
      firstFollowup = false
      agent.followup(prompt)
    }

    // Derive the final status and commit it durably BEFORE the final flush,
    // so the committed snapshot always persists with the run. There is exactly
    // one status that means success: all required evidence at the current
    // revision passed.
    const snapshot = service.snapshot(agent.session)
    let finalState: TaskSnapshot | undefined
    if (snapshot !== undefined && isTerminalStatus(snapshot.status)) {
      finalState = snapshot
    } else if (snapshot !== undefined) {
      const reason = summarize(agent.session.events, firstSeq).reason
      const verified = allRequiredVerified(snapshot, agent.session.events)
      const exhausted = budgetExhausted(derivedFor(agent.session).stepCount, snapshot.maxSteps)
      const status = reason?.kind === 'error' ? 'error'
        : verified ? 'done'
          : exhausted ? 'budget-exhausted'
            : 'error'
      service.append(agent.session, 'update', { ...snapshot, status })
      finalState = { ...snapshot, status }
    }
    await conclude(ctx, config, io, agent, finalState, firstSeq)
  } finally {
    await handle.dispose()
  }
}

/**
 * Flush, report, write the trajectory, and request the process exit for one
 * final state. A final state that is not `done` reports the unverified
 * required conditions loudly, never silently.
 */
async function conclude(
  ctx: Context,
  config: Config,
  io: RunnerIo,
  agent: { readonly session: Session },
  final: TaskSnapshot | undefined,
  firstSeq: number,
): Promise<void> {
  const sessions = ctx.get('sessions')
  if (final === undefined) {
    await sessions?.flush(agent.session)
    io.exit(1)
    return
  }
  const outcome = summarize(agent.session.events, firstSeq)
  if (outcome.text !== '') io.stdout.write(`${outcome.text}\n`)
  if (outcome.reason?.kind === 'error') {
    io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
  }
  if (final.status !== 'done') {
    const unverified = unverifiedNames(final, agent.session.events)
    if (unverified.names.length > 0) {
      io.stderr.write(`dsh: run concluded ${final.status} — unverified required condition(s): ${unverified.text}\n`)
    }
  }
  if (config.trajectoryPath !== undefined) {
    writeTrajectory(config.trajectoryPath, renderTrajectory(agent.session.id, final, agent.session.events))
  }
  await sessions?.flush(agent.session)
  io.exit(finalExitCode(final.status))
}
