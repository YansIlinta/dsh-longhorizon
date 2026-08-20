/**
 * Long-horizon runner plugin: the one-shot driver that creates or resumes a
 * run, seeds its durable snapshot, installs the Task State section, drives it
 * through the completion gate, and exits with the run's status code. Mounted
 * as the `@deepseek-ai/dsh-longhorizon/runner` row.
 * @module @deepseek-ai/dsh-longhorizon/runner
 */

import { spawnSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import {
  continueMessage,
  derivedFor,
  installTaskStateSection,
  lastTurnEnd,
  renderTrajectory,
  turnEndedWithText,
  writeTrajectory,
} from './index.ts'

/** Stable Cordis plugin name. */
export const name = 'longhorizon-runner'

/** Services required before the one-shot run can start. */
export const inject = ['agentDefaultModel', 'agents', 'longhorizon', 'sessions', 'systemPrompt']

/** Host-side verification commands must not be able to hang the run forever. */
const ARTIFACT_VERIFY_TIMEOUT_MS = 30_000

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
  /** Declared final artifacts verified before the run is allowed to conclude. */
  artifacts?: string[]
  /** Optional host-side verification command: when set, an artifact is only confirmed when it exits 0. */
  artifactVerify?: string[]
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

/** Run the host-side artifact verification command; true only on a bounded exit 0. */
function verifyArtifacts(argv: readonly string[], workspace: string): boolean {
  const command = argv[0]
  if (command === undefined) return false
  const result = spawnSync(command, argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    timeout: ARTIFACT_VERIFY_TIMEOUT_MS,
  })
  return result.status === 0
}

/** A declared artifact is confirmed only when it is a non-empty regular file. */
function artifactConfirmed(artifact: string, workspace: string): boolean {
  try {
    const stat = statSync(join(workspace, artifact))
    return stat.isFile() && stat.size > 0
  } catch {
    return false
  }
}

/**
 * The artifacts the run cannot yet confirm: absent/empty/non-file paths, or —
 * when `artifactVerify` is configured — files that fail the bounded host check.
 */
function missingArtifacts(artifacts: readonly string[], workspace: string, verify: readonly string[] | undefined): string[] {
  if (artifacts.length === 0) return []
  const missingFiles = artifacts.filter(artifact => !artifactConfirmed(artifact, workspace))
  if (missingFiles.length > 0) return missingFiles
  if (verify === undefined || verify.length === 0) return []
  return verifyArtifacts(verify, workspace) ? [] : [...artifacts]
}

/**
 * Mount the demo runner: seed state, install the section, then drive the run.
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
  const artifacts = config.artifacts ?? ['REPORT.md']
  const artifactVerify = config.artifactVerify

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

  if (resume) {
    const existing = service.snapshot(agent.session)
    if (existing === undefined) throw new Error(`longhorizon-runner: no task state found for --resume ${sessionId}`)
  } else {
    service.append(agent.session, 'create', { taskId: sessionId, objective: config.task, status: 'running', maxSteps, replanCount: 0, updatedAt: Date.now() })
  }
  installTaskStateSection(agent.ctx, service, agent.session, factsPath)
  io.stdout.write(`run session: ${sessionId}\n`)

  try {
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: resume ? `Resume: continue from recorded state. ${config.task}` : config.task }],
      source: { kind: 'user' },
    }))

    // Drive to a verifiable conclusion: plain-text claims of completion do not
    // satisfy the gate. If artifacts remain unconfirmed, keep driving until
    // verification succeeds, the run errors/stalls, or the step budget is hit.
    for (;;) {
      await agent.whenIdle()
      const snapshot = service.snapshot(agent.session)
      if (snapshot === undefined) break
      if (snapshot.status !== 'running') break
      const lastEnd = lastTurnEnd(agent.session.events)
      if (lastEnd !== undefined && lastEnd.reason.kind === 'error') break
      const missing = missingArtifacts(artifacts, workspace, artifactVerify)
      const stepCount = derivedFor(agent.session).stepCount
      if (missing.length === 0 || stepCount >= snapshot.maxSteps) break
      if (lastEnd === undefined || !turnEndedWithText(agent.session.events, lastEnd.turn)) break
      io.stderr.write('dsh: completion gate — unconfirmed artifacts, continuing\n')
      agent.followup(continueMessage(missing))
    }

    // Derive the final status and commit it durably BEFORE the final flush,
    // so the committed snapshot always persists with the run. `done` is only
    // reachable when the declared artifact verification gate passes.
    const snapshot = service.snapshot(agent.session)
    let final: typeof snapshot
    if (snapshot !== undefined && snapshot.status === 'running') {
      const reason = summarize(agent.session.events, firstSeq).reason
      const missing = missingArtifacts(artifacts, workspace, artifactVerify)
      const status = reason?.kind === 'error' ? 'error'
        : missing.length === 0 ? 'done'
          : derivedFor(agent.session).stepCount >= snapshot.maxSteps ? 'budget-exhausted'
            : 'error'
      service.append(agent.session, 'update', { ...snapshot, status })
      final = { ...snapshot, status }
    } else {
      final = snapshot
    }
    await sessions.flush(agent.session)

    const outcome = summarize(agent.session.events, firstSeq)
    io.stdout.write(outcome.text + '\n')
    if (outcome.reason?.kind === 'error') {
      io.stderr.write(`dsh: ${outcome.reason.error.code}: ${outcome.reason.error.message}\n`)
    }
    if (final !== undefined && final.status === 'done') {
      const missing = missingArtifacts(artifacts, workspace, artifactVerify)
      if (missing.length > 0) io.stderr.write(`dsh: run concluded without confirmed artifacts: ${missing.join(', ')}\n`)
    }

    if (config.trajectoryPath !== undefined && final !== undefined) {
      writeTrajectory(config.trajectoryPath, renderTrajectory(sessionId, final, agent.session.events))
    }

    const code = final === undefined ? 1
      : final.status === 'done' ? 0
        : final.status === 'budget-exhausted' ? 2
          : final.status === 'stalled' ? 3
            : 1
    io.exit(code)
  } finally {
    await handle.dispose()
  }
}
