/**
 * Summary-seed registry: one-way hook that lets any consumer (e.g.
 * `@deepseek-ai/dsh-longhorizon`) inject durable task facts into the
 * compaction summary input so they survive the truncated window. Consumers
 * register a provider; `summarySeedFor` folds all registered providers' text
 * for one session. Registration is a reversed-effect; keep the disposer.
 * @module @deepseek-ai/dsh-compaction-basic/seed
 */

import type { Session } from '@deepseek-ai/dsh-session'

/** One session-scoped seed text provider, or undefined when the session has nothing to seed. */
export type SummarySeedProvider = (session: Session) => string | undefined

const providers = new Set<SummarySeedProvider>()

/**
 * Register a summary-seed provider for the whole process.
 * @param provider - called with each compacting session; its text is framed
 *   `<task-state>` and injected before the compaction instruction.
 * @returns the disposer that removes the provider.
 */
export function registerSummarySeed(provider: SummarySeedProvider): () => void {
  providers.add(provider)
  return () => { providers.delete(provider) }
}

/** The concatenated seed text for one session, or undefined with no provider contributing. */
export function summarySeedFor(session: Session): string | undefined {
  const parts: string[] = []
  for (const provider of providers) {
    const part = provider(session)
    if (part !== undefined && part.trim() !== '') parts.push(part)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}
