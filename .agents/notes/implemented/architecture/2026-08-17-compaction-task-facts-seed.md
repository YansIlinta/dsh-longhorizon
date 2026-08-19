# Agent Note: task-facts seed keeps durable task facts alive across compaction

Status: implemented

## Problem

Long-horizon compaction summarizes an older region of the session surface; a
truncated region can drop the very facts a compacted run needs to continue
(the objective, status, and early-step learnings), aggravating the
context-blow-up and losing-early-information failure modes. LongMemEval-type
evidence (frontier report) quantifies ~30% accuracy drops on
sustained-interaction memory.

## Proposal

A one-way summary-seed seam in `@deepseek-ai/dsh-compaction-basic`:
`registerSummarySeed(provider)` + `summarySeedFor(session)`. `region.ts`'s
`buildSummarizationInput` injects the folded seed as a framed
`<task-state>` user message immediately before the compaction instruction, so
the summarizer re-derives the durable facts instead of losing them to the
truncated window. `@deepseek-ai/dsh-longhorizon` registers a provider (in the
controller's `apply`, via `ctx.effect`) that folds the run's objective/status/
budget from the durable `longhorizon/state` snapshot. Dependency direction is
one-way: `longhorizon → compaction-basic`; `compaction-basic` has no
dependency on `longhorizon`. The provider contributes nothing for sessions
without a longhorizon snapshot, so other harness uses are unaffected.

(`web-search-minimax`, the MiniMax 搜索 provider that was briefly shipped
alongside this seed, has been removed again — out of v0 scope.)

## What we give up

- No three-tier warn/auto/hard compaction ladder or consecutive-failure
  breaker yet: those are deferred as a backward-compatible opt-in follow-up
  (they touch the trigger path of a heavily-pinned core package).
- The eval gate is mechanism-level (deterministic, no model): it pins that
  the seed is the survival mechanism, not a model-accuracy number.

## How it is verified

- `packages/compaction/compaction-basic/tests/seed.spec.ts` (registry
  semantics) and `tests/eval/eval.spec.ts` (labeled facts survive with the
  seed, none survive without, 8/8 preservation on the synthetic subset).
- The full compaction + longhorizon + web + headless suites stay green
  (498 tests); lint clean.

## Risks

- The seed text is per-session and injected before the compaction
  instruction; a large seed would cost KV-cache continuity — providers must
  keep their contribution small (the longhorizon seed is one objective + two
  counters).
