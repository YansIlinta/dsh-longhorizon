# Agent Note: task-facts seed keeps durable task facts alive across compaction

Status: implemented

English | [中文](2026-08-17-compaction-task-facts-seed.zh.md)

## Problem

Long-horizon compaction summarizes an older region of the session surface; a
truncated region can drop the very facts a compacted run needs to continue
(the objective, status, and early-step learnings), aggravating the
context-blow-up and losing-early-information failure modes. LongMemEval-type
evidence (frontier report) quantifies ~30% accuracy drops on
sustained-interaction memory.

## Decision

A one-way summary-seed seam in `@deepseek-ai/dsh-compaction-basic`:
`registerSummarySeed(provider)` + `summarySeedFor(session)`. `region.ts`'s
`buildSummarizationInput` injects the folded seed as a framed `<task-state>`
user message immediately before the compaction instruction, so the summarizer
re-derives the durable facts instead of losing them to the truncated window.
`@deepseek-ai/dsh-longhorizon` registers a provider (in the controller's
`apply`, via `ctx.effect`) that folds the run's objective/status/revision/
step budget, plus whether the required conditions are verified, from the
durable `longhorizon/state` snapshot and evidence stream. Dependency direction
is one-way: `longhorizon → compaction-basic`; `compaction-basic` has no
dependency on `longhorizon`. The provider contributes nothing for sessions
without a longhorizon snapshot, so other harness uses are unaffected.

(`web-search-minimax`, the MiniMax search provider that was briefly shipped
alongside this seed, has been removed again — out of v0 scope.)

## Consequences

- A compacted run re-derives the verified-facing facts (which required
  conditions remain unverified) instead of re-learning them from a truncated
  window.
- The seed is a mechanism-level, deterministic guarantee; it pins survival of
  the facts, not a model-accuracy number. No three-tier warn/auto/hard
  compaction ladder or consecutive-failure breaker ships yet — both are
  deferred as backward-compatible opt-in follow-ups (they touch the trigger
  path of a heavily-pinned core package).

## Alternatives considered

- Relying on the summarizer to infer the objective/status from the surviving
  surface alone: rejected — that is exactly the lossy path that truncation
  aggravates; the seed makes survival structural.
- A separate `longhorizon/facts` event as the seed source: rejected for now —
  the durable snapshot + evidence stream already reconstruct the verified
  state, so the seed has no extra writer to keep in sync.

## Testing

- `packages/compaction/compaction-basic/tests/seed.spec.ts` (registry
  semantics) and `tests/eval/eval.spec.ts` (labeled facts survive with the
  seed, none survive without, 8/8 preservation on the synthetic subset).
- The full compaction + longhorizon + web + headless suites stay green
  (498 tests); lint clean.

## Risks

- The seed text is per-session and injected before the compaction
  instruction; a large seed would cost KV-cache continuity — providers must
  keep their contribution small (the longhorizon seed is an objective, a
  status, a revision, the step budget, and a verified/unverified line).
