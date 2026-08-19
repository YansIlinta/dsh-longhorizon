/**
 * Keyless unit tests for the longhorizon state domain: strict fold semantics,
 * derived folds, guard thresholds, evidence folding and revision binding, plan
 * digest / replan acceptance, no-progress measurement, the Task State section
 * render, and the trajectory renderer. No model, no network, no harness boot.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TaskRequirement, TaskSnapshot, VerificationEvidence } from '../src/types.ts'
import {
  allRequiredVerified,
  applyTaskStateChange,
  consecutiveFailurePeak,
  decodeTaskStateChange,
  decodeVerificationEvidence,
  emptyTaskStateView,
  evidenceEquivalent,
  foldConsecutiveTextEndings,
  foldEvidence,
  foldFailures,
  foldFailuresWithCurrent,
  foldNoProgressSteps,
  foldPlan,
  foldStepCount,
  foldTaskState,
  latestEvidenceForRequirement,
  planDigest,
  planRevisionAccepted,
  requirementVerificationStatuses,
  turnEndedWithText,
} from '../src/index.ts'
import {
  budgetExhausted,
  shouldCoerceReplan,
  shouldStopStalled,
} from '../src/guards.ts'
import { renderTaskStateSection } from '../src/section.ts'
import { renderTrajectory } from '../src/trajectory.ts'

/** Minimal synthetic event factory; payloads are cast because tests build fragments. */
function ev<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data'], seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function artifactRequirement(path: string): TaskRequirement {
  return { id: `artifact:${path}`, description: `Produce artifact ${path}`, required: true, verifier: { type: 'artifact', path } }
}

function snapshot(revision: number, taskId = 'session-x', status: TaskSnapshot['status'] = 'running'): TaskSnapshot {
  return {
    taskId: taskId as never,
    objective: 'fix the pipeline',
    status,
    maxSteps: 40,
    replanCount: 0,
    planRevisionCount: 0,
    taskRevision: 1,
    replanRequired: false,
    requirements: [artifactRequirement('REPORT.md')],
    updatedAt: revision,
  }
}

function stateEvent(operation: 'create' | 'update', revision: number, status?: TaskSnapshot['status'], taskRevision = 1): SessionEvent {
  return { type: 'longhorizon/state', seq: revision + 100, time: revision, data: {
    kind: 'longhorizon/state',
    version: 1,
    operation,
    snapshot: { ...snapshot(revision, 'session-x', status), taskRevision },
    revision,
    createdAt: 1,
    updatedAt: revision,
  } } as unknown as SessionEvent
}

function change(operation: 'create' | 'update', revision: number, status?: TaskSnapshot['status']): ReturnType<typeof decodeTaskStateChange> {
  return decodeTaskStateChange(stateEvent(operation, revision, status))
}

function evidenceEvent(requirementId: string, taskRevision: number, status: VerificationEvidence['status'], seq: number, extra: Partial<VerificationEvidence> = {}): SessionEvent {
  return { type: 'longhorizon/evidence', seq, time: seq, data: {
    kind: 'longhorizon/evidence',
    version: 1,
    evidence: {
      requirementId,
      taskRevision,
      status,
      verifierType: 'artifact',
      checkedAt: '2026-01-01T00:00:00.000Z',
      ...extra,
    },
  } } as unknown as SessionEvent
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

  it('rejects a revision gap (Test H: 1 then 3)', () => {
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

  it('defaults the task revision fields deterministically on a legacy snapshot', () => {
    const legacy = { type: 'longhorizon/state', seq: 1, time: 1, data: {
      kind: 'longhorizon/state',
      version: 1,
      operation: 'create',
      snapshot: { taskId: 'session-x', objective: 'old', status: 'running', maxSteps: 10, replanCount: 0, updatedAt: 1 },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    } } as unknown as SessionEvent
    const view = foldTaskState([legacy])
    expect(view.snapshot?.taskRevision).toBe(1)
    expect(view.snapshot?.replanRequired).toBe(false)
    expect(view.snapshot?.planRevisionCount).toBe(0)
    expect(view.snapshot?.requirements).toEqual([])
  })
})

describe('evidence fold', () => {
  it('decodes evidence and folds the stream in order', () => {
    const events = [
      evidenceEvent('artifact:REPORT.md', 1, 'passed', 5, { artifactPath: 'REPORT.md', artifactHash: 'abc' }),
      evidenceEvent('command:verify', 1, 'failed', 6, { command: 'sh verify.sh', exitCode: 1 }),
    ]
    const folded = foldEvidence(events)
    expect(folded.length).toBe(2)
    expect(folded[1]?.status).toBe('failed')
    expect(folded[1]?.exitCode).toBe(1)
    expect(decodeVerificationEvidence(events[0] as never).artifactHash).toBe('abc')
  })

  it('fails loud on a malformed evidence payload', () => {
    const bad = ev('longhorizon/evidence', { kind: 'longhorizon/evidence', version: 1, evidence: { requirementId: '', taskRevision: 0, status: 'maybe', verifierType: 'artifact', checkedAt: '' } }, 1)
    expect(() => foldEvidence([bad])).toThrow()
  })

  it('picks the latest evidence per requirement and revision (Test I: revision binding)', () => {
    const events = [
      evidenceEvent('artifact:REPORT.md', 1, 'passed', 5, { artifactHash: 'old' }),
      // Revision bumped to 2; old revision evidence must NOT carry it.
      evidenceEvent('artifact:REPORT.md', 2, 'passed', 7, { artifactHash: 'new' }),
    ]
    const latestRev1 = latestEvidenceForRequirement(events, 'artifact:REPORT.md', 1)
    expect(latestRev1?.artifactHash).toBe('old')
    const latestRev2 = latestEvidenceForRequirement(events, 'artifact:REPORT.md', 2)
    expect(latestRev2?.artifactHash).toBe('new')

    // Test I: revision-1 evidence cannot complete a revision-2 snapshot.
    const snap2 = { ...snapshot(2), taskRevision: 2 }
    expect(allRequiredVerified(snap2, events)).toBe(true) // rev2 evidence passes
    expect(allRequiredVerified(snap2, events.filter(e => e.seq !== 7))).toBe(false) // only rev1 evidence -> unverified
    expect(requirementVerificationStatuses(snap2, events)[0]?.verified).toBe(true)
  })

  it('requires a non-empty required set (no vacuous completion)', () => {
    const noRequirements = { ...snapshot(1), requirements: [] }
    expect(allRequiredVerified(noRequirements, [evidenceEvent('x', 1, 'passed', 1)])).toBe(false)
  })

  it('requires every required requirement to pass at the current revision', () => {
    const snap = { ...snapshot(1), requirements: [artifactRequirement('a.txt'), artifactRequirement('b.txt')] }
    const partial = [evidenceEvent('artifact:a.txt', 1, 'passed', 1, { artifactPath: 'a.txt' })]
    expect(allRequiredVerified(snap, partial)).toBe(false)
    const complete = [
      ...partial,
      evidenceEvent('artifact:b.txt', 1, 'passed', 2, { artifactPath: 'b.txt' }),
    ]
    expect(allRequiredVerified(snap, complete)).toBe(true)
    // A failed/unknown check never counts.
    const poisoned = [
      ...partial.slice(0, 0),
      evidenceEvent('artifact:a.txt', 1, 'failed', 1, { artifactPath: 'a.txt' }),
      evidenceEvent('artifact:b.txt', 1, 'passed', 2, { artifactPath: 'b.txt' }),
    ]
    expect(allRequiredVerified(snap, poisoned)).toBe(false)
  })

  it('compares evidence identity ignoring timestamps', () => {
    const a = foldEvidence([evidenceEvent('r', 1, 'passed', 1, { artifactHash: 'h' })])[0]!
    const b = { ...a, checkedAt: '2099-01-01T00:00:00.000Z' }
    expect(evidenceEquivalent(a, b)).toBe(true)
    expect(evidenceEquivalent(a, { ...a, artifactHash: 'other' })).toBe(false)
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

  it('folds the plan from the latest todo/write with stable content ids', () => {
    const plan = foldPlan(events)
    expect(plan.map(item => item.text)).toEqual(['replan'])
    expect(foldPlan(events.slice(0, 3)).map(item => item.text)).toEqual(['explore', 'fix'])
    expect(foldPlan(events.slice(0, 3))[0]?.status).toBe('done')
    expect(foldPlan(events)[0]?.status).toBe('in-progress')
    // Stable ids survive reordering: same content -> same id, position -> index.
    const again = foldPlan(events.slice(0, 3))
    expect(again[0]?.id).toBe(foldPlan([ev('todo/write', { todos: [{ content: 'explore', status: 'completed' }] }, 99)])[0]?.id)
    expect(again[1]?.id).not.toBe(again[0]?.id)
  })

  it('counts steps and folds per-tool failures with resets and fingerprints', () => {
    expect(foldStepCount(events)).toBe(2)
    const failures = foldFailures(events)
    expect(failures.total).toBe(1)
    expect(failures.byTool).toEqual({ bash: 1 })
    expect(failures.consecutiveByTool).toEqual({ bash: 0 }) // c2 success reset the slot
    expect(consecutiveFailurePeak(failures)).toBe(0)
    expect(failures.latest?.fingerprint).toContain('bash:E1:boom')
    expect(Object.keys(failures.byFingerprint).length).toBe(1)
  })

  it('tracks the per-tool consecutive peak across interleaved successes', () => {
    expect(consecutiveFailurePeak({ consecutiveByTool: { bash: 3, read: 0 } })).toBe(3)
    expect(consecutiveFailurePeak({ consecutiveByTool: {} })).toBe(0)
  })

  it('never counts a TOOL_OUTCOME_UNKNOWN effect as a failure', () => {
    const unknown = [
      ev('tool/call', { turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: '{}' }, 1),
      ev('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c9' }, content: [{ type: 'text', text: 'interrupted' }] }, error: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' } } as never, 2),
    ]
    const failures = foldFailures(unknown)
    expect(failures.total).toBe(0)
    expect(failures.byTool.bash).toBeUndefined()
    expect(failures.unknownOutcomes).toBe(1)
    expect(failures.latestUnknown?.tool).toBe('bash')
    expect(failures.latestUnknown?.taskRevision).toBe(1)
    expect(failures.latest).toBeUndefined()
  })

  it('accounts for an in-flight tool result before it is durably appended', () => {
    const single = [
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
    ]
    const failed = foldFailuresWithCurrent(single, 'bash', true)
    expect(failed.total).toBe(1)
    expect(failed.byTool.bash).toBe(1)
    expect(failed.consecutiveByTool.bash).toBe(1)

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

describe('no-progress measurement', () => {
  const step = (seq: number, turn = 1): SessionEvent => ev('step/start', { turn, step: seq }, seq)

  it('counts every step when nothing ever made progress', () => {
    const events = [step(1), step(2), step(3)]
    expect(foldNoProgressSteps(events)).toBe(3)
  })

  it('resets on a new evidence check', () => {
    const events = [step(1), evidenceEvent('r', 1, 'failed', 2), step(3), step(4)]
    expect(foldNoProgressSteps(events)).toBe(2)
  })

  it('resets on a todo/write whose completed count grew, and is separate from errors', () => {
    const events = [
      step(1),
      ev('todo/write', { todos: [{ content: 'a', status: 'pending' }] }, 2),
      step(3),
      step(4),
      ev('todo/write', { todos: [{ content: 'a', status: 'completed' }] }, 5),
      step(6),
    ]
    expect(foldNoProgressSteps(events)).toBe(1)
    // A tool failure by itself is not progress.
    const failureOnly = [step(1), step(2), step(3)]
    expect(foldNoProgressSteps(failureOnly)).toBe(3)
  })
})

describe('plan digest and replan acceptance (Test G)', () => {
  const planA = foldPlan([ev('todo/write', { todos: [{ content: 'step A1', status: 'pending' }, { content: 'step A2', status: 'pending' }] }, 1)])
  const planAagain = foldPlan([ev('todo/write', { todos: [{ content: 'step A1', status: 'in_progress' }, { content: 'step A2', status: 'pending' }] }, 2)])
  const planB = foldPlan([ev('todo/write', { todos: [{ content: 'step B1', status: 'pending' }] }, 3)])

  it('digests are status-free and reorder-stable in content', () => {
    expect(planDigest(planA)).toBe(planDigest(planAagain)) // only status changed
    expect(planDigest(planA)).not.toBe(planDigest(planB))
  })

  it('arms a replan with the plan before it; the same plan never accepts, a different one does', () => {
    const base = [
      ev('todo/write', { todos: [{ content: 'step A1', status: 'pending' }, { content: 'step A2', status: 'pending' }] }, 1),
    ]
    const armed = [
      ...base,
      // arm: replanRequired true -> reference plan = the one above
      { type: 'longhorizon/state', seq: 3, time: 3, data: {
        kind: 'longhorizon/state', version: 1, operation: 'update',
        snapshot: { ...snapshot(2, 'session-x', 'running'), replanRequired: true, replanCount: 1 },
        revision: 3, createdAt: 1, updatedAt: 3,
      } } as unknown as SessionEvent,
    ]
    // Rewrite the SAME content with different statuses -> still armed.
    const samePlan = [...armed, ev('todo/write', { todos: [{ content: 'step A1', status: 'completed' }, { content: 'step A2', status: 'pending' }] }, 4)]
    expect(planRevisionAccepted(samePlan)).toBe(false)
    // A materially different plan -> accepted.
    const different = [...armed, ev('todo/write', { todos: [{ content: 'step B1', status: 'pending' }] }, 4)]
    expect(planRevisionAccepted(different)).toBe(true)
    // Without an armed replan, nothing is accepted.
    expect(planRevisionAccepted(base)).toBe(false)
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
    plan: [
      { id: 'p1', index: 0, text: 'explore data', status: 'done' as const },
      { id: 'p2', index: 1, text: 'fix pipeline', status: 'in-progress' as const },
    ],
    stepCount: 7,
    failures: { total: 2, consecutiveByTool: { bash: 2 }, byTool: { bash: 2 }, byFingerprint: {}, unknownOutcomes: 0 },
    requirements: [],
    noProgressSteps: 0,
  }

  it('renders the pinned shape with facts and counters', () => {
    const section = renderTaskStateSection(snap, derived, 'file 06 has a bad utf-8 byte', false)
    expect(section).toContain('## Task State (step 7/40')
    expect(section).toContain('Objective: fix the pipeline')
    expect(section).toContain('1. [done] explore data')
    expect(section).toContain('Recent facts: file 06 has a bad utf-8 byte')
    expect(section).toContain('Failures: total 2 (bash 2) · peak consecutive 2')
    expect(section).toContain('Revision: 1')
    expect(section).toContain('Completion: NOT ALLOWED')
    expect(section).not.toContain('Replan note')
  })

  it('shows the replan note only while coercion is armed', () => {
    const armed = renderTaskStateSection(snap, derived, undefined, true)
    expect(armed).toContain('Replan note')
    expect(armed).toContain('(none yet)')
  })

  it('surfaces an outcome-unknown effect without calling it a failure', () => {
    const withUnknown = {
      ...derived,
      failures: { total: 2, consecutiveByTool: { bash: 2 }, byTool: { bash: 2 }, byFingerprint: {}, unknownOutcomes: 1, latestUnknown: { tool: 'bash', taskRevision: 1 } },
    }
    const section = renderTaskStateSection(snap, withUnknown, undefined, false)
    expect(section).toContain('Uncertain effect: tool bash outcome unknown')
    expect(section).toContain('do not assume it succeeded or failed')
  })

  it('shows requirement statuses and allows completion only when all required pass', () => {
    const withReq = {
      ...snap,
      requirements: [artifactRequirement('REPORT.md')],
    }
    const verified = [{
      requirement: artifactRequirement('REPORT.md'),
      verified: true,
    } satisfies { requirement: TaskRequirement; verified: boolean }]
    const section = renderTaskStateSection(withReq, {
      ...derived,
      requirements: verified,
    }, undefined, false)
    expect(section).toContain('✓ Produce artifact REPORT.md')
    expect(section).toContain('Completion: ALLOWED')
  })
})

describe('trajectory renderer', () => {
  it('renders turns, steps, tool calls, evidence, and the final state from append-origin events', () => {
    const events: SessionEvent[] = [
      ev('turn/start', { turn: 1 }, 1),
      ev('step/start', { turn: 1, step: 1 }, 2),
      ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"python3 pipeline.py"}' }, 3),
      ev('tool/result', { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'KeyError: value' }] }, error: { name: 'Error', code: 'E1' } } as never, 4),
      ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'the fix' }] } } as never, 5),
      evidenceEvent('artifact:REPORT.md', 1, 'passed', 6, { artifactPath: 'REPORT.md', artifactHash: 'deadbeef' }),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
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
    expect(md).toContain('## Verification evidence')
    expect(md).toContain('passed artifact:REPORT.md@r1')
    expect(md).toContain('Completion reason:')
    expect(md).toContain('## Final task state')
  })
})
