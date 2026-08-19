/** Package-owned durable longhorizon-stream invariants. @module @deepseek-ai/dsh-longhorizon/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { applyTaskStateChange, decodeTaskStateChange, emptyTaskStateView } from './fold.ts'
import type { TaskStateView } from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-longhorizon'

/** Cordis companion plugin name. */
export const name = 'longhorizon-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Copy the independent fold before validating one candidate event. */
function cloneState(state: TaskStateView): TaskStateView {
  return {
    ...(state.snapshot === undefined ? {} : { snapshot: state.snapshot }),
    ...(state.ref === undefined ? {} : { ref: state.ref }),
    ...(state.createdAt === undefined ? {} : { createdAt: state.createdAt }),
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
  }
}

/**
 * Apply one event through the strict decoder and return the next fold state.
 * The fold is immutable: a `clear` tombstone returns a view WITHOUT a
 * `snapshot`, so the next fresh `create` restarts the revision lineage at 1
 * instead of being read as an update against a stale snapshot.
 * @param state - the committed fold state before this event.
 * @param event - the candidate session event.
 * @param fail - the invariant failure reporter, called (and throwing) on a violation.
 * @returns the fold state after a supported event, or `state` unchanged for unrelated types.
 */
function applyChecked(state: TaskStateView, event: SessionEvent, fail: InvariantFailure): TaskStateView {
  try {
    if (event.type === 'longhorizon/state') {
      return applyTaskStateChange(cloneState(state), decodeTaskStateChange(event))
    }
    return state
  } catch (error) {
    /* v8 ignore next -- the strict decoder throws Error instances */
    const message = error instanceof Error ? error.message : String(error)
    fail(`session event ${event.seq} violates the durable longhorizon stream: ${message}`)
  }
}

/** Install an independent incremental fold over every attached session. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const states = new WeakMap<Session, TaskStateView>()
  const staged = new WeakMap<SessionEvent, { session: Session; state: TaskStateView }>()

  const seed = (session: Session): TaskStateView => {
    let state: TaskStateView = emptyTaskStateView()
    for (const event of session.events) state = applyChecked(state, event, fail)
    states.set(session, state)
    return state
  }
  /* v8 ignore next -- session/event always follows list() or session/created seeding */
  const stateFor = (session: Session): TaskStateView => states.get(session) ?? seed(session)

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    // applyChecked clones the committed view internally, so the committed
    // state in the WeakMap is never mutated by a candidate event.
    const state = applyChecked(stateFor(session), event, fail)
    staged.set(event, { session, state })
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    /* v8 ignore next 2 -- internal/dispatch stages the exact callback arguments */
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching longhorizon-fold validation')
    }
    staged.delete(event)
    states.set(session, candidate.state)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the longhorizon-stream invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
