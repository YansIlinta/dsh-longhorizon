/**
 * Deterministic scripted-runtime harness for the longhorizon runner/controller
 * tests: mounts the product stack (state service, controller, runner, real
 * SessionStore + persistence + SystemPrompt) behind a scripted agent factory —
 * no LLM, no network, no sandbox. The script answers every runner follow-up
 * with durable session events (text turns, tools with success/failure, todo
 * writes, artifact writes), counts follow-ups, and supports a second boot that
 * RESUMES a persisted session through the real persistence coordinator load
 * path (so evidence events prove durable across a process-like restart).
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LongHorizonService, { foldTaskState } from '../src/index.ts'
import * as Controller from '../src/controller.ts'
import * as Runner from '../src/runner.ts'

const { internals } = Runner

/** One scripted model turn in answer to a runner follow-up. */
export interface Responder {
  (
    session: Session,
    workspace: string,
    message: UserMessage,
    ctx: Context,
    followupIndex: number,
  ): void | Promise<void>
}

/** Extra setup before the run drives (e.g. pre-seed durable state or files). */
export interface HarnessScript {
  respond: Responder
  before?(session: Session, workspace: string): void
  /** After the exit requested; last chance to read the persisted log live. */
  afterExit?(session: Session, workspace: string): void
}

/** Runner config surface the harness forwards. */
export interface HarnessOptions {
  task: string
  maxSteps?: number
  artifacts?: string[]
  artifactVerify?: string[]
  trajectoryPath?: string
  workspace?: string
  resumeSessionId?: string
  requirements?: unknown[]
}

/** One booted stack; the test owns disposal. */
export interface Booted {
  ctx: Context
  dir: string
  /** The requested process exit, set once the run concludes. */
  exit: { code?: number }
  /** Sequential follow-up count, for zero-agent-execution assertions. */
  followups: { count: number }
  /** The run's session id, captured from the runner's banner. */
  sessionId: string | undefined
  getResult(): { stdout: string; stderr: string }
  dispose(): Promise<void>
}

/** Append one completed model turn ending in plain text. */
export function appendTextTurn(
  session: Session,
  message: UserMessage,
  text: string,
  work?: () => void,
): void {
  work?.()
  const turn = session.events.filter(event => event.type === 'turn/start').length + 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text }],
      source: { provider: 'test-provider', model: 'test-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append one durable tool call + result (success or failure) inside a live turn. */
export function appendToolResult(
  session: Session,
  message: UserMessage,
  toolName: string,
  callId: string,
  isError: boolean,
  resultText: string,
  code = 'E_FAIL',
): void {
  const turn = session.events.filter(event => event.type === 'turn/start').length + 1
  const step = session.events.filter(event => event.type === 'step/start').length + 1
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step })
  session.append('user/message', message, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step, callId: callId as never, name: toolName, arguments: '{}' })
  session.append('tool/result', {
    turn,
    step,
    message: {
      source: { kind: 'tool', callId: callId as never },
      content: [{ type: 'text', text: resultText }],
    },
    ...(isError ? { error: { name: 'Error', code } } : {}),
  } as never, { surfaceOp: 'append' })
  session.append('step/end', { turn, step })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

/** Append one whole-list todo_write event (optionally closing a text turn). */
export function appendTodoWrite(
  session: Session,
  todos: { content: string; status: 'pending' | 'in_progress' | 'completed' }[],
): void {
  session.append('todo/write', { todos })
}

/** Read the persisted JSONL log back into events, locating the file under `root`. */
export function readPersistedEvents(root: string, sessionId: string): SessionEvent[] {
  const candidates: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' && path.includes(sessionId)) candidates.push(path)
    }
  }
  walk(root)
  if (candidates.length !== 1) throw new Error(`expected one persisted log for ${sessionId}, found ${candidates.length}`)
  return readFileSync(candidates[0]!, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as SessionEvent)
}

/** Build one scripted agent handle over a session. */
function makeAgent(
  ctx: Context,
  ownerCtx: Context,
  session: Session,
  agentOptions: unknown,
  followups: { count: number },
  script: HarnessScript,
  workspace: string,
): Agent {
  let idle = Promise.resolve()
  const agent = { session } as unknown as Agent
  const agentCtx = ownerCtx.extend({ agent })
  Object.assign(agent, {
    id: session.id,
    options: agentOptions,
    session,
    status: 'idle',
    ctx: agentCtx,
    cancel: () => {},
    send: () => {},
    followup: (message: UserMessage) => {
      followups.count += 1
      idle = Promise.resolve().then(async () => { await script.respond(session, workspace, message, ctx, followups.count) })
    },
    steer: () => {},
    inject: () => {},
    whenIdle: () => idle,
  } satisfies Partial<Agent>)
  return agent
}

/**
 * Boot the longhorizon product stack behind a scripted agent factory.
 * @param script - the scripted model behavior.
 * @param options - runner config.
 * @returns the booted stack.
 */
export async function bootHarness(script: HarnessScript, options: HarnessOptions): Promise<Booted> {
  const dir = options.workspace ?? mkdtempSync(join(tmpdir(), 'longhorizon-harness-'))
  const persistenceRoot = join(dir, '.sessions')
  const ctx = new Context()
  const exit: { code?: number } = {}
  const followups = { count: 0 }
  let stdout = ''
  let stderr = ''
  ctx.provide('appExit', (code: number) => { exit.code = code })
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) })
  internals.stdout = { write: (chunk) => { stdout += chunk; return true } }
  internals.stderr = { write: (chunk) => { stderr += chunk; return true } }

  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LongHorizonService)
  await ctx.plugin(Controller)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  await ctx.plugin(SessionCheckpointPolicy)

  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, createOptions: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(createOptions.sessionId, {
        ...createOptions.meta === undefined ? {} : { meta: createOptions.meta },
      })
      const agent = makeAgent(ctx, ownerCtx, session, createOptions.agentOptions, followups, script, dir)
      await createOptions.setup?.(agent.ctx)
      script.before?.(session, dir)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    async resume(ownerCtx: Context, resumeOptions: ResumeAgentOptions): Promise<AgentHandle> {
      // Real coordinator load: proves evidence events survive the KNOWN-type gate.
      const persistence = ctx.get('sessionPersistence') as { load(id: SessionId): Promise<{ events: SessionEvent[] }> }
      if (persistence === undefined) throw new Error('sessionPersistence missing for resume test')
      const inspection = await persistence.load(resumeOptions.resumeSessionId)
      const session = ctx.sessions.create(resumeOptions.resumeSessionId, {
        seed: [...inspection.events],
        meta: { cwd: dir },
      })
      const agent = makeAgent(ctx, ownerCtx, session, resumeOptions.agentOptions, followups, script, dir)
      await resumeOptions.setup?.(agent.ctx)
      script.before?.(session, dir)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
  })

  await ctx.plugin(Runner, {
    task: options.task,
    workspace: dir,
    maxSteps: options.maxSteps,
    artifacts: options.artifacts,
    artifactVerify: options.artifactVerify,
    requirements: options.requirements,
    trajectoryPath: options.trajectoryPath,
    resumeSessionId: options.resumeSessionId,
  } as Runner.Config)

  const sessionId = options.resumeSessionId
  const booted: Booted = {
    ctx,
    dir,
    exit,
    followups,
    sessionId,
    getResult: () => ({ stdout, stderr }),
    dispose: async () => { await ctx.fiber.dispose(); internals.stdout = process.stdout; internals.stderr = process.stderr },
  }
  // Capture the fresh-run session id once the runner banner lands.
  if (sessionId === undefined) {
    const deadline = Date.now() + 2_000
    while (booted.sessionId === undefined && Date.now() < deadline) {
      const match = /run session: (session-[^\s]+)/.exec(stdout)
      if (match) { booted.sessionId = match[1]; break }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
  }
  return booted
}

/** Wait for the runner to request its process exit (bounded). */
export async function waitForExit(booted: Booted, timeoutMs = 15_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (booted.exit.code === undefined && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  return booted.exit.code === undefined ? undefined : String(booted.exit.code)
}

/** Fold the persisted session state after a boot that wrote to `dir/.sessions`. */
export function foldedPersisted(booted: Booted, sessionId: string): ReturnType<typeof foldTaskState> {
  return foldTaskState(readPersistedEvents(join(booted.dir, '.sessions'), sessionId))
}
