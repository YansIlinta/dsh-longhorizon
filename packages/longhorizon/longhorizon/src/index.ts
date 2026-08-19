/**
 * Long-horizon state domain: durable `longhorizon/state` session events, the
 * replay fold, the `ctx.longhorizon` service, and the shared per-session
 * controller runtime. The controller and runner plugins live in sibling
 * modules and are mounted as subpath rows.
 * @module @deepseek-ai/dsh-longhorizon
 */

import { existsSync, readFileSync } from 'node:fs'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  foldFailures,
  foldPlan,
  foldStepCount,
  foldTaskState,
  type TaskPlanningItem,
} from './fold.ts'
import { renderTaskStateSection } from './section.ts'
import type { TaskSnapshot, TaskStateRef, TaskStateView } from './types.ts'

/** Per-session controller runtime; nothing here is durable. */
export interface TaskRunRuntime {
  /** Whether a replan nudge is pending a plan refresh. */
  replanArmed: boolean
}

const runtimes = new WeakMap<Session, TaskRunRuntime>()

/** The per-session controller runtime, created on first access. */
export function getRuntime(session: Session): TaskRunRuntime {
  let runtime = runtimes.get(session)
  if (runtime === undefined) {
    runtime = { replanArmed: false }
    runtimes.set(session, runtime)
  }
  return runtime
}

/** Set the replan-armed flag for one session. */
export function markReplanArmed(session: Session, armed: boolean): void {
  getRuntime(session).replanArmed = armed
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    longhorizon: LongHorizonService
  }
}

/**
 * The durable long-horizon state service: fold the stream, read the current
 * snapshot, and append revisioned snapshot mutations.
 */
export class LongHorizonService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'longhorizon')
  }

  /** Fold the session's durable state stream. */
  view(session: Session): TaskStateView {
    return foldTaskState(session.events)
  }

  /** The current snapshot, absent before the first create or after a clear. */
  snapshot(session: Session): TaskSnapshot | undefined {
    return this.view(session).snapshot
  }

  /**
   * Append one revisioned snapshot mutation (create or update). The revision
   * is derived from the fold, so concurrent writers stay contiguous.
   * @param session - the owning session.
   * @param operation - create for the first mutation, update afterwards.
   * @param snapshot - the post-mutation snapshot.
   * @returns the committed revision ref.
   */
  append(session: Session, operation: 'create' | 'update', snapshot: TaskSnapshot): TaskStateRef {
    const view = this.view(session)
    if (operation === 'create' && view.snapshot !== undefined) {
      throw new Error('longhorizon: create on an already initialized stream')
    }
    if (operation === 'update' && view.snapshot === undefined) {
      throw new Error('longhorizon: update without a current snapshot')
    }
    // A clear tombstone keeps the cleared revision for stale-clear matching,
    // but the fold restarts a fresh snapshot at revision 1.
    const revision = view.snapshot === undefined || view.ref === undefined ? 1 : view.ref.revision + 1
    const createdAt = view.createdAt ?? Date.now()
    const updatedAt = Date.now()
    session.append('longhorizon/state', {
      kind: 'longhorizon/state',
      version: 1,
      operation,
      snapshot: { ...snapshot, taskId: session.id, updatedAt },
      revision,
      createdAt,
      updatedAt,
    })
    return { taskId: session.id, revision }
  }

  /** Append the clear tombstone for the current snapshot. */
  clear(session: Session): void {
    const view = this.view(session)
    if (view.snapshot === undefined || view.ref === undefined) {
      throw new Error('longhorizon: clear without a current state')
    }
    session.append('longhorizon/state', {
      kind: 'longhorizon/state',
      version: 1,
      operation: 'clear',
      cleared: view.ref,
      clearedAt: Date.now(),
    })
  }
}

/** The derived run facts folded from the base session log. */
export interface TaskRunDerived {
  readonly plan: readonly TaskPlanningItem[]
  readonly stepCount: number
  readonly failures: ReturnType<typeof foldFailures>
}

/** Fold the derived run facts for render. */
export function derivedFor(session: Session): TaskRunDerived {
  return {
    plan: foldPlan(session.events),
    stepCount: foldStepCount(session.events),
    failures: foldFailures(session.events),
  }
}

/** Read the model-maintained facts file, one line per fact, newest last. */
export function readFacts(factsPath: string): string[] {
  if (!existsSync(factsPath)) return []
  return readFileSync(factsPath, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
    .slice(-12)
}

/**
 * Install the agent-scoped "Task State" system-prompt section for one
 * long-horizon run. Registered in the agent's scoped context, so the text
 * provider closes over that run's session and folds fresh facts at every
 * prompt assembly. Contributes nothing while the session has no snapshot.
 * @param agentCtx - the agent's scoped context.
 * @param service - the durable state service.
 * @param session - the run's session.
 * @param factsPath - the workspace facts file path.
 * @returns whether the section was registered.
 */
export function installTaskStateSection(agentCtx: Context, service: LongHorizonService, session: Session, factsPath: string): boolean {
  const systemPrompt = agentCtx.get('systemPrompt')
  if (systemPrompt === undefined) return false
  systemPrompt.section({
    name: 'longhorizon:task-state',
    order: 130,
    text: () => {
      const snapshot = service.snapshot(session)
      if (snapshot === undefined) return ''
      return renderTaskStateSection(
        snapshot,
        derivedFor(session),
        readFacts(factsPath).join('\n'),
        getRuntime(session).replanArmed,
      )
    },
  })
  return true
}

export * from './fold.ts'
export * from './guards.ts'
export * from './section.ts'
export * from './trajectory.ts'
export type * from './types.ts'
export default LongHorizonService
