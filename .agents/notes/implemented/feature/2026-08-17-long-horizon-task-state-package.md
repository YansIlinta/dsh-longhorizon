# Agent Note: durable long-horizon task state and controller package

Status: implemented

## Problem

Long-horizon agent runs (tens of steps, plan/replan, resume after
interruption) have no durable task-state surface in the harness. Session logs
carry the trajectory, and the goal domain carries an objective, but nothing
owns the run's own facts: status, step budget, replan count, plan, and
failure history. The prior demo implemented this as a workspace sidecar
(`examples/longhorizon/runtime`, `task-state.json`), which is not a product
surface.

## Proposal

A product package `packages/longhorizon/longhorizon` (`@deepseek-ai/dsh-longhorizon`)
with four entries:

- `.` — a durable state domain: `longhorizon/state` session events carrying
  revisioned full snapshots (`create`/`update`/`clear`), a strict replay fold
  (rejects revision gaps, stale clears, non-create first mutations), and the
  `ctx.longhorizon` service (`view`/`snapshot`/`append`/`clear`).
- `.` also exports the controller runtime and the agent-scoped "Task State"
  prompt section installer. The section is registered per agent at setup
  (assembling context carries no session), re-rendered every step from the
  snapshot plus derived folds, and captured per request by `request/header`.
- `./controller` — a function plugin wiring the loop guards: the step-budget
  reject, per-tool consecutive-failure replan coercion (via `agent.inject`),
  and the stall stop. Guards read the durable snapshot; transitions are
  appended as snapshot updates.
- `./runner` — the one-shot driver: create/resume, seed the snapshot, drive
  the completion gate (artifacts + host-side `artifactVerify`), commit the
  final status before the final flush, and exit with status codes
  `0`/`1`/`2`/`3` (done/error/budget/stalled).
- `./invariant` — the durable-stream invariant companion, mounted by
  diagnostic tooling (the `invariants` service is not in product profiles).

## What we give up

- The workspace-sidecar `task-state.json` snapshot. Facts stay in the
  model-written `.run/facts.md` (provenance = logged write/edit tool calls;
  the section text is captured per request in `request/header`), but there is
  no `longhorizon/facts` event yet — a model-facing `remember` tool is
  deferred.
- No `session-projection` unit yet; the fold is the query surface.
- Plan, step count, and failure counters are derived at render, never stored:
  the log is their single source of truth.

## How it is verified

- `packages/longhorizon/longhorizon/tests/` — 18 keyless tests: strict-fold
  semantics, derived folds, guard thresholds, section and trajectory renders,
  service CAS over a real `SessionStore`, and a real-composition boot (service
  + controller + runner + JSONL persistence, no key) asserting the persisted
  log replays to a committed `error` snapshot with exit 1.
- A real-model profile run through `examples/longhorizon/overlay.cordis.yml`
  produced a `longhorizon/state` create+update stream and budget exit 2.
- The example leaf now consumes the package; behavior tests live in the
  package. `startup.ts` flags (`--resume`/`--max-steps`/`--trajectory`) were
  already merged for the demo and serve this surface unchanged.

## Risks

- The section is registered per agent; multiple long-horizon agents in one
  process each render their own section (scoped), at O(log) fold per assembly.
- The `invariant` entry must never be mounted in a product profile (the
  `invariants` service is absent there).
