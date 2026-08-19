/**
 * Keyless service tests: the `ctx.longhorizon` service appends revisioned
 * snapshot events to a real SessionStore session, and the fold views them.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import LongHorizonService, { foldTaskState } from '../src/index.ts'
import type { TaskSnapshot } from '../src/types.ts'

const disposers: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose()
})

async function boot(): Promise<{ ctx: Context; service: LongHorizonService }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LongHorizonService)
  disposers.push(async () => { await ctx.fiber.dispose() })
  return { ctx, service: ctx.get('longhorizon') as LongHorizonService }
}

function snap(objective: string, status: TaskSnapshot['status'] = 'running'): TaskSnapshot {
  return { taskId: 'session-x' as SessionId, objective, status, maxSteps: 40, replanCount: 0, updatedAt: 0 }
}

describe('longhorizon service', () => {
  it('appends create, views it, and appends contiguous updates', async () => {
    const { ctx, service } = await boot()
    const session = ctx.sessions.create(SessionId('session-x'), { meta: { cwd: '/tmp' } })
    const created = service.append(session, 'create', snap('fix the pipeline'))
    expect(created.revision).toBe(1)
    expect(service.snapshot(session)?.objective).toBe('fix the pipeline')

    service.append(session, 'update', { ...snap('fix the pipeline'), status: 'done' })
    const view = service.view(session)
    expect(view.ref?.revision).toBe(2)
    expect(view.snapshot?.status).toBe('done')

    // The durable events replay-fold to the same view.
    expect(foldTaskState(session.events).snapshot?.status).toBe('done')
  })

  it('rejects an update without a snapshot and a create on an initialized stream', async () => {
    const { ctx, service } = await boot()
    const session = ctx.sessions.create(SessionId('session-x'), { meta: { cwd: '/tmp' } })
    expect(() => service.append(session, 'update', snap('objective'))).toThrow(/update without a current snapshot/)
    service.append(session, 'create', snap('objective'))
    expect(() => service.append(session, 'create', snap('objective'))).toThrow(/create on an already initialized stream/)
  })

  it('clears and rejects a stale clear', async () => {
    const { ctx, service } = await boot()
    const session = ctx.sessions.create(SessionId('session-x'), { meta: { cwd: '/tmp' } })
    service.append(session, 'create', snap('objective'))
    service.clear(session)
    expect(service.snapshot(session)).toBeUndefined()
    expect(service.view(session).ref?.revision).toBe(1)
    expect(() => { service.clear(session) }).toThrow(/clear without a current state/)

    // A fresh create after a clear restarts the revision lineage at 1 and the
    // stream replays cleanly.
    service.append(session, 'create', snap('fresh objective'))
    expect(service.snapshot(session)?.objective).toBe('fresh objective')
    expect(service.view(session).ref?.revision).toBe(1)
    expect(foldTaskState(session.events).snapshot?.objective).toBe('fresh objective')
  })
})
