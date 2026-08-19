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
  /** Per-fingerprint failure totals; the fingerprint is tool + code + normalized message. */
  readonly byFingerprint: Readonly<Record<string, number>>
  /** The last failing tool result's identity and fingerprint, when one exists. */
  readonly latest?: {
    readonly tool: string
    readonly fingerprint: string
    readonly taskRevision: number
  }
  /**
   * Tool results whose effect intent was started but whose durable outcome is
   * UNKNOWN (a process crash before the result persisted; the harness marks
   * these with `TOOL_OUTCOME_UNKNOWN` at load-repair). Never counted as
   * failures: the controller must not assume them failed OR succeeded.
   */
  readonly unknownOutcomes: number
  /** The most recent outcome-unknown tool result, when one exists. */
  readonly latestUnknown?: {
    readonly tool: string
    readonly taskRevision: number
  }
}

/**
 * One verifier specification for a task requirement. An `artifact` verifier
 * proves existence and content identity of a workspace file; a `command`
 * verifier runs a host-side argv and passes on exit code 0.
 */
export type RequirementVerifier =
  | { readonly type: 'artifact'; readonly path: string }
  | { readonly type: 'command'; readonly command: readonly string[] }

/**
 * A requirement the run must satisfy to be allowed to conclude. The completion
 * invariant: a task is `done` IFF every `required` requirement has passing
 * verification evidence at the current task revision.
 */
export interface TaskRequirement {
  /** Stable identity the evidence events bind to (`<verifierType>:<subject>`). */
  readonly id: string
  /** Human description shown in the Task State section. */
  readonly description: string
  /** Whether this requirement gates task completion. */
  readonly required: boolean
  /** How the requirement is verified. */
  readonly verifier: RequirementVerifier
}

/** Outcome of one host-side verification check. */
export type EvidenceStatus = 'passed' | 'failed' | 'unknown'

/**
 * Durable verification evidence for one requirement at one task revision,
 * carried by every `longhorizon/evidence` event. Evidence is per-revision: an
 * older revision's evidence never counts for the current snapshot.
 */
export interface VerificationEvidence {
  /** The requirement this check exercised. */
  readonly requirementId: string
  /** The task revision this check verifies against. */
  readonly taskRevision: number
  /** `passed` is the only status that satisfies a required requirement. */
  readonly status: EvidenceStatus
  readonly verifierType: RequirementVerifier['type']
  /** Workspace-relative artifact path, for artifact verifiers. */
  readonly artifactPath?: string
  /** SHA-256 hex digest of the artifact content, for artifact verifiers. */
  readonly artifactHash?: string
  /** Shell-joined command text, for command verifiers. */
  readonly command?: string
  /** Process exit code, for command verifiers. */
  readonly exitCode?: number
  /** ISO timestamp of the check. */
  readonly checkedAt: string
}

/** One plan line rendered from the model's todo_write list. */
export interface TaskPlanningItem {
  /** Stable content-derived id (short SHA-256 of the text), never the position. */
  readonly id: string
  /** Positional index for display only. */
  readonly index: number
  readonly text: string
  readonly status: 'pending' | 'in-progress' | 'done' | 'failed'
}

/** One requirement and its state under the current snapshot. */
export interface RequirementVerification {
  readonly requirement: TaskRequirement
  /** Latest evidence at the current revision, absent before the first check. */
  readonly latest?: VerificationEvidence
  /** True only when the latest current-revision evidence is `passed`. */
  readonly verified: boolean
}

/**
 * The durable run state, carried by every non-clear `longhorizon/state`
 * mutation as a post-mutation snapshot. Only the run's OWN facts live here:
 * objective, status, budget, replan control state, and the requirement
 * definitions. Plan, step count, failure counters, evidence, and facts are
 * DERIVED at render from the base session log (`todo/write`, `step/start`,
 * `tool/result`, `longhorizon/evidence`, and the model's logged file
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
  /** Replan requests issued so far (durable; feeds the stall limiter). */
  readonly replanCount: number
  /** Accepted plan revisions so far (durable; incremented only on acceptance). */
  readonly planRevisionCount: number
  /**
   * Durable task revision. Bumped on material change (objective/schema,
   * accepted plan revision, requirement definition change); verification
   * evidence binds to it, so old-revision evidence never carries a new
   * revision.
   */
  readonly taskRevision: number
  /** Durable replan-request state; cleared only by an accepted plan revision. */
  readonly replanRequired: boolean
  /** The requirements this run must verify (created from runner config). */
  readonly requirements: readonly TaskRequirement[]
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
