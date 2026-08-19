/**
 * Pure replay fold of the durable `longhorizon/state` and `longhorizon/evidence`
 * streams: revision continuity, create/update/clear semantics, deterministic
 * plan-revision detection, step-level no-progress measurement, and fail-loud
 * decoding of malformed changes. The fold is the single query surface for the
 * service, the invariant companion, and replay consumers.
 * @module @deepseek-ai/dsh-longhorizon/fold
 */

import { createHash } from 'node:crypto'
import { TOOL_OUTCOME_UNKNOWN, type SessionEvent } from '@deepseek-ai/dsh-session'
import './domain.ts'
import type {
  EvidenceStatus,
  RequirementVerification,
  RequirementVerifier,
  TaskPlanningItem,
  TaskRequirement,
  TaskSnapshot,
  TaskStateChange,
  TaskStateView,
  VerificationEvidence,
} from './types.ts'

export type { TaskPlanningItem } from './types.ts'

/** The text of a content block, or undefined when the block is not text. */
export function blockText(block: { readonly type?: string; readonly text?: unknown }): string | undefined {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : undefined
}

/** Narrow a durable payload to a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read a required string field. */
function reqString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field === '') throw new Error(`longhorizon: invalid string field "${key}"`)
  return field
}

/** Read a required finite number field. */
function reqNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (typeof field !== 'number' || !Number.isFinite(field)) throw new Error(`longhorizon: invalid number field "${key}"`)
  return field
}

/** Read a required positive integer field. */
function reqRevision(value: Record<string, unknown>, key: string): number {
  const field = reqNumber(value, key)
  if (!Number.isInteger(field) || field <= 0) throw new Error(`longhorizon: invalid revision field "${key}"`)
  return field
}

/** Decode one verifier specification through runtime validation. */
function decodeVerifier(value: unknown): RequirementVerifier {
  if (!isRecord(value)) throw new Error('longhorizon: verifier is not a record')
  switch (value['type']) {
    case 'artifact':
      return { type: 'artifact', path: reqString(value, 'path') }
    case 'command': {
      const command = value['command']
      if (!Array.isArray(command) || command.length === 0 || !command.every(part => typeof part === 'string')) {
        throw new Error('longhorizon: invalid command verifier argv')
      }
      return { type: 'command', command: [...command] }
    }
    default:
      throw new Error(`longhorizon: invalid verifier type ${String(value['type'])}`)
  }
}

/** Decode one requirement record through runtime validation. */
function decodeRequirement(value: unknown): TaskRequirement {
  if (!isRecord(value)) throw new Error('longhorizon: requirement is not a record')
  const required = value['required']
  if (typeof required !== 'boolean') throw new Error('longhorizon: requirement "required" must be a boolean')
  return {
    id: reqString(value, 'id'),
    description: reqString(value, 'description'),
    required,
    verifier: decodeVerifier(value['verifier']),
  }
}

/**
 * Decode a durable snapshot payload through runtime validation (the
 * durable-log boundary): kinds, versions, required fields, and the closed
 * status vocabulary are checked, never trusted from a type assertion. Fields
 * added after the v1 format shipped decode with deterministic defaults —
 * `taskRevision` 1, `replanRequired` false, `requirements` empty — so an older
 * snapshot replays without silent reinterpretation (an empty requirement list
 * is later refused as non-completable by the completion gate).
 * @param value - the raw event payload.
 * @returns the validated snapshot.
 */
function decodeTaskSnapshot(value: unknown): TaskSnapshot {
  if (!isRecord(value)) throw new Error('longhorizon: snapshot payload is not a record')
  const status = value['status']
  const statuses = ['running', 'done', 'error', 'budget-exhausted', 'stalled']
  if (typeof status !== 'string' || !statuses.includes(status)) {
    throw new Error(`longhorizon: invalid status ${String(status)}`)
  }
  const revisionField = value['taskRevision']
  if (revisionField !== undefined && (typeof revisionField !== 'number' || !Number.isInteger(revisionField) || revisionField <= 0)) {
    throw new Error(`longhorizon: invalid taskRevision ${JSON.stringify(revisionField)}`)
  }
  const replanRequired = value['replanRequired']
  if (replanRequired !== undefined && typeof replanRequired !== 'boolean') {
    throw new Error('longhorizon: replanRequired must be a boolean')
  }
  const planRevisionCount = value['planRevisionCount']
  if (planRevisionCount !== undefined && (typeof planRevisionCount !== 'number' || !Number.isInteger(planRevisionCount) || planRevisionCount < 0)) {
    throw new Error(`longhorizon: invalid planRevisionCount ${JSON.stringify(planRevisionCount)}`)
  }
  const requirements = value['requirements']
  if (requirements !== undefined && !Array.isArray(requirements)) throw new Error('longhorizon: requirements must be an array')
  return {
    taskId: reqString(value, 'taskId') as TaskSnapshot['taskId'],
    objective: reqString(value, 'objective'),
    status: status as TaskSnapshot['status'],
    maxSteps: reqNumber(value, 'maxSteps'),
    replanCount: reqNumber(value, 'replanCount'),
    planRevisionCount: planRevisionCount === undefined ? 0 : planRevisionCount,
    taskRevision: revisionField === undefined ? 1 : revisionField,
    replanRequired: replanRequired === undefined ? false : replanRequired,
    requirements: Array.isArray(requirements) ? requirements.map(decodeRequirement) : [],
    updatedAt: reqNumber(value, 'updatedAt'),
  }
}

/** The fold state before any durable mutation. */
export function emptyTaskStateView(): TaskStateView {
  return {}
}

/** Decode one durable change event into the domain vocabulary. */
export function decodeTaskStateChange(event: SessionEvent<'longhorizon/state'>): TaskStateChange {
  const value: unknown = event.data
  if (!isRecord(value) || value['kind'] !== 'longhorizon/state') {
    throw new Error('longhorizon: expected a longhorizon/state event')
  }
  if (value['version'] !== 1) {
    throw new Error(`longhorizon: unsupported state event version ${String(value['version'])}`)
  }
  if (value['operation'] === 'clear') {
    const cleared = value['cleared']
    if (!isRecord(cleared)) throw new Error('longhorizon: clear payload missing cleared ref')
    return {
      operation: 'clear',
      cleared: { taskId: reqString(cleared, 'taskId') as TaskSnapshot['taskId'], revision: reqNumber(cleared, 'revision') },
      clearedAt: reqNumber(value, 'clearedAt'),
    }
  }
  if (value['operation'] !== 'create' && value['operation'] !== 'update') {
    throw new Error(`longhorizon: invalid operation ${String(value['operation'])}`)
  }
  return {
    operation: value['operation'],
    snapshot: decodeTaskSnapshot(value['snapshot']),
    revision: reqNumber(value, 'revision'),
    createdAt: reqNumber(value, 'createdAt'),
    updatedAt: reqNumber(value, 'updatedAt'),
  }
}

/**
 * Apply one decoded change through the strict fold. Rejects revision gaps,
 * stale revisions, duplicate clears, and mutations on a cleared stream
 * (except a fresh create at revision 1).
 * @param view - the fold state before this event.
 * @param change - the decoded durable change.
 * @returns the fold state after the event.
 */
export function applyTaskStateChange(view: TaskStateView, change: TaskStateChange): TaskStateView {
  if (change.operation === 'clear') {
    if (view.ref === undefined) throw new Error('longhorizon: clear without a current state')
    if (change.cleared.taskId !== view.ref.taskId || change.cleared.revision !== view.ref.revision) {
      throw new Error('longhorizon: clear revision mismatch')
    }
    return { ref: change.cleared }
  }
  const { snapshot, revision, createdAt, updatedAt } = change
  if (view.snapshot !== undefined) {
    if (snapshot.taskId !== view.snapshot.taskId) {
      throw new Error('longhorizon: snapshot task id changed mid-stream')
    }
    if (view.ref === undefined || revision !== view.ref.revision + 1) {
      throw new Error(`longhorizon: revision gap (expected ${view.ref === undefined ? 1 : view.ref.revision + 1}, got ${revision})`)
    }
  } else if (change.operation !== 'create' || revision !== 1) {
    throw new Error(`longhorizon: first mutation must be a create at revision 1, got ${change.operation}@${revision}`)
  }
  return {
    snapshot,
    ref: { taskId: snapshot.taskId, revision },
    createdAt: view.createdAt ?? createdAt,
    updatedAt,
  }
}

/**
 * Replay-fold a session's `longhorizon/state` events in seq order.
 * @param events - the append-origin session events.
 * @returns the folded view, or the empty view with no state events.
 * @throws on a malformed or non-contiguous stream.
 */
export function foldTaskState(events: readonly SessionEvent[]): TaskStateView {
  let view = emptyTaskStateView()
  for (const event of events) {
    if (event.type !== 'longhorizon/state') continue
    view = applyTaskStateChange(view, decodeTaskStateChange(event))
  }
  return view
}

/**
 * Decode one durable `longhorizon/evidence` event through runtime validation.
 * @param event - the raw session event.
 * @returns the validated verification evidence.
 * @throws on a malformed or unsupported evidence payload.
 */
export function decodeVerificationEvidence(event: SessionEvent<'longhorizon/evidence'>): VerificationEvidence {
  const value: unknown = event.data
  if (!isRecord(value) || value['kind'] !== 'longhorizon/evidence') {
    throw new Error('longhorizon: expected a longhorizon/evidence event')
  }
  if (value['version'] !== 1) {
    throw new Error(`longhorizon: unsupported evidence event version ${String(value['version'])}`)
  }
  const evidence = value['evidence']
  if (!isRecord(evidence)) throw new Error('longhorizon: evidence payload is not a record')
  const status: unknown = evidence['status']
  const statuses: EvidenceStatus[] = ['passed', 'failed', 'unknown']
  if (typeof status !== 'string' || !statuses.includes(status as EvidenceStatus)) {
    throw new Error(`longhorizon: invalid evidence status ${String(status)}`)
  }
  const verifierType: unknown = evidence['verifierType']
  if (verifierType !== 'artifact' && verifierType !== 'command') {
    throw new Error(`longhorizon: invalid evidence verifierType ${String(verifierType)}`)
  }
  const readOptionalString = (key: string): string | undefined => {
    const field = evidence[key]
    if (field === undefined) return undefined
    if (typeof field !== 'string') throw new Error(`longhorizon: invalid evidence ${key}`)
    return field
  }
  const exitCode = evidence['exitCode']
  if (exitCode !== undefined && (typeof exitCode !== 'number' || !Number.isInteger(exitCode))) {
    throw new Error('longhorizon: invalid evidence exitCode')
  }
  const artifactPath = readOptionalString('artifactPath')
  const artifactHash = readOptionalString('artifactHash')
  const command = readOptionalString('command')
  return {
    requirementId: reqString(evidence, 'requirementId'),
    taskRevision: reqRevision(evidence, 'taskRevision'),
    status: status as EvidenceStatus,
    verifierType,
    ...(artifactPath === undefined ? {} : { artifactPath }),
    ...(artifactHash === undefined ? {} : { artifactHash }),
    ...(command === undefined ? {} : { command }),
    ...(exitCode === undefined ? {} : { exitCode }),
    checkedAt: reqString(evidence, 'checkedAt'),
  }
}

/** Fold every durable evidence event in seq order, failing loud on malformed ones. */
export function foldEvidence(events: readonly SessionEvent[]): VerificationEvidence[] {
  const out: VerificationEvidence[] = []
  for (const event of events) {
    if (event.type !== 'longhorizon/evidence') continue
    out.push(decodeVerificationEvidence(event))
  }
  return out
}

/**
 * The latest evidence for one requirement at one task revision, or undefined.
 * Older-revision evidence is deliberately never matched: it cannot prove the
 * current revision.
 */
export function latestEvidenceForRequirement(
  events: readonly SessionEvent[],
  requirementId: string,
  taskRevision: number,
): VerificationEvidence | undefined {
  for (const event of [...events].reverse()) {
    if (event.type !== 'longhorizon/evidence') continue
    const evidence = decodeVerificationEvidence(event)
    if (evidence.requirementId === requirementId && evidence.taskRevision === taskRevision) return evidence
  }
  return undefined
}

/** Whether two evidence values are meaningfully identical (ignoring timestamps). */
export function evidenceEquivalent(a: VerificationEvidence, b: VerificationEvidence): boolean {
  return a.requirementId === b.requirementId
    && a.taskRevision === b.taskRevision
    && a.status === b.status
    && a.verifierType === b.verifierType
    && a.artifactPath === b.artifactPath
    && a.artifactHash === b.artifactHash
    && a.command === b.command
    && a.exitCode === b.exitCode
}

/** Each requirement's verification state under the current snapshot. */
export function requirementVerificationStatuses(
  snapshot: TaskSnapshot,
  events: readonly SessionEvent[],
): RequirementVerification[] {
  return snapshot.requirements.map((requirement) => {
    const latest = latestEvidenceForRequirement(events, requirement.id, snapshot.taskRevision)
    return {
      requirement,
      ...(latest === undefined ? {} : { latest }),
      verified: latest !== undefined && latest.status === 'passed',
    }
  })
}

/**
 * The completion invariant, enforced as the ONLY path into `done`: at least
 * one requirement must exist (an empty required set is not evidence), and every
 * required requirement must carry latest current-revision passing evidence.
 */
export function allRequiredVerified(snapshot: TaskSnapshot, events: readonly SessionEvent[]): boolean {
  const required = snapshot.requirements.filter(requirement => requirement.required)
  if (required.length === 0) return false
  return required.every(requirement =>
    latestEvidenceForRequirement(events, requirement.id, snapshot.taskRevision)?.status === 'passed')
}

/** Map a todo list status onto the plan item vocabulary. */
function planStatus(status: string): TaskPlanningItem['status'] {
  switch (status) {
    case 'completed': return 'done'
    case 'in_progress': return 'in-progress'
    case 'pending': return 'pending'
    default: return 'failed'
  }
}

/** Stable content-derived plan item id (short SHA-256 of the text), not the position. */
function planItemId(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * Fold the plan from the latest whole-list `todo/write` snapshot. The plan is
 * deliberately NOT stored in the task snapshot: the todo list is the model's
 * own durable plan artifact, and the snapshot only mirrors run counters.
 * Item ids are content-derived (stable across list reordering), never array
 * positions.
 * @param events - the append-origin session events.
 * @returns the current plan items, empty before the first todo_write.
 */
export function foldPlan(events: readonly SessionEvent[]): TaskPlanningItem[] {
  const latest = [...events].reverse().find(event => event.type === 'todo/write')
  if (latest === undefined) return []
  return latest.data.todos.map((todo, index) => ({
    id: planItemId(todo.content),
    index,
    text: todo.content,
    status: planStatus(todo.status),
  }))
}

/** Deterministic content digest of a plan (ordered `id`+`text` pairs, status-free). */
export function planDigest(items: readonly TaskPlanningItem[]): string {
  return createHash('sha256').update(JSON.stringify(items.map(item => [item.id, item.text]))).digest('hex')
}

/** The seq of the last `longhorizon/state` event whose snapshot armed a replan. */
export function lastReplanArmedSeq(events: readonly SessionEvent[]): number | undefined {
  let armed: number | undefined
  for (const event of events) {
    if (event.type !== 'longhorizon/state') continue
    const change = decodeTaskStateChange(event)
    if (change.operation !== 'clear' && change.snapshot.replanRequired) armed = event.seq
  }
  return armed
}

/**
 * The plan digest in force when the replan was last armed: the latest plan
 * BEFORE the arming state event. The model must produce a materially different
 * plan — not a status-only rewrite — to clear the replan request.
 */
export function replanReferenceDigest(events: readonly SessionEvent[]): string | undefined {
  const armed = lastReplanArmedSeq(events)
  if (armed === undefined) return undefined
  return planDigest(foldPlan(events.filter(event => event.seq < armed)))
}

/** The current plan digest, or undefined before the first todo_write. */
export function currentPlanDigest(events: readonly SessionEvent[]): string | undefined {
  return planDigest(foldPlan(events))
}

/**
 * Whether a pending replan request is satisfied: the replan was armed AND the
 * current plan digest differs from the digest at arm time. A reject-forever
 * of identical plans leaves the replan armed.
 */
export function planRevisionAccepted(events: readonly SessionEvent[]): boolean {
  const armed = lastReplanArmedSeq(events)
  if (armed === undefined) return false
  const reference = replanReferenceDigest(events)
  const current = currentPlanDigest(events)
  return reference !== undefined && reference !== current
}

/**
 * Fold failure counters from `tool/result` events, correlating tool names via
 * `tool/call`, and stamping the task revision in force when each failure
 * occurred (`longhorizon/state` events drive it). Per-tool consecutive runs
 * reset on that tool's success.
 * @param events - the append-origin session events.
 * @returns the folded counters plus per-fingerprint totals and the latest failure.
 */
export interface FoldedFailures {
  total: number
  consecutiveByTool: Record<string, number>
  byTool: Record<string, number>
  byFingerprint: Record<string, number>
  latest?: { tool: string; fingerprint: string; taskRevision: number }
  unknownOutcomes: number
  latestUnknown?: { tool: string; taskRevision: number }
}

/** Normalize a tool-result failure message into a bounded, stable fingerprint token. */
function failureToken(tool: string, code: string | undefined, text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 80)
  return `${tool}:${code ?? 'ERR'}:${normalized}`
}

export function foldFailures(events: readonly SessionEvent[]): FoldedFailures {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  const counts: FoldedFailures = {
    total: 0,
    consecutiveByTool: {},
    byTool: {},
    byFingerprint: {},
    unknownOutcomes: 0,
  }
  let revision = 1
  for (const event of events) {
    if (event.type === 'longhorizon/state') {
      const change = decodeTaskStateChange(event)
      if (change.operation !== 'clear') revision = change.snapshot.taskRevision
      continue
    }
    if (event.type !== 'tool/result') continue
    const source = event.data.message.source
    const tool = names.get(source.callId) ?? 'unknown'
    if (event.data.error === undefined) {
      counts.consecutiveByTool[tool] = 0
      continue
    }
    // A started-but-unsettled effect (crash-repair marks it TOOL_OUTCOME_UNKNOWN)
    // is NOT a failure: the controller must not assume it failed or succeeded.
    if (event.data.error.code === TOOL_OUTCOME_UNKNOWN) {
      counts.unknownOutcomes += 1
      counts.latestUnknown = { tool, taskRevision: revision }
      continue
    }
    counts.total += 1
    counts.byTool[tool] = (counts.byTool[tool] ?? 0) + 1
    counts.consecutiveByTool[tool] = (counts.consecutiveByTool[tool] ?? 0) + 1
    const text = event.data.message.content.map(blockText).filter((part): part is string => part !== undefined).join(' ')
    const fingerprint = failureToken(tool, event.data.error.code, text)
    counts.byFingerprint[fingerprint] = (counts.byFingerprint[fingerprint] ?? 0) + 1
    counts.latest = { tool, fingerprint, taskRevision: revision }
  }
  return counts
}

/**
 * Fold failure counters as if one more tool result (still being published)
 * were part of the stream. The agent loop emits `tools/result` before the
 * durable `tool/result` event is appended, so guards must account for the
 * current call themselves instead of reading a stale fold.
 * @param events - the append-origin session events (without the current result).
 * @param toolName - the tool name of the in-flight result.
 * @param isError - whether the current call failed.
 * @returns the folded counters including the in-flight call.
 */
export function foldFailuresWithCurrent(events: readonly SessionEvent[], toolName: string, isError: boolean): FoldedFailures {
  const failures = foldFailures(events)
  if (!isError) {
    failures.consecutiveByTool[toolName] = 0
    return failures
  }
  failures.total += 1
  failures.byTool[toolName] = (failures.byTool[toolName] ?? 0) + 1
  failures.consecutiveByTool[toolName] = (failures.consecutiveByTool[toolName] ?? 0) + 1
  return failures
}

/** Count executed steps from `step/start` events. */
export function foldStepCount(events: readonly SessionEvent[]): number {
  return events.reduce((count, event) => (event.type === 'step/start' ? count + 1 : count), 0)
}

/** The longest per-tool consecutive failure run — the value the guards compare. */
export function consecutiveFailurePeak(failures: { readonly consecutiveByTool: Readonly<Record<string, number>> }): number {
  return Math.max(0, ...Object.values(failures.consecutiveByTool))
}

/**
 * The number of executed steps since the last verified-progress marker: a new
 * `longhorizon/evidence` check or a `todo/write` whose completed-item count
 * grew. Distinct from tool-error counts — a run can spin without any error and
 * still make no verified progress.
 */
export function foldNoProgressSteps(events: readonly SessionEvent[]): number {
  let lastProgressSeq = -1
  let prevCompleted = 0
  for (const event of events) {
    if (event.type === 'longhorizon/evidence') {
      lastProgressSeq = event.seq
      continue
    }
    if (event.type === 'todo/write') {
      const completed = event.data.todos.filter(todo => todo.status === 'completed').length
      if (completed > prevCompleted) lastProgressSeq = event.seq
      prevCompleted = completed
    }
  }
  return events.reduce(
    (count, event) => (event.type === 'step/start' && event.seq > lastProgressSeq ? count + 1 : count),
    0,
  )
}

/**
 * Whether a turn ended with the model finishing by text: it closed as
 * completed (or interrupted, which the resume path treats as continue), and
 * its last assistant message carried no tool call.
 * @param events - the append-origin session events.
 * @param turn - the turn number to classify.
 * @returns true when the turn's final step was text-only.
 */
export function turnEndedWithText(events: readonly SessionEvent[], turn: number): boolean {
  let lastAssistantText = ''
  let sawToolCall = false
  let reason: string | undefined
  let inTurn = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      inTurn = event.data.turn === turn
      continue
    }
    if (event.type === 'turn/end') {
      if (event.data.turn === turn) reason = event.data.reason.kind
      inTurn = false
      continue
    }
    if (!inTurn) continue
    if (event.type === 'assistant/message' && event.data.turn === turn) {
      const blocks = event.data.message.content
      sawToolCall = blocks.some(block => block.type === 'tool-call')
      lastAssistantText = blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
    }
  }
  if (reason !== 'completed' && reason !== 'interrupted') return false
  return lastAssistantText.trim() !== '' && !sawToolCall
}

/**
 * Fold the current streak of consecutive text-only turn endings. A turn that
 * ended by text counts up the streak; any other ending resets it to zero.
 * @param events - the append-origin session events.
 * @returns the consecutive text-ending count as of the last turn/end.
 */
export function foldConsecutiveTextEndings(events: readonly SessionEvent[]): number {
  let streak = 0
  let turn = 0
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type !== 'turn/end') continue
    streak = turnEndedWithText(events, turn) ? streak + 1 : 0
  }
  return streak
}

/** The last durable turn/end event, or undefined when no turn closed yet. */
export function lastTurnEnd(events: readonly SessionEvent[]): { turn: number; reason: SessionEvent<'turn/end'>['data']['reason'] } | undefined {
  for (const event of [...events].reverse()) {
    if (event.type === 'turn/end') return { turn: event.data.turn, reason: event.data.reason }
  }
  return undefined
}
