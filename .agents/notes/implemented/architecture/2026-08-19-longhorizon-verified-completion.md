# Agent Note: verified completion and durable control state for the longhorizon runner

Status: implemented

English | [中文](2026-08-19-longhorizon-verified-completion.zh.md)

## Problem

The v0 longhorizon runner could conclude a run as `done` with exit code 0 as
soon as the model ended two text turns (`textEndings >= 2`) or no artifact was
missing (`missing.length === 0`). The LLM's own "done" assertion — not
verifier evidence — was the completion authority, so a run whose artifact did
not exist or whose host verification command failed could still report
success. Replanning was a prompt nudge backed by a `WeakMap` flag, so a
restart forgot whether a replan was pending.

## Decision

`@deepseek-ai/dsh-longhorizon` now enforces one completion invariant, "every
required requirement must carry passing verification evidence at the current
task revision", as the single path into `done`:

- **Requirements** are mapped from runner config (`artifacts` → artifact
  verifiers, `artifactVerify` → a command verifier, `requirements` for explicit
  specs) and stored in the durable snapshot.
- **`longhorizon/evidence`** is a new durable session event carrying one
  host-side check (artifact existence + regular file + size + SHA-256 content
  identity, or a command argv's exit code) bound to `requirementId` +
  `taskRevision`. Old-revision evidence never proves a new revision. Changed
  outcomes are deduplicated so the stream stays O(transitions).
- **Task revision** is durable and bumps on accepted plan revisions (and
  requirement/objective changes), invalidating evidence for re-verification.
- **Replan requests** are durable (`replanRequired` in the snapshot) and only
  clear when a materially different `todo_write` plan is observed — a
  deterministic SHA-256 digest over the ordered plan content; status-only
  rewrites and unrelated successful tool results never clear it. Acceptance
  increments `planRevisionCount` and bumps the revision.
- **No-progress detection** measures consecutive steps without new evidence or
  a plan-step completion, distinct from tool-error counts, and feeds the same
  durable replan request path.
- A **resumed terminal** snapshot (done/error/stalled/budget-exhausted)
  reports and exits with zero additional agent turns.
- **Trajectory** writes are atomic (temp + rename) and carry the revision,
  evidence, and completion reason.

## Consequences

- The LLM can no longer directly transition a task to `done`; a text-only
  "Done" run with a missing artifact ends `budget-exhausted` (exit 2) with the
  unverified requirements reported on stderr.
- `longhorizon/evidence` joined the generated `KNOWN_SESSION_EVENT_TYPES`
  vocabulary (`packages/core/session/src/known-event-types.ts`,
  `docs/persistence-catalog.md` regenerated), so persisted evidence survives
  the coordinator's load gate across restart.
- The `WeakMap` controller runtime is gone; the durable snapshot is the only
  replan authority, so the section renders `snapshot.replanRequired`.

## Alternatives considered

- Verifying only at finalization time (host-side checks once, at the end)
  instead of each drive-loop idle: rejected — it cannot detect a mutated
  artifact (content hash drift) after a stale pass, which the idle-time sweep
  catches for free.
- Storing plan fingerprints in the snapshot instead of folding the reference
  plan from the stream: rejected — the reference plan is fully reconstructable
  from durable events (`todo/write` before the arming state event), so a
  separate durable field would only risk divergence.
- Letting a `replanRequired` replan be cleared by any new todo write:
  rejected — a status-only rewrite must not mask a stuck plan.
- An empty/legacy requirement snapshot: the completion gate refuses `done`
  (an empty required set is not evidence) and the runner refuses to drive a
  resumed legacy snapshot loudly rather than silently reinterpreting it.

## Testing

- `tests/verified-completion.spec.ts` — the failure matrix: false completion
  (A), failed command verifier (B), verified completion (C), resume with zero
  agent turns (D), replan surviving a process-like restart (E), unrelated tool
  success not clearing replan (F), plan revision acceptance (G), and artifact
  hash drift (J).
- `tests/fold.spec.ts` — strict revision-gap rejection (H), evidence revision
  binding (I), plan digest / replan acceptance, no-progress measurement, and
  failure fingerprints.
- `tests/coverage.spec.ts` — the fail-loud decode matrix, host-side verifier
  edge cases, section clipping, atomic trajectory write.
- `tests/service.spec.ts` + `tests/happy-path.spec.ts` + `tests/boot.spec.ts`
  stay green under the new completion authority.

## Risks

- Host verification re-runs each drive-loop idle; command verifiers spawn a
  bounded (30 s) subprocess per idle, and huge artifacts are hashed in full.
- Concurrent resume of the same run by two processes is not solved by this
  package (documented as a known limitation); the durable log remains the
  authority and the strict fold fails loud on divergence.
- Exactly-once is not claimed: a crash between an effect and its durable
  result leaves the outcome unknown. The harness marks such effects
  `TOOL_OUTCOME_UNKNOWN` at load-repair; this package folds them as an
  uncertain effect and surfaces them to the model instead of fabricating a
  failure or success.
