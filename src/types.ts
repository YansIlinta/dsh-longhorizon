/**
 * Pure types of the long-horizon state domain: the ONE home of the durable
 * snapshot vocabulary, free of this package's host-side value imports (cordis
 * service, dsh-tools, dsh-agent). Two namespace projections serve it —
 * `./types` for host consumers, `./client` for client aggregates — with zero
 * content duplication.
 * @module @deepseek-ai/dsh-longhorizon/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Lifecycle status of one long-horizon run, mirrored from the runner's exit contract. */
export type TaskStatus =
  | 'running'
  | 'done'
  | 'error'
  | 'budget-exhausted'
  | 'stalled'

/** Failure counters folded from `tool/result` events carrying an error. */
export interface TaskFailureCounts {
  /** Total failing tool results across the run. */
  readonly total: number
  /** Per-tool consecutive failure runs; any success of that tool resets its slot. */
  readonly consecutiveByTool: Readonly<Record<string, number>>
  /** Per-tool total failing results. */
  readonly byTool: Readonly<Record<string, number>>
}

/**
 * The durable run state, carried by every non-clear `longhorizon/state`
 * mutation as a post-mutation snapshot. Only the run's OWN facts live here:
 * objective, status, budget, and replan count. Plan, step count, failure
 * counters, and facts are DERIVED at render from the base session log
 * (`todo/write`, `step/start`, `tool/result`, and the model's logged file
 * writes) — the log is their single source of truth, and the snapshot never
 * duplicates them.
 */
export interface TaskSnapshot {
  /** The run identity: the owning session id. */
  readonly taskId: SessionId
  /** Pinned at run start; the model never changes it. */
  readonly objective: string
  /** Lifecycle status of the run. */
  readonly status: TaskStatus
  /** Hard step budget for the run. */
  readonly maxSteps: number
  /** Loop-driven replan coercions delivered so far. */
  readonly replanCount: number
  /** Epoch milliseconds of the snapshot. */
  readonly updatedAt: number
}

/** Compare-and-set identity for one exact snapshot revision. */
export interface TaskStateRef {
  /** The owning session id. */
  readonly taskId: SessionId
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
}

/** Whole snapshot or clear tombstone carried by one durable mutation. */
export type TaskStateChange =
  | {
    readonly operation: 'create' | 'update'
    readonly snapshot: TaskSnapshot
    /** Positive mutation revision; every durable mutation increments it. */
    readonly revision: number
    readonly createdAt: number
    readonly updatedAt: number
  }
  | { readonly operation: 'clear'; readonly cleared: TaskStateRef; readonly clearedAt: number }

/** The folded view of a run's durable state stream. */
export interface TaskStateView {
  /** Current snapshot, absent before the first create or after a clear. */
  readonly snapshot?: TaskSnapshot
  /** Latest mutation ref, including a clear tombstone. */
  readonly ref?: TaskStateRef
  /** Snapshot creation time, absent without a current snapshot. */
  readonly createdAt?: number
  /** Latest mutation time, absent without a current snapshot. */
  readonly updatedAt?: number
}
