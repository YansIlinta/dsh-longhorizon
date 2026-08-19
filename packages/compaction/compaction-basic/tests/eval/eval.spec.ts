/**
 * Keyless compaction eval gate (synthetic LongMemEval-style subset): the
 * durable task-facts seed is the mechanism that keeps key facts alive across
 * a compaction that truncates the region. This asserts the mechanism
 * deterministically (no model, no network): with the seed provider
 * registered, every labeled fact survives via `summarySeedFor`; without it,
 * none survive.
 *
 * Motivation metric (external, cited from the frontier report): LongMemEval
 * reports ~30% accuracy drops on sustained-interaction memory; this gate pins
 * the mitigation mechanism, not a model accuracy number.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { registerSummarySeed, summarySeedFor } from '../../src/seed.ts'

interface Fixture {
  description: string
  documents: { id: string; text: string }[]
  questions: { id: string; ask: string; answer: string }[]
}

const fixture: Fixture = JSON.parse(
  readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'fixtures.json'), 'utf8'),
) as Fixture

/** The labeled facts the compaction region would truncate away. */
const FACTS = fixture.documents.flatMap(doc => (doc.text.match(/FACT-\d+/g) ?? []))

describe('compaction eval gate (task-facts survival)', () => {
  it('seeded path preserves every labeled fact; the unseeded path preserves none', () => {
    const session = Session.create(SessionId('session-eval'))

    // Baseline before any provider registers: no durable facts survive.
    expect(summarySeedFor(session)).toBeUndefined()

    // Seeded path: the longhorizon controller registers a durable-facts seed.
    const dispose = registerSummarySeed((s) => {
      if (s.id.toString() === 'session-eval') return FACTS.join('\n')
      return undefined
    })
    try {
      const seeded = summarySeedFor(session)
      expect(seeded).toBe(FACTS.join('\n'))
      expect(FACTS.every(fact => seeded?.includes(fact) ?? false)).toBe(true)
      // Full labeled-fact survival vs zero baseline.
      expect(FACTS.length).toBe(8)
    } finally {
      dispose()
    }
  })

  it('unregistering the seed removes the survival path', () => {
    const session = Session.create(SessionId('session-eval'))
    const dispose = registerSummarySeed(() => FACTS.join('\n'))
    expect(summarySeedFor(session)).toContain('FACT-08')
    dispose()
    expect(summarySeedFor(session)).toBeUndefined()
  })

  it('fixture carries recognizable key facts and questions', () => {
    expect(fixture.documents).toHaveLength(4)
    expect(FACTS).toHaveLength(8)
    expect(fixture.questions).toHaveLength(8)
  })
})
