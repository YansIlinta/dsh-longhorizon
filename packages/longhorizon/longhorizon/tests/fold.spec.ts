/**
 * Keyless unit tests for the longhorizon state domain: strict fold semantics,
 * derived folds, guard thresholds, the Task State section render, and the
 * trajectory renderer. No model, no network, no harness boot.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyTaskStateChange,
  consecutiveFailurePeak,
  decodeTaskStateChange,
  emptyTaskStateView,
  foldConsecutiveTextEndings,
  foldFailures,
  foldFailuresWithCurrent,
  foldPlan,
  foldStepCount,
  foldTaskState,
  turnEndedWithText,
} from '../src/index.ts'
import {
  budgetExhausted,
  shouldCoerceReplan,
  shouldStopStalled,
} from '../src/guards.ts'
import { renderTaskStateSection } from '../src/section.ts'
import { renderTrajectory } from '../src/trajectory.ts'
import type { TaskSnapshot } from '../src/types.ts'

/** Minimal synthetic event factory; payloads are cast because tests build fragments. */
function ev<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data'], seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function snapshot(revision: number, taskId = 'session-x', status: TaskSnapshot['status'] = 'running'): TaskSnapshot {
  return { taskId: taskId as never, objective: 'fix the pipeline', status, maxSteps: 40, replanCount: 0, updatedAt: revision }
}

function stateEvent(operation: 'create' | 'update', revision: number, status?: TaskSnapshot['status']): SessionEvent {
  return { type: 'longhorizon/state', seq: revision, time: revision, data: {
    kind: 'longhorizon/state',
    version: 1,
    operation,
    snapshot: snapshot(revision, 'session-x', status),
    revision,
    createdAt: 1,
    updatedAt: revision,
  } } as unknown as SessionEvent
}

function change(operation: 'create' | 'update', revision: number, status?: TaskSnapshot['status']): ReturnType<typeof decodeTaskStateChange> {
  return decodeTaskStateChange(stateEvent(operation, revision, status))
}

describe('strict fold', () => {
  it('accepts create then contiguous updates', () => {
    let view = emptyTaskStateView()
    view = applyTaskStateChange(view, change('create', 1))
    view = applyTaskStateChange(view, change('update', 2))
    view = applyTaskStateChange(view, change('update', 3, 'done'))
    expect(view.snapshot?.status).toBe('done')
    expect(view.ref?.revision).toBe(3)
    expect(view.createdAt).toBe(1)
    expect(view.updatedAt).toBe(3)
  })

  it('rejects a non-create first mutation', () => {
    expect(() => applyTaskStateChange(emptyTaskStateView(), change('update', 1))).toThrow(/first mutation must be a create/)
  })

  it('rejects a revision gap', () => {
    const view = applyTaskStateChange(emptyTaskStateView(), change('create', 1))
    expect(() => applyTaskStateChange(view, change('update', 3))).toThrow(/revision gap/)
  })

  it('rejects an update after clear and accepts a fresh create', () => {
    const view = applyTaskStateChange(applyTaskStateChange(emptyTaskStateView(), change('create', 1)), {
      operation: 'clear',
      cleared: { taskId: 'session-x' as never, revision: 1 },
      clearedAt: 2,
    })
    expect(view.snapshot).toBeUndefined()
    expect(() => applyTaskStateChange(view, change('update', 3))).toThrow(/first mutation must be a create/)
    const fresh = applyTaskStateChange(view, change('create', 1))
    expect(fresh.snapshot?.status).toBe('running')
  })

  it('rejects a clear revision mismatch', () => {
    const view = applyTaskStateChange(emptyTaskStateView(), change('create', 1))
    expect(() => applyTaskStateChange(view, {
      operation: 'clear',
      cleared: { taskId: 'session-x' as never, revision: 9 },
      clearedAt: 2,
    })).toThrow(/clear revision mismatch/)
  })

  it('replay-folds a full stream and fails loud on gaps', () => {
    const events = [
      ev('step/start', { turn: 1, step: 1 }),
      stateEvent('create', 1),
      stateEvent('update', 2),
    ]
    expect(foldTaskState(events).ref?.revision).toBe(2)
    const gap = [...events, stateEvent('update', 4)]
    expect(() => foldTaskState(gap)).toThrow(/revision gap/)
  })
})

describe('derived folds', () => {
  const events: SessionEvent[] = [
    ev('turn/start', { turn: 1 }, 1),
    ev('step/start', { turn: 1, step: 1 }, 2),
    ev('todo/write', { todos: [{ content: 'explore', status: 'completed' }, { content: 'fix', status: 'pending' }] }, 3),
    ev('step/start', { turn: 1, step: 2 }, 4),
    ev('tool/call', { turn: 1, step: 2, callId: 'c1', name: 'bash', arguments: '{}' }, 5),
    ev('tool/result', { turn: 1, step: 2, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'boom' }] }, error: { name: 'Error', code: 'E1' } } as never, 6),
    ev('tool/call', { turn: 1, step: 2, callId: 'c2', name: 'bash', arguments: '{}' }, 7),
    ev('tool/result', { turn: 1, step: 2, message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'ok' }] } } as never, 8),
    ev('todo/write', { todos: [{ content: 'replan', status: 'in_progress' }] }, 9),
  ]

  it('folds the plan from the latest todo/write', () => {
    const plan = foldPlan(events)
    expect(plan.map(item => item.text)).toEqual(['replan'])
    expect(foldPlan(events.slice(0, 3)).map(item => item.text)).toEqual(['explore', 'fix'])
    expect(foldPlan(events.slice(0, 3))[0]?.status).toBe('done')
    expect(foldPlan(events)[0]?.status).toBe('in-progress')
  })

  it('counts steps and folds per-tool failures with resets', () => {
    expect(foldStepCount(events)).toBe(2)
    const failures = foldFailures(events)
    expect(failures.total).toBe(1)
    expect(failures.byTool).toEqual({ bash: 1 })
    expect(failures.consecutiveByTool).toEqual({ bash: 0 }) // c2 success reset the slot
    expect(consecutiveFailurePeak(failures)).toBe(0)
  })

  it('tracks the per-tool consecutive peak across interleaved successes', () => {
    expect(consecutiveFailurePeak({ consecutiveByTool: { bash: 3, read: 0 } })).toBe(3)
    expect(consecutiveFailurePeak({ consecutiveByTool: {} })).toBe(0)
  })

  it('accounts for an in-flight tool result before it is durably appended', () => {
    const single = [
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ]
    const failed = foldFailuresWithCurrent(single, 'bash', true)
    expect(failed.total).toBe(1)
    expect(failed.byTool.bash).toBe(1)
    expect(failed.consecutiveByTool.bash).toBe(1)

    // The base events already hold one failure and one success (c2 reset the
    // streak); a currently-failing bash call must add the failure and start a
    // fresh consecutive streak.
    const withCurrentFailure = foldFailuresWithCurrent(events, 'bash', true)
    expect(withCurrentFailure.total).toBe(2)
    expect(withCurrentFailure.byTool.bash).toBe(2)
    expect(withCurrentFailure.consecutiveByTool.bash).toBe(1)

    const withCurrentSuccess = foldFailuresWithCurrent(events, 'bash', false)
    expect(withCurrentSuccess.total).toBe(1)
    expect(withCurrentSuccess.consecutiveByTool.bash).toBe(0)
  })

  it('classifies text-ending turns and streaks', () => {
    const text = (turn: number): SessionEvent => ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as never, turn * 10)
    const end = (turn: number, kind: 'completed' | 'error' = 'completed'): SessionEvent => ev('turn/end', { turn, reason: { kind } }, turn * 10 + 1)
    const start = (turn: number): SessionEvent => ev('turn/start', { turn }, turn * 10 - 1)
    const ok = [start(1), text(1), end(1), start(2), text(2), end(2)]
    expect(foldConsecutiveTextEndings(ok)).toBe(2)
    expect(turnEndedWithText(ok, 2)).toBe(true)
    const mixed = [start(1), text(1), end(1), start(2), text(2), end(2, 'error')]
    expect(foldConsecutiveTextEndings(mixed)).toBe(0)
  })
})

describe('guard thresholds', () => {
  it('rejects only at or beyond the cap', () => {
    expect(budgetExhausted(9, 10)).toBe(false)
    expect(budgetExhausted(10, 10)).toBe(true)
  })

  it('coerces a replan while attempts remain, stalls after the limit', () => {
    expect(shouldCoerceReplan(2, 3, 0, 3)).toBe(false)
    expect(shouldCoerceReplan(3, 3, 0, 3)).toBe(true)
    expect(shouldCoerceReplan(3, 3, 2, 3)).toBe(true)
    expect(shouldCoerceReplan(3, 3, 3, 3)).toBe(false)
    expect(shouldStopStalled(3, 3, 3, 3)).toBe(true)
    expect(shouldStopStalled(3, 3, 2, 3)).toBe(false)
    expect(shouldCoerceReplan(5, 4, 0, 3)).toBe(true)
  })
})

describe('Task State section render', () => {
  const snap = snapshot(1)
  const derived = {
    plan: [{ id: '0', text: 'explore data', status: 'done' as const }, { id: '1', text: 'fix pipeline', status: 'in-progress' as const }],
    stepCount: 7,
    failures: { total: 2, consecutiveByTool: { bash: 2 }, byTool: { bash: 2 } },
  }

  it('renders the pinned shape with facts and counters', () => {
    const section = renderTaskStateSection(snap, derived, 'file 06 has a bad utf-8 byte', false)
    expect(section).toContain('## Task State (step 7/40')
    expect(section).toContain('Objective: fix the pipeline')
    expect(section).toContain('1. [done] explore data')
    expect(section).toContain('Recent facts: file 06 has a bad utf-8 byte')
    expect(section).toContain('Failures: total 2 (bash 2) · peak consecutive 2')
    expect(section).not.toContain('Replan note')
  })

  it('shows the replan note only while coercion is armed', () => {
    const armed = renderTaskStateSection(snap, derived, undefined, true)
    expect(armed).toContain('Replan note')
    expect(armed).toContain('(none yet)')
  })
})

describe('trajectory renderer', () => {
  it('renders turns, steps, tool calls, and the final state from append-origin events', () => {
    const events: SessionEvent[] = [
      ev('turn/start', { turn: 1 }, 1),
      ev('step/start', { turn: 1, step: 1 }, 2),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"python3 pipeline.py"}' }, 3),
      ev('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'KeyError: value' }] }, error: { name: 'Error', code: 'E1' } } as never, 4),
      ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'the fix' }] } } as never, 5),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
    ]
    const md = renderTrajectory('session-x', snapshot(1), events)
    expect(md).toContain('# Run trajectory — session-x')
    expect(md).toContain('Objective: fix the pipeline')
    expect(md).toContain('steps: 1/40')
    expect(md).toContain('## Turn 1')
    expect(md).toContain('### Step 1')
    expect(md).toContain('run: bash {"command":"python3 pipeline.py"}')
    expect(md).toContain('error E1: KeyError: value')
    expect(md).toContain('ASSISTANT: the fix')
    expect(md).toContain('## Final task state')
  })
})
