/**
 * Keyless real-composition boot smoke: mount the product stack in-process
 * (state service, controller, runner, real DeepSeek adapter, JSONL
 * persistence) with no API key, and assert the whole chain settles with a
 * clean credential error, a durable `error` snapshot in the persisted log,
 * and exit code 1.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SessionCheckpointPolicy from '@deepseek-ai/dsh-session-checkpoint-policy'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
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

/** Read a persisted JSONL session log back into events, locating the file under `root`. */
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

describe('longhorizon product boot smoke', () => {
  it('mounts, seeds a durable snapshot, and fails cleanly at the model-credential boundary without a key', { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'longhorizon-product-'))
    const persistenceRoot = join(dir, '.sessions')
    const ctx = new Context()
    let exitCode: number | undefined
    let stdout = ''
    let stderr = ''

    ctx.provide('appExit', (code: number) => { exitCode = code })
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
    })
    internals.stdout = { write: (chunk) => { stdout += chunk; return true } }
    internals.stderr = { write: (chunk) => { stderr += chunk; return true } }
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LongHorizonService)
    await ctx.plugin(Controller)
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    await ctx.plugin(SessionCheckpointPolicy)
    await ctx.plugin(LlmDeepSeek)
    await ctx.plugin(Runner, {
      task: 'Repair the pipeline',
      workspace: dir,
      maxSteps: 5,
      artifacts: ['REPORT.md'],
    })
    disposers.push(async () => { await ctx.fiber.dispose() })

    const deadline = Date.now() + 30_000
    while (exitCode === undefined && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    expect(exitCode, `stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`).toBe(1)
    expect(stdout).toContain('run session: session-')
    expect(stderr).toContain('dsh: ')
    const sessionId = /run session: (session-[^\s]+)/.exec(stdout)?.[1]
    expect(sessionId).toBeTruthy()
    // The persisted log replays to the committed final snapshot.
    const view = foldTaskState(readPersistedEvents(persistenceRoot, sessionId as string))
    expect(view.snapshot?.objective).toBe('Repair the pipeline')
    expect(view.snapshot?.maxSteps).toBe(5)
    expect(view.snapshot?.status).toBe('error')
    expect(view.ref?.revision).toBe(2) // create + finalize update
    rmSync(dir, { recursive: true, force: true })
  })
})
