# Agent Note: durable long-horizon task state and controller package

Status: implemented

English | [中文](2026-08-17-long-horizon-task-state-package.zh.md)

## Problem

Long-horizon agent runs (tens of steps, plan/replan, resume after
interruption) have no durable task-state surface in the harness. Session logs
carry the trajectory, and the goal domain carries an objective, but nothing
owns the run's own facts: status, step budget, replan count, plan, and
failure history. The prior demo implemented this as a workspace sidecar
(`examples/longhorizon/runtime`, `task-state.json`), which is not a product
surface.

## Decision

A product package `packages/longhorizon/longhorizon` (`@deepseek-ai/dsh-longhorizon`)
with four entries:

- `.` — a durable state domain: `longhorizon/state` session events carrying
  revisioned full snapshots (`create`/`update`/`clear`), a strict replay fold
  (rejects revision gaps, stale clears, non-create first mutations), the
  requirement/evidence vocabulary (`longhorizon/evidence`), and the
  `ctx.longhorizon` service (`view`/`snapshot`/`append`/`clear`/`appendEvidence`).
- `.` also exports the agent-scoped "Task State" prompt section installer. The
  section is registered per agent at setup (assembling context carries no
  session), re-rendered every step from the snapshot plus derived folds, and
  captured per request by `request/header`.
- `./controller` — a function plugin wiring the loop guards: the step-budget
  reject, per-tool consecutive-failure and no-progress replan requests (durable
  `replanRequired` in the snapshot), replan acceptance on a materially
  different `todo_write` plan, and the stall stop. Transitions are appended as
  snapshot updates.
- `./runner` — the one-shot driver: create/resume, seed the snapshot and
  requirements, drive verified completion (only all-required passing evidence
  at the current revision concludes `done`), commit the final status before the
  final flush, and exit with status codes `0`/`1`/`2`/`3`
  (done/error/budget/stalled).
- `./invariant` — the durable-stream invariant companion for both the state and
  evidence streams, mounted by diagnostic tooling (the `invariants` service is
  not in product profiles).

## Consequences

- The completion authority is host-side verification evidence, not the model's
  text assertions; a text-only "done" run with missing artifacts ends
  `budget-exhausted` (exit 2) with the unverified conditions on stderr. The
  `WeakMap` controller runtime is gone — the durable snapshot is the only
  replan authority.
- `longhorizon/evidence` joined the generated `KNOWN_SESSION_EVENT_TYPES`
  vocabulary (see the persistence catalog regeneration), so persisted evidence
  survives the persistence coordinator's load gate across restart.
- The plan, step count, failure counters, no-progress, and evidence are derived
  from the log at render; the snapshot never duplicates them. Facts stay in the
  model-written `.run/facts.md` (there is no `longhorizon/facts` event yet — a
  model-facing `remember` tool is deferred), and there is no
  `session-projection` unit yet; the fold is the query surface.

## Alternatives considered

- A workspace sidecar (`task-state.json`) instead of a durable stream: rejected
  — a sidecar is not a product surface and does not replay.
- Storing plan/step/failure facts in the snapshot instead of deriving them from
  the log: rejected — the log is their single source of truth and the snapshot
  stays small.

## Testing

- `packages/longhorizon/longhorizon/tests/` — 67 keyless tests: strict-fold
  semantics, derived folds, guard thresholds, section and trajectory renders,
  service CAS over a real `SessionStore`, a real-composition boot (service +
  controller + runner + JSONL persistence, no key), and the
  [verified-completion failure matrix](../architecture/2026-08-19-longhorizon-verified-completion.md)
  (false completion, command verifier, resume with zero agent turns, replan
  survival, artifact hash drift).
- A real-model profile run through `examples/longhorizon/overlay.cordis.yml`
  produced `longhorizon/state` create+update streams and budget exit 2.
- The example leaf consumes the package; behavior tests live in the package.
  `startup.ts` flags (`--resume`/`--max-steps`/`--trajectory`) serve this
  surface unchanged.

## Risks

- The section is registered per agent; multiple long-horizon agents in one
  process each render their own section (scoped), at O(log) fold per assembly.
- The `invariant` entry must never be mounted in a product profile (the
  `invariants` service is absent there).
- Host verification re-runs each idle; there is no exactly-once guarantee and
  no solve for concurrent resume of the same run (see the
  [verified-completion architecture note](../architecture/2026-08-19-longhorizon-verified-completion.md)).
