/**
 * Keyless boundary tests for the cheap pure branches that the semantic matrix
 * does not reach directly: the fail-loud decode matrix, the host-side verifier
 * edge cases, section clipping, atomic trajectory writing, and derived-facts
 * edge states. These double as the rejection evidence for the strict-stream
 * contract (Test H and friends).
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  blockText,
  decodeTaskStateChange,
  decodeVerificationEvidence,
  foldEvidence,
  foldNoProgressSteps,
  foldPlan,
  lastTurnEnd,
  planRevisionAccepted,
  turnEndedWithText,
} from '../src/index.ts'
import { finalExitCode, isTerminalStatus } from '../src/guards.ts'
import { renderTaskStateSection } from '../src/section.ts'
import { renderTrajectory, writeTrajectory } from '../src/trajectory.ts'
import { buildEvidence, verifyRequirement, COMMAND_TIMEOUT_MS } from '../src/verification.ts'
import { readFacts } from '../src/index.ts'
import type { TaskRequirement, TaskSnapshot } from '../src/types.ts'

function ev<T extends SessionEvent['type']>(type: T, data: Extract<SessionEvent, { type: T }>['data'], seq = 0): SessionEvent {
  return { type, data, seq, time: 0 } as unknown as SessionEvent
}

function artifactRequirement(path: string): TaskRequirement {
  return { id: `artifact:${path}`, description: `Produce artifact ${path}`, required: true, verifier: { type: 'artifact', path } }
}

function snapshot(): TaskSnapshot {
  return {
    taskId: 'session-x' as SessionId,
    objective: 'objective',
    status: 'running',
    maxSteps: 20,
    replanCount: 0,
    planRevisionCount: 0,
    taskRevision: 1,
    replanRequired: false,
    requirements: [artifactRequirement('REPORT.md')],
    updatedAt: 0,
  }
}

describe('blockText and plan status mapping', () => {
  it('returns text only for text blocks with string text', () => {
    expect(blockText({ type: 'text', text: 'hi' })).toBe('hi')
    expect(blockText({ type: 'tool-call', text: 'hi' })).toBeUndefined()
    expect(blockText({ type: 'text', text: 42 })).toBeUndefined()
    expect(blockText({})).toBeUndefined()
  })

  it('maps an unknown todo status to the failed plan status', () => {
    const plan = foldPlan([ev('todo/write', { todos: [{ content: 'x', status: 'weird' as never }] }, 1)])
    expect(plan[0]?.status).toBe('failed')
    expect(plan[0]?.id).toBeTruthy()
  })
})

describe('fail-loud state decode matrix', () => {
  const badState = (patch: Record<string, unknown>): SessionEvent =>
    ({ type: 'longhorizon/state', seq: 1, time: 1, data: {
      kind: 'longhorizon/state', version: 1, operation: 'create',
      snapshot: {
        taskId: 's', objective: 'o', status: 'running', maxSteps: 10,
        replanCount: 0, planRevisionCount: 0, taskRevision: 1,
        replanRequired: false, requirements: [], updatedAt: 1,
      },
      revision: 1, createdAt: 1, updatedAt: 1,
      ...patch,
    } } as unknown as SessionEvent)

  const badSnapshot = (patch: Record<string, unknown>): SessionEvent =>
    badState({ snapshot: {
      taskId: 's', objective: 'o', status: 'running', maxSteps: 10,
      replanCount: 0, planRevisionCount: 0, taskRevision: 1,
      replanRequired: false, requirements: [], updatedAt: 1,
      ...patch,
    } })

  it('rejects a non-state kind', () => {
    expect(() => decodeTaskStateChange({ ...badState({}), data: { kind: 'other' } } as never)).toThrow(/expected a longhorizon\/state event/)
  })
  it('rejects an unsupported version', () => {
    expect(() => decodeTaskStateChange(badState({ version: 2 }))).toThrow(/unsupported state event version/)
  })
  it('rejects a clear missing its cleared ref', () => {
    expect(() => decodeTaskStateChange(badState({ operation: 'clear', cleared: undefined }))).toThrow(/clear payload missing cleared ref/)
  })
  it('rejects an invalid operation', () => {
    expect(() => decodeTaskStateChange(badState({ operation: 'delete' }))).toThrow(/invalid operation/)
  })
  it('rejects a malformed snapshot status / maxSteps / requirements / task fields', () => {
    expect(() => decodeTaskStateChange(badSnapshot({ status: 'nope' }))).toThrow(/invalid status/)
    expect(() => decodeTaskStateChange(badSnapshot({ taskId: '' }))).toThrow(/invalid string field "taskId"/)
    expect(() => decodeTaskStateChange(badSnapshot({ maxSteps: 'x' }))).toThrow(/invalid number field "maxSteps"/)
    expect(() => decodeTaskStateChange(badSnapshot({ taskRevision: 0 }))).toThrow(/invalid taskRevision/)
    expect(() => decodeTaskStateChange(badSnapshot({ replanRequired: 1 }))).toThrow(/replanRequired must be a boolean/)
    expect(() => decodeTaskStateChange(badSnapshot({ planRevisionCount: -1 }))).toThrow(/invalid planRevisionCount/)
    expect(() => decodeTaskStateChange(badSnapshot({ requirements: 'nope' }))).toThrow(/requirements must be an array/)
    expect(() => decodeTaskStateChange(badSnapshot({ requirements: [{ id: 'r', description: 'd', required: true, verifier: { type: 'magic' } }] }))).toThrow(/invalid verifier type/)
    expect(() => decodeTaskStateChange(badSnapshot({ requirements: [{ id: '', description: 'd', required: true, verifier: { type: 'artifact', path: 'x' } }] }))).toThrow(/invalid string field "id"/)
    expect(() => decodeTaskStateChange(badSnapshot({ requirements: [{ id: 'r', description: 'd', required: 'yes', verifier: { type: 'artifact', path: 'x' } }] }))).toThrow(/required.*must be a boolean/)
    expect(() => decodeTaskStateChange(badSnapshot({ requirements: [{ id: 'r', description: 'd', required: true, verifier: { type: 'command', command: [1] } }] }))).toThrow(/invalid command verifier argv/)
  })
})

describe('fail-loud evidence decode matrix', () => {
  const good: Record<string, unknown> = {
    kind: 'longhorizon/evidence',
    version: 1,
    evidence: {
      requirementId: 'r', taskRevision: 1, status: 'passed',
      verifierType: 'artifact', checkedAt: '2026-01-01T00:00:00.000Z',
    },
  }
  const badEvidence = (patch: Record<string, unknown>): SessionEvent =>
    ({ type: 'longhorizon/evidence', seq: 1, time: 1, data: { ...good, evidence: { ...good.evidence as object, ...patch } } } as unknown as SessionEvent)

  it('rejects wrong kind / version / non-record evidence', () => {
    expect(() => decodeVerificationEvidence({ type: 'longhorizon/evidence', seq: 1, time: 1, data: { ...good, kind: 'x' } } as never)).toThrow(/expected a longhorizon\/evidence event/)
    expect(() => decodeVerificationEvidence({ type: 'longhorizon/evidence', seq: 1, time: 1, data: { ...good, version: 2 } } as never)).toThrow(/unsupported evidence event version/)
    expect(() => decodeVerificationEvidence({ type: 'longhorizon/evidence', seq: 1, time: 1, data: { ...good, evidence: 'nope' } } as never)).toThrow(/evidence payload is not a record/)
  })
  it('rejects bad status / verifierType / exitCode / optional strings / revision / requirementId', () => {
    expect(() => decodeVerificationEvidence(badEvidence({ status: 'maybe' }))).toThrow(/invalid evidence status/)
    expect(() => decodeVerificationEvidence(badEvidence({ verifierType: 'mystery' }))).toThrow(/invalid evidence verifierType/)
    expect(() => decodeVerificationEvidence(badEvidence({ exitCode: 1.5 }))).toThrow(/invalid evidence exitCode/)
    expect(() => decodeVerificationEvidence(badEvidence({ artifactHash: 42 }))).toThrow(/invalid evidence artifactHash/)
    expect(() => decodeVerificationEvidence(badEvidence({ taskRevision: 0 }))).toThrow(/invalid revision field "taskRevision"/)
    expect(() => decodeVerificationEvidence(badEvidence({ requirementId: '' }))).toThrow(/invalid string field "requirementId"/)
    expect(() => decodeVerificationEvidence(badEvidence({ checkedAt: '' }))).toThrow(/invalid string field "checkedAt"/)
  })
})

describe('host-side verifier edge cases', () => {
  it('fails on a directory or empty artifact, passes on a non-empty file, unknown on a stat error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-cov-v-'))
    try {
      writeFileSync(join(dir, 'file.txt'), 'hello', 'utf8')
      writeFileSync(join(dir, 'empty.txt'), '', 'utf8')
      mkdirSync(join(dir, 'subdir'))
      expect(verifyRequirement({ type: 'artifact', path: 'file.txt' }, dir).status).toBe('passed')
      expect(verifyRequirement({ type: 'artifact', path: 'empty.txt' }, dir).status).toBe('failed')
      expect(verifyRequirement({ type: 'artifact', path: 'subdir' }, dir).status).toBe('failed')
      // A path whose parent is a file -> ENOTDIR -> unknown, not failed.
      expect(verifyRequirement({ type: 'artifact', path: 'file.txt/child' }, dir).status).toBe('unknown')
      expect(verifyRequirement({ type: 'artifact', path: 'missing.txt' }, dir).status).toBe('failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes on exit 0, fails on non-zero, unknown on spawn failure and on an empty argv', () => {
    expect(verifyRequirement({ type: 'command', command: ['true'] }, '/tmp').status).toBe('passed')
    const failed = verifyRequirement({ type: 'command', command: ['sh', '-c', 'exit 3'] }, '/tmp')
    expect(failed.status).toBe('failed')
    expect(failed.exitCode).toBe(3)
    expect(failed.command).toBe('sh -c exit 3')
    expect(verifyRequirement({ type: 'command', command: ['__no_such_binary_xx__'] }, '/tmp').status).toBe('unknown')
    expect(verifyRequirement({ type: 'command', command: [] }, '/tmp').status).toBe('unknown')
    expect(COMMAND_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('builds evidence with and without optional fields', () => {
    const requirement = artifactRequirement('x')
    const full = buildEvidence(requirement, {
      status: 'passed', artifactPath: 'x', artifactHash: 'hash',
    }, 3)
    expect(full.artifactPath).toBe('x')
    expect(full.artifactHash).toBe('hash')
    expect(full.command).toBeUndefined()
    const bare = buildEvidence(requirement, { status: 'unknown' }, 3)
    expect(bare.artifactPath).toBeUndefined()
    expect(bare.status).toBe('unknown')
    const commandRequirement: TaskRequirement = {
      id: 'c', description: 'c', required: true, verifier: { type: 'command', command: ['true'] },
    }
    const commandEvidence = buildEvidence(commandRequirement, { status: 'passed', command: 'true', exitCode: 0 }, 1)
    expect(commandEvidence.verifierType).toBe('command')
    expect(commandEvidence.exitCode).toBe(0)
  })
})

describe('guards and terminal classification', () => {
  it('maps every terminal status to its exit code', () => {
    expect(finalExitCode('done')).toBe(0)
    expect(finalExitCode('budget-exhausted')).toBe(2)
    expect(finalExitCode('stalled')).toBe(3)
    expect(finalExitCode('error')).toBe(1)
    expect(finalExitCode(undefined)).toBe(1)
  })
  it('classifies terminal vs running', () => {
    expect(isTerminalStatus('running')).toBe(false)
    expect(isTerminalStatus('done')).toBe(true)
    expect(isTerminalStatus('stalled')).toBe(true)
  })
})

describe('section clipping and requirement rendering', () => {
  const base = snapshot()
  const longObjective = { ...base, objective: 'x'.repeat(200) }
  const derived = {
    plan: [{ id: 'a', index: 0, text: 'short step', status: 'pending' as const }],
    stepCount: 1,
    failures: { total: 0, consecutiveByTool: {}, byTool: {}, byFingerprint: {}, unknownOutcomes: 0 },
    requirements: [],
    noProgressSteps: 0,
  }

  it('clips long lines and renders the empty-requirement warning', () => {
    const section = renderTaskStateSection(longObjective, derived, undefined, false)
    expect(section).toContain('…')
    expect(section).toContain('completion is impossible until one is verified')
  })

  it('renders failed and pending requirement marks', () => {
    const withFailed = [{
      requirement: artifactRequirement('r'),
      verified: false,
      latest: { requirementId: 'artifact:r', taskRevision: 1, status: 'failed', verifierType: 'artifact', checkedAt: 'x' },
    }]
    const section = renderTaskStateSection(snapshot(), {
      ...derived,
      requirements: withFailed as never,
    }, undefined, false)
    expect(section).toContain('✗ Produce artifact r')
    expect(section).toContain('NOT ALLOWED')
  })
})

describe('trajectory write and edge reasons', () => {
  it('writes atomically via temp + rename (no leftover temp, valid file)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-cov-trajectory-'))
    try {
      const target = join(dir, 'out.md')
      writeTrajectory(target, '# hello\n')
      expect(existsSync(target)).toBe(true)
      expect(readFileSync(target, 'utf8')).toBe('# hello\n')
      const leftovers = readdirSync(dir).filter(name => name.startsWith('out.md.tmp'))
      expect(leftovers).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a running and a non-done conclusion reason', () => {
    const running = renderTrajectory('s', { ...snapshot(), status: 'running' }, [])
    expect(running).toContain('run not concluded')
    const exhausted = renderTrajectory('s', { ...snapshot(), status: 'budget-exhausted' }, [])
    expect(exhausted).toContain('concluded budget-exhausted')
    const errored = renderTrajectory('s', { ...snapshot(), status: 'error' }, [])
    expect(errored).toContain('concluded error')
    const none = renderTrajectory('s', { ...snapshot(), status: 'done' }, [])
    expect(none).toContain('(no verification checks were recorded)')
  })
})

describe('derived edge states', () => {
  it('foldNoProgressSteps and lastTurnEnd handle empty streams', () => {
    expect(foldNoProgressSteps([])).toBe(0)
    expect(lastTurnEnd([])).toBeUndefined()
    expect(foldEvidence([])).toEqual([])
  })

  it('turn classification covers interrupted and tool-call endings', () => {
    const start = (turn: number): SessionEvent => ev('turn/start', { turn }, turn * 10 - 1)
    const text = (turn: number): SessionEvent => ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as never, turn * 10)
    const tool = (turn: number): SessionEvent => ev('assistant/message', { turn, step: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c', name: 'x', arguments: '{}' }] } } as never, turn * 10)
    const end = (turn: number, kind: string): SessionEvent => ev('turn/end', { turn, reason: { kind } }, turn * 10 + 1)
    const interrupted = [start(1), text(1), end(1, 'interrupted')]
    expect(turnEndedWithText(interrupted, 1)).toBe(true)
    const toolEnding = [start(1), tool(1), end(1, 'completed')]
    expect(turnEndedWithText(toolEnding, 1)).toBe(false)
    const cancelled = [start(1), text(1), end(1, 'cancelled')]
    expect(turnEndedWithText(cancelled, 1)).toBe(false)
  })

  it('planRevisionAccepted is false without an armed replan and with an identical plan', () => {
    const events = [ev('todo/write', { todos: [{ content: 'a', status: 'pending' }] }, 1)]
    expect(planRevisionAccepted(events)).toBe(false)
  })

  it('readFacts returns an empty list for a missing file and the tail for an existing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lh-cov-facts-'))
    try {
      expect(readFacts(join(dir, 'missing.md'))).toEqual([])
      writeFileSync(join(dir, 'f.md'), Array.from({ length: 20 }, (_, i) => `fact ${i}`).join('\n'), 'utf8')
      const facts = readFacts(join(dir, 'f.md'))
      expect(facts.length).toBe(12)
      expect(facts[11]).toBe('fact 19')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
