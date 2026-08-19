/**
 * Keyless failure-matrix tests for verified completion, resume, and durable
 * replanning, driven by a deterministic scripted runtime (no LLM, no network).
 *
 * Test A  — false completion: the LLM asserts done without an artifact.
 * Test B  — failed command verifier blocks completion.
 * Test C  — verified completion requires durable current-revision evidence.
 * Test D  — resuming a completed run performs zero additional agent work.
 * Test E  — a durable replan request survives a process-like restart.
 * Test F  — an unrelated successful tool result never clears a pending replan.
 * Test G  — only a material plan revision clears a replan (and bumps revision).
 * Test H  — revision-gap stream rejection (strict fold) — covered in fold.spec.
 * Test I  — old-revision evidence cannot complete a new revision — fold.spec.
 * Test J  — a mutated artifact produces a new hash; the old evidence is stale.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, type Session, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import LongHorizonService, {
  allRequiredVerified,
  foldEvidence,
  foldTaskState,
  latestEvidenceForRequirement,
} from '../src/index.ts'
import { verifyRequirement } from '../src/verification.ts'
import type { TaskRequirement, TaskSnapshot } from '../src/types.ts'
import * as Controller from '../src/controller.ts'
import {
  appendTextTurn,
  appendTodoWrite,
  bootHarness,
  foldedPersisted,
  readPersistedEvents,
  waitForExit,
} from './harness.ts'

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

function artifactRequirement(path: string): TaskRequirement {
  return { id: `artifact:${path}`, description: `Produce artifact ${path}`, required: true, verifier: { type: 'artifact', path } }
}

function snapshot(taskId: string, overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: taskId as never,
    objective: 'test objective',
    status: 'running',
    maxSteps: 100,
    replanCount: 0,
    planRevisionCount: 0,
    taskRevision: 1,
    replanRequired: false,
    requirements: [artifactRequirement('REPORT.md')],
    updatedAt: 0,
    ...overrides,
  }
}

/** A minimal live `tools/result` exec carrying the session and a tool name. */
function stubExec(session: Session, name: string): { agent: { session: Session; inject: () => void }; name: string } {
  return { agent: { session, inject: () => {} }, name }
}

/** Mount controller + persistence on a bare session for controller-level tests. */
async function bootController(dir: string): Promise<{ ctx: Context; service: LongHorizonService }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LongHorizonService)
  await ctx.plugin(Controller, { failureLimit: 1, replanLimit: 3, stallSteps: 100 })
  await ctx.plugin(JsonlSessionPersistence, { root: join(dir, '.sessions'), compression: 'none' })
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, service: ctx.get('longhorizon') as LongHorizonService }
}

describe('Test A — false completion', () => {
  it('the LLM asserting "Done" without an artifact can never conclude the task', async () => {
    const booted = await bootHarness({
      respond: (session: Session, _workspace: string, message: UserMessage) => {
        appendTextTurn(session, message, 'Done')
      },
    }, { task: 'Produce REPORT.md', maxSteps: 4, artifacts: ['REPORT.md'] })
    disposers.push(async () => { await booted.dispose() })
    await waitForExit(booted)
    const { stderr } = booted.getResult()
    expect(booted.exit.code).not.toBe(0)
    const view = booted.sessionId === undefined ? {} : foldedPersisted(booted, booted.sessionId)
    expect(view.snapshot?.status).not.toBe('done')
    expect(view.snapshot?.status).toBe('budget-exhausted')
    expect(stderr).toContain('unverified required condition(s)')
  })
})

describe('Test B — failed command verifier', () => {
  it('an artifact that exists is not enough when the command verifier fails', async () => {
    const booted = await bootHarness({
      respond: (session: Session, workspace: string, message: UserMessage) => {
        writeFileSync(join(workspace, 'REPORT.md'), '# report\n', 'utf8')
        appendTextTurn(session, message, 'REPORT.md written and verified')
      },
    }, {
      task: 'Produce REPORT.md and pass verification',
      maxSteps: 3,
      artifacts: ['REPORT.md'],
      artifactVerify: ['sh', '-c', 'exit 1'],
    })
    disposers.push(async () => { await booted.dispose() })
    await waitForExit(booted)
    expect(booted.exit.code).not.toBe(0)
    const sessionId = booted.sessionId
    expect(sessionId).toBeTruthy()
    const events = readPersistedEvents(join(booted.dir, '.sessions'), sessionId as string)
    // The artifact itself verified; the command requirement is failed.
    expect(latestEvidenceForRequirement(events, 'artifact:REPORT.md', 1)?.status).toBe('passed')
    expect(latestEvidenceForRequirement(events, 'command:verify', 1)?.status).toBe('failed')
    expect(latestEvidenceForRequirement(events, 'command:verify', 1)?.exitCode).not.toBe(0)
    expect(foldTaskState(events).snapshot?.status).not.toBe('done')
    expect(allRequiredVerified(foldTaskState(events).snapshot as TaskSnapshot, events)).toBe(false)
  })
})

describe('Test C — verified completion', () => {
  it('all required evidence passing concludes done with durable evidence (exit 0)', async () => {
    const booted = await bootHarness({
      respond: (session: Session, workspace: string, message: UserMessage) => {
        writeFileSync(join(workspace, 'REPORT.md'), '# done\n', 'utf8')
        appendTextTurn(session, message, 'All 12 files processed — REPORT.md written.')
      },
    }, {
      task: 'Produce REPORT.md',
      maxSteps: 5,
      artifacts: ['REPORT.md'],
      trajectoryPath: join(mkdtempSync(join(tmpdir(), 'lh-c-')), 'out.md'),
    })
    disposers.push(async () => { await booted.dispose() })
    await waitForExit(booted)
    expect(booted.exit.code).toBe(0)
    expect(booted.getResult().stderr).toBe('')
    const sessionId = booted.sessionId
    expect(sessionId).toBeTruthy()
    const events = readPersistedEvents(join(booted.dir, '.sessions'), sessionId as string)
    const view = foldTaskState(events)
    expect(view.snapshot?.status).toBe('done')
    expect(view.snapshot?.taskRevision).toBe(1)
    // Durable evidence exists for the required artifact at the current revision.
    const evidence = latestEvidenceForRequirement(events, 'artifact:REPORT.md', 1)
    expect(evidence?.status).toBe('passed')
    expect(evidence?.artifactHash).toBeTruthy()
    expect(foldEvidence(events).length).toBeGreaterThan(0)
  })
})

describe('Test D — resume a completed run', () => {
  it('a terminal resumed snapshot performs zero additional LLM/agent turns', async () => {
    const first = await bootHarness({
      respond: (session: Session, workspace: string, message: UserMessage) => {
        writeFileSync(join(workspace, 'REPORT.md'), '# done\n', 'utf8')
        appendTextTurn(session, message, 'complete')
      },
    }, { task: 'Produce REPORT.md', maxSteps: 5, artifacts: ['REPORT.md'] })
    disposers.push(async () => { await first.dispose() })
    await waitForExit(first)
    expect(first.exit.code).toBe(0)
    expect(first.sessionId).toBeTruthy()

    // Second "process" resumes the SAME persisted workspace.
    const second = await bootHarness({
      respond: () => {
        throw new Error('a resumed completed run must never execute an agent turn')
      },
    }, {
      task: 'Produce REPORT.md',
      maxSteps: 5,
      artifacts: ['REPORT.md'],
      workspace: first.dir,
      resumeSessionId: first.sessionId,
    })
    disposers.push(async () => { await second.dispose() })
    await waitForExit(second)
    expect(second.followups.count).toBe(0)
    expect(second.exit.code).toBe(0)
    const view = foldedPersisted(second, first.sessionId as string)
    expect(view.snapshot?.status).toBe('done')
  })
})

describe('Test E — replan survives restart', () => {
  it('a durable replan-required flag is restored from persistence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-e-'))
    try {
      // Boot 1: failures exceed the limit -> durable replan request.
      const { ctx, service } = await bootController(dir)
      const session = ctx.sessions.create(SessionId('session-e'), { meta: { cwd: dir } })
      service.append(session, 'create', snapshot('session-e'))
      for (let i = 0; i < 3; i++) {
        ctx.emit('tools/result', stubExec(session, 'bash'), {
          isError: true,
          content: [{ type: 'text', text: `boom ${i}` }],
          error: { message: `boom ${i}`, info: { name: 'Error', code: 'E_FAIL' } },
        })
      }
      expect(service.snapshot(session)?.replanRequired).toBe(true)
      expect(service.snapshot(session)?.replanCount).toBe(1)
      await ctx.sessions.flush(session)
      await ctx.fiber.dispose()

      // Boot 2: a brand-new context folds the persisted stream.
      const ctx2 = new Context()
      await ctx2.plugin(SessionStore)
      await ctx2.plugin(LongHorizonService)
      await ctx2.plugin(JsonlSessionPersistence, { root: join(dir, '.sessions'), compression: 'none' })
      const service2 = ctx2.get('longhorizon') as LongHorizonService
      const inspection = await (ctx2.get('sessionPersistence') as { load(id: SessionId): Promise<{ events: SessionEvent[] }> }).load(SessionId('session-e'))
      const restored = ctx2.sessions.create(SessionId('session-e'), { seed: [...inspection.events], meta: { cwd: dir } })
      expect(service2.snapshot(restored)?.replanRequired).toBe(true)
      await ctx2.fiber.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Test F — unrelated tool success', () => {
  it('never clears a pending replan request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-f-'))
    try {
      const { ctx, service } = await bootController(dir)
      const session = ctx.sessions.create(SessionId('session-f'), { meta: { cwd: dir } })
      appendTodoWrite(session, [{ content: 'plan A1', status: 'pending' }, { content: 'plan A2', status: 'pending' }])
      service.append(session, 'create', snapshot('session-f'))
      service.append(session, 'update', { ...snapshot('session-f'), replanRequired: true, replanCount: 1 })
      const before = service.snapshot(session)
      expect(before?.replanRequired).toBe(true)

      ctx.emit('tools/result', stubExec(session, 'read'), {
        isError: false,
        content: [{ type: 'text', text: 'unrelated success' }],
      })

      const after = service.snapshot(session)
      expect(after?.replanRequired).toBe(true)
      expect(after?.planRevisionCount).toBe(0)
      expect(after?.replanCount).toBe(1)
      await ctx.sessions.flush(session)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Test G — plan revision', () => {
  it('a same-content plan rewrite keeps the replan; a material revision clears it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-g-'))
    try {
      const { ctx, service } = await bootController(dir)
      const session = ctx.sessions.create(SessionId('session-g'), { meta: { cwd: dir } })
      const planA = [{ content: 'step A1', status: 'pending' }, { content: 'step A2', status: 'pending' }]
      appendTodoWrite(session, planA)
      service.append(session, 'create', snapshot('session-g'))
      service.append(session, 'update', { ...snapshot('session-g'), replanRequired: true, replanCount: 1 })

      // Status-only rewrite of the SAME plan content -> replan stays.
      appendTodoWrite(session, [{ content: 'step A1', status: 'completed' }, { content: 'step A2', status: 'pending' }])
      ctx.emit('tools/result', stubExec(session, 'todo_write'), { isError: false, content: [{ type: 'text', text: 'ok' }] })
      let afterSame = service.snapshot(session)
      expect(afterSame?.replanRequired).toBe(true)
      expect(afterSame?.planRevisionCount).toBe(0)

      // Materially different plan -> replan cleared, counts increment, revision bumps.
      appendTodoWrite(session, [{ content: 'step B1', status: 'pending' }])
      ctx.emit('tools/result', stubExec(session, 'todo_write'), { isError: false, content: [{ type: 'text', text: 'ok' }] })
      afterSame = service.snapshot(session)
      expect(afterSame?.replanRequired).toBe(false)
      expect(afterSame?.planRevisionCount).toBe(1)
      expect(afterSame?.taskRevision).toBe(2)
      expect(afterSame?.replanCount).toBe(1)
      await ctx.sessions.flush(session)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('Test J — artifact hash', () => {
  it('a mutated artifact yields a new content hash; old evidence is stale in the stream', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-j-'))
    try {
      const path = 'x.txt'
      writeFileSync(join(dir, path), 'version one', 'utf8')
      const r1 = verifyRequirement({ type: 'artifact', path }, dir)
      expect(r1.status).toBe('passed')
      const hash1 = r1.artifactHash
      expect(hash1).toBeTruthy()

      // Content changes; a fresh check detects the new identity.
      writeFileSync(join(dir, path), 'version two', 'utf8')
      const r2 = verifyRequirement({ type: 'artifact', path }, dir)
      expect(r2.status).toBe('passed')
      expect(r2.artifactHash).not.toBe(hash1)

      // Two evidence events make the mismatch observable by replay.
      const { ctx, service } = await bootController(dir)
      const session = ctx.sessions.create(SessionId('session-j'), { meta: { cwd: dir } })
      service.append(session, 'create', { ...snapshot('session-j'), requirements: [{ id: `artifact:${path}`, description: `Produce artifact ${path}`, required: true, verifier: { type: 'artifact', path } }] })
      service.appendEvidence(session, {
        requirementId: `artifact:${path}`,
        taskRevision: 1,
        status: 'passed',
        verifierType: 'artifact',
        artifactPath: path,
        artifactHash: hash1,
        checkedAt: '2026-01-01T00:00:00.000Z',
      })
      service.appendEvidence(session, {
        requirementId: `artifact:${path}`,
        taskRevision: 1,
        status: 'passed',
        verifierType: 'artifact',
        artifactPath: path,
        artifactHash: r2.artifactHash,
        checkedAt: '2026-01-02T00:00:00.000Z',
      })
      const folded = foldEvidence(session.events)
      expect(folded.map(e => e.artifactHash)).toEqual([hash1, r2.artifactHash])
      // The latest evidence reflects the current content, not the stale hash.
      expect(latestEvidenceForRequirement(session.events, `artifact:${path}`, 1)?.artifactHash).toBe(r2.artifactHash)
      await ctx.sessions.flush(session)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
