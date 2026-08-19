/**
 * Host-side vocabulary of the long-horizon domain: durable change payloads
 * and the session-event merge. Kept separate from ./types.ts (the pure
 * client-safe outlet) because these declarations pull cordis into the
 * program.
 * @module @deepseek-ai/dsh-longhorizon
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TaskSnapshot, TaskStateRef } from './types.ts'

/** State-changing verbs recorded in the durable source change. */
export type TaskOperation = 'create' | 'update' | 'clear'

/** Full-snapshot mutation committed by a durable `longhorizon/state` event. */
export interface TaskStateSnapshotChangeMeta {
  readonly kind: 'longhorizon/state'
  readonly version: 1
  readonly operation: Exclude<TaskOperation, 'clear'>
  readonly snapshot: TaskSnapshot
  readonly revision: number
  readonly createdAt: number
  readonly updatedAt: number
}

/** Tombstone retained when the run state is cleared. */
export interface TaskStateClearChangeMeta {
  readonly kind: 'longhorizon/state'
  readonly version: 1
  readonly operation: 'clear'
  readonly cleared: TaskStateRef
  readonly clearedAt: number
}

/** Durable change union carried by the domain's own session event. */
export type TaskStateChangeMeta = TaskStateSnapshotChangeMeta | TaskStateClearChangeMeta

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Complete post-mutation task snapshot or clear tombstone for one
     * long-horizon run. The run identity is the owning session id.
     */
    'longhorizon/state': TaskStateChangeMeta
  }
}

/** A run's identity in the domain: its session id. */
export type TaskRunId = SessionId
