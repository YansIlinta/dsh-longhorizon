# longhorizon/ — long-horizon agent state and controller

Durable task state, step budget, failure/replan guards, and a model-visible
Task State section for long-horizon agent runs. The run's own facts live in
durable `longhorizon/state` session events; plan, step count, and failure
counters are derived from the base session log at render, so the log stays the
single source of truth.

| Package | Role | Mount |
|---|---|---|
| `longhorizon/` | State domain (events, fold, `ctx.longhorizon` service) | default export |
| `longhorizon/controller` | Loop guards: budget, replan/stall, shared runtime | subpath row |
| `longhorizon/runner` | One-shot driver: create/resume, completion gate, exit codes | subpath row |
| `longhorizon/invariant` | Durable-stream invariant companion | subpath row |


## Installation

This is a workspace package of the DeepSeek Harness monorepo. In a checkout:

```sh
pnpm install
# Build the publishable lib surface (the repo host build also covers it):
pnpm exec tsc -b packages/longhorizon/longhorizon
pnpm exec tsdown --config packages/longhorizon/longhorizon/tsdown.config.ts
```

Consumers mount the rows by package name:

```yaml
- id: longhorizon
  name: '@deepseek-ai/dsh-longhorizon'
- id: longhorizon-controller
  name: '@deepseek-ai/dsh-longhorizon/controller'
- id: longhorizon-runner
  name: '@deepseek-ai/dsh-longhorizon/runner'
  config:
    task: '<objective>'
    maxSteps: 100
    artifacts: [REPORT.md]
```

## Quick start

From a workspace directory, using the shipped headless profile:

```sh
node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml \
  "Repair the pipeline and write REPORT.md"
```

Resume and budget:

```sh
# resume an interrupted run
… --resume <session-id> "finish the job"
# hard step cap (exit 2 at the cap)
… --max-steps 10 "<task>"
# readable step-by-step trajectory
… --trajectory ../out.md "<task>"
```

## Tests and build

```sh
# keyless unit + real-composition boot smoke
pnpm vitest run packages/longhorizon
# lint
pnpm exec oxlint packages/longhorizon
# typecheck/build the package
pnpm exec tsc -b packages/longhorizon/longhorizon
pnpm exec tsdown --config packages/longhorizon/longhorizon/tsdown.config.ts
```

## Model Experience

- **Model-visible input:** the "Task State" prompt section, registered per
  agent by the runner and re-rendered at every prompt assembly from the
  durable snapshot plus derived plan/step/failure folds and the workspace
  facts file. Every request's system prompt is captured by the log's
  `request/header`, so the section is reconstructable from the log.
- **Token effects:** the section is capped (~600 tokens: 8 plan lines, 12
  facts lines, 120-char line clip). The controller appends a
  `longhorizon/state` event only on transitions (status changes, replan
  counts), never per step, so log growth stays O(transitions).
- **KV-cache effects:** the section changes only when the snapshot or derived
  facts change; a stable run renders the same section text across requests.

## Configuration

`longhorizon/controller`:

| Field | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Workspace root the facts file resolves against |
| `factsFile` | `.run/facts.md` | Facts file path relative to the workspace |
| `failureLimit` | `3` | Peak per-tool consecutive failures that trip one replan coercion |
| `replanLimit` | `3` | Replan coercions before the run is declared stalled |

`longhorizon/runner`: `task` (required), `resumeSessionId`, `maxSteps`
(100), `trajectoryPath`, `workspace`, `artifacts` (`['REPORT.md']`),
`artifactVerify` (optional argv run host-side; an artifact is only confirmed
when it exits 0), `factsFile`.

Exit codes: `0` done · `1` error · `2` budget exhausted · `3` stalled.

## Durable state

`longhorizon/state` events carry revisioned full snapshots (`create`,
`update`, `clear`); the strict replay fold rejects revision gaps, stale
clears, and non-create first mutations. The invariant companion replays every
attached session's stream incrementally and fails the log on violations.

Derived facts (never stored in the snapshot): plan from `todo/write`
snapshots, `stepCount` from `step/start`, failure counters from `tool/result`
with per-tool consecutive runs reset by that tool's success, and facts from
the model's logged file writes to the facts file.

## Known Limitations and Deferred Work

- The Task State section is assembled from the workspace facts file; the
  facts' provenance is the logged write/edit tool calls (and the section text
  is captured per request in `request/header`), but there is no dedicated
  `longhorizon/facts` event yet — a model-facing `remember` tool is deferred.
- No `session-projection` unit yet: the fold is the query surface; a UI
  projection unit can be added without changing the event format.
- The controller folds on demand (O(log) per assembly); a cached projection
  is deferred until a consumer needs it.
