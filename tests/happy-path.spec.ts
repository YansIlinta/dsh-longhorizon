/**
 * Keyless real-composition happy-path integration test: mount the product
 * stack (state service, controller, runner, real SessionStore + AgentRegistry
 * + SystemPrompt) and drive it with a SCRIPTED agent factory (no LLM, no
 * network, no sandbox). While the boot smoke pins the clean failure path, this
 * pins the FULL closure: create → Task State section → completion gate
 * (artifact found) → durable finalize → exit 0 → trajectory with a real step
 * count.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type AgentHandle, type CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LongHorizonService, { foldTaskState } from '../src/index.ts'
import * as Controller from '../src/controller.ts'
import * as Runner from '../src/runner.ts'
const { internals } = Runner

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
  internals.stdout = process.stdout
  internals.stderr = process.stderr
})

interface Script {
  /** Extra setup before the run starts (e.g. append pre-existing durable state). */
  before?(session: Session, workspace: string): void
  /** Simulate the model's reply to the runner's follow-up prompt. */
  afterPrompt(session: Session, workspace: string, message: UserMessage): Promise<void> | void
}

/** Append one self-contained model turn that ends in plain text (no tool call). */
function appendTextTurn(session: Session, turn: number, message: UserMessage, text: string): void {
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

/** Read the persisted JSONL session back into events. */
function readPersistedEvents(root: string, sessionId: string): SessionEvent[] {
  const candidates: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === 'session.jsonl' && path.includes(sessionId)) candidates.push(path)
    }
  }
  walk(root)
  expect(candidates.length).toBe(1)
  return readFileSync(candidates[0]!, 'utf8')
    .split('\n')
    .filter(line => line !== '')
    .map(line => JSON.parse(line) as SessionEvent)
}

/** Mount the longhorizon product stack behind a scripted agent factory. */
async function boot(script: Script): Promise<{
  ctx: Context
  dir: string
  /** The exit code the runner requested, once the run concludes. */
  exit: { code?: number }
  getResult(): { stdout: string; stderr: string }
}> {
  const dir = mkdtempSync(join(tmpdir(), 'longhorizon-happy-'))
  const ctx = new Context()
  const exit = {}
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
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, '.sessions'), compression: 'none' })
  await ctx.plugin(SessionCheckpointPolicy)

  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      const agent = { session } as unknown as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        send: () => {},
        followup: (message: UserMessage) => {
          idle = Promise.resolve().then(async () => { await script.afterPrompt(session, dir, message) })
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      script.before?.(session, dir)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('resume not used in happy-path test')),
  })
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, dir, exit, getResult: () => ({ stdout, stderr }) }
}

describe('longhorizon product happy path (scripted model)', () => {
  it('creates durable state, satisfies the completion gate, finalizes done, persists, and writes a real trajectory', { timeout: 30_000 }, async () => {
    const booted = await boot({
      afterPrompt: (session, workspace, message) => {
        // Simulate the model writing the declared artifact plus a plan, then
        // ending the turn in plain text (the completion gate accepts it).
        writeFileSync(join(workspace, 'REPORT.md'), '# done\n', 'utf8')
        session.append('todo/write', { todos: [
          { content: 'repair pipeline', status: 'completed' },
        ] })
        appendTextTurn(session, 1, message, 'All 12 files processed — REPORT.md written.')
      },
    })

    const { ctx, dir, exit } = booted
    await ctx.plugin(Runner, {
      task: 'Repair the pipeline',
      workspace: dir,
      maxSteps: 10,
      artifacts: ['REPORT.md'],
      trajectoryPath: join(dir, 'out.md'),
    })

    const deadline = Date.now() + 20_000
    while (exit.code === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const { stdout, stderr } = booted.getResult()
    expect(exit.code, `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`).toBe(0)
    expect(stdout).toContain('run session: session-')
    expect(stdout).toContain('All 12 files processed — REPORT.md written.')
    expect(stderr).toBe('')

    const sessionId = /run session: (session-[^\s]+)/.exec(stdout)?.[1]
    expect(sessionId).toBeTruthy()

    // Durable state: create + finalize update, status done.
    const view = foldTaskState(readPersistedEvents(join(dir, '.sessions'), sessionId as string))
    expect(view.snapshot?.status).toBe('done')
    expect(view.ref?.revision).toBe(2)

    // Trajectory is written with a real (non-undefined) step count.
    const md = readFileSync(join(dir, 'out.md'), 'utf8')
    expect(md).toContain('Status: done')
    expect(md).toContain('steps: ')
    expect(md).not.toContain('undefined')
    expect(md).toContain('## Final task state')

    rmSync(dir, { recursive: true, force: true })
  })

  it('never treats repeated text-only completion claims as success while an artifact is missing', { timeout: 30_000 }, async () => {
    let turn = 0
    const booted = await boot({
      afterPrompt: (session, _workspace, message) => {
        turn += 1
        appendTextTurn(session, turn, message, 'Done')
      },
    })

    const { ctx, dir, exit } = booted
    await ctx.plugin(Runner, {
      task: 'Produce REPORT.md',
      workspace: dir,
      maxSteps: 3,
      artifacts: ['REPORT.md'],
    })

    const deadline = Date.now() + 20_000
    while (exit.code === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    const { stdout, stderr } = booted.getResult()
    expect(exit.code, `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`).toBe(2)
    expect(stderr).toContain('completion gate — unconfirmed artifacts')

    const sessionId = /run session: (session-[^\s]+)/.exec(stdout)?.[1]
    expect(sessionId).toBeTruthy()
    const view = foldTaskState(readPersistedEvents(join(dir, '.sessions'), sessionId as string))
    expect(view.snapshot?.status).toBe('budget-exhausted')
    expect(view.snapshot?.status).not.toBe('done')
    expect(view.ref?.revision).toBe(2)

    rmSync(dir, { recursive: true, force: true })
  })
})
