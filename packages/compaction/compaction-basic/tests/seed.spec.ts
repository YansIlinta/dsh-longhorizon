/**
 * Keyless unit tests for the summary-seed registry: registration folds into
 * `summarySeedFor`, disposers remove providers, and empty contributions
 * yield no seed.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { registerSummarySeed, summarySeedFor } from '../src/seed.ts'

function stubSession(seed?: readonly SessionEvent[]): Session {
  return Session.create(SessionId('session-seed-test'), seed)
}

describe('summary seed registry', () => {
  it('folds registered providers into one seed text per session', () => {
    const session = stubSession()
    const a = registerSummarySeed(session => session.id.toString() === 'session-seed-test' ? 'Objective: fix the pipeline' : undefined)
    const b = registerSummarySeed(() => 'Status: running')
    try {
      expect(summarySeedFor(session)).toBe('Objective: fix the pipeline\nStatus: running')
    } finally {
      a()
      b()
    }
  })

  it('disposers remove providers and empty contributions yield no seed', () => {
    const session = stubSession()
    const a = registerSummarySeed(() => undefined)
    const b = registerSummarySeed(() => '')
    try {
      expect(summarySeedFor(session)).toBeUndefined()
    } finally {
      a()
      b()
    }
    expect(summarySeedFor(session)).toBeUndefined()
  })
})
