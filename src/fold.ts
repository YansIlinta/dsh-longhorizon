/**
 * Pure replay fold of the durable `longhorizon/state` stream: revision
 * continuity, create/update/clear semantics, and fail-loud decoding of
 * malformed changes. The fold is the single query surface for the service,
 * the invariant companion, and replay consumers.
 * @module @deepseek-ai/dsh-longhorizon/fold
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import './domain.ts'
import type { TaskSnapshot, TaskStateChange, TaskStateView } from './types.ts'

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

/**
 * Decode a durable snapshot payload through runtime validation (the
 * durable-log boundary): kinds, versions, required fields, and the closed
 * status vocabulary are checked, never trusted from a type assertion.
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
  return {
    taskId: reqString(value, 'taskId') as TaskSnapshot['taskId'],
    objective: reqString(value, 'objective'),
    status: status as TaskSnapshot['status'],
    maxSteps: reqNumber(value, 'maxSteps'),
    replanCount: reqNumber(value, 'replanCount'),
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

/** One folded plan line; text originates from the model's todo_write list. */
export interface TaskPlanningItem {
  id: string
  text: string
  status: 'pending' | 'in-progress' | 'done' | 'failed'
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

/**
 * Fold the plan from the latest whole-list `todo/write` snapshot. The plan is
 * deliberately NOT stored in the task snapshot: the todo list is the model's
 * own durable plan artifact, and the snapshot only mirrors run counters.
 * @param events - the append-origin session events.
 * @returns the current plan items, empty before the first todo_write.
 */
export function foldPlan(events: readonly SessionEvent[]): TaskPlanningItem[] {
  const latest = [...events].reverse().find(event => event.type === 'todo/write')
  if (latest === undefined) return []
  return latest.data.todos.map((todo, index) => ({
    id: String(index),
    text: todo.content,
    status: planStatus(todo.status),
  }))
}

/**
 * Fold failure counters from `tool/result` events, correlating tool names via
 * `tool/call`. Per-tool consecutive runs reset on that tool's success.
 * @param events - the append-origin session events.
 * @returns the folded counters.
 */
export interface FoldedFailures {
  total: number
  consecutiveByTool: Record<string, number>
  byTool: Record<string, number>
}

export function foldFailures(events: readonly SessionEvent[]): FoldedFailures {
  const names = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') names.set(event.data.callId, event.data.name)
  }
  const counts = { total: 0, consecutiveByTool: {} as Record<string, number>, byTool: {} as Record<string, number> }
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const source = event.data.message.source
    const tool = names.get(source.callId) ?? 'unknown'
    if (event.data.error === undefined) {
      counts.consecutiveByTool[tool] = 0
      continue
    }
    counts.total += 1
    counts.byTool[tool] = (counts.byTool[tool] ?? 0) + 1
    counts.consecutiveByTool[tool] = (counts.consecutiveByTool[tool] ?? 0) + 1
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
