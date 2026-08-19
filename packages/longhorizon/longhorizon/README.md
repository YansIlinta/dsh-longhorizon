# longhorizon/ — verified long-horizon agent control layer

Durable task state, step budget, failure/no-progress/replan guards, and a
model-visible Task State section for long-horizon agent runs. The run's own
facts (objective, status, revision, requirements, replan control state) live in
durable `longhorizon/state` session events; the plan, step count, failure
counters, and verification evidence are derived from the base session log at
render, so the log stays the single source of truth. **The model proposes
progress; only host-side verification evidence for every required requirement
at the current task revision lets a run conclude as `done`.** Saying "done" in
text never completes a task.

| Package | Role | Mount |
|---|---|---|
| `longhorizon/` | State domain (events, fold, `ctx.longhorizon` service) | default export |
| `longhorizon/controller` | Loop guards: budget, failure/no-progress replan, replan acceptance | subpath row |
| `longhorizon/runner` | One-shot driver: create/resume, verification, completion gate, exit codes | subpath row |
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
# resume an interrupted run (a completed run resumes with ZERO extra agent turns)
… --resume <session-id> "finish the job"
# hard step cap (exit 2 at the cap)
… --max-steps 10 "<task>"
# readable step-by-step trajectory
… --trajectory ../out.md "<task>"
# explicit requirements (additive over the legacy artifacts surface)
… --artifact-verify sh verify.sh "<task>"
```

## Tests and build

```sh
# keyless unit + real-composition + failure-matrix tests
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
  durable snapshot plus derived plan/step/failure/requirement folds and the
  workspace facts file. It shows the objective (never truncated), task status,
  current task revision, per-requirement verification state, current plan,
  recent verified progress, latest failure fingerprint, the no-progress
  counter, remaining step budget, and the completion eligibility line
  (`ALLOWED` only when every required condition is verified). Every request's
  system prompt is captured by the log's `request/header`, so the section is
  reconstructable from the log.
- **Token effects:** the section is capped (~650 tokens: 8 plan lines, 6
  requirement lines, 12 facts lines, 120-char line clip). The
  controller appends a `longhorizon/state` event only on transitions (status
  changes, replan requests/acceptances), and evidence events only on outcome
  or content change, so log growth stays O(transitions).
- **KV-cache effects:** the section changes only when the snapshot or derived
  facts change; a stable run renders the same section text across requests.

## Configuration

`longhorizon/controller`:

| Field | Default | Meaning |
|---|---|---|
| `workspace` | `process.cwd()` | Workspace root the facts file resolves against |
| `factsFile` | `.run/facts.md` | Facts file path relative to the workspace |
| `failureLimit` | `3` | Peak per-tool consecutive failures that trip one replan request |
| `replanLimit` | `3` | Replan requests before the run is declared stalled |
| `stallSteps` | `6` | Consecutive steps without verified progress that trip one replan request |

`longhorizon/runner`: `task` (required), `resumeSessionId`, `maxSteps`
(100), `trajectoryPath`, `workspace`, `artifacts` (`['REPORT.md']`),
`artifactVerify` (optional argv run host-side; becomes a command requirement),
`requirements` (optional explicit requirement declarations — the additive
surface over `artifacts`/`artifactVerify`), `factsFile`.

Requirement forms:

```ts
{ id: 'artifact:REPORT.md', description: 'Produce artifact REPORT.md', required: true,
  verifier: { type: 'artifact', path: 'REPORT.md' } }
{ id: 'command:verify', description: 'Host verification command passes', required: true,
  verifier: { type: 'command', command: ['sh', 'verify.sh'] } }
```

Exit codes: `0` done (every required condition verified at the current
revision) · `1` error · `2` budget exhausted · `3` stalled. A run that ends
not-`done` prints the unverified required conditions to stderr — never
silently.

## Durable state

`longhorizon/state` events carry revisioned full snapshots (`create`,
`update`, `clear`) with deterministic decode defaults for fields added after
v1 (`taskRevision` 1, `replanRequired` false, `planRevisionCount` 0,
`requirements` empty). The strict replay fold rejects revision gaps, stale
clears, and non-create first mutations.

`longhorizon/evidence` events carry one host-side verification check per
requirement per task revision (artifact existence + regular file + size +
SHA-256 content identity, or a command argv's exit code). Evidence binds to
`requirementId` + `taskRevision`: an older revision's evidence never counts for
the current revision. `done` is reachable only when every required requirement
has passing evidence at the current revision.

Derived facts (never stored in the snapshot): plan from `todo/write`
snapshots (stable content-derived step ids), `stepCount` from `step/start`,
failure counters (with per-fingerprint totals, the latest failure, and the
latest outcome-unknown effect) from `tool/result`, no-progress from
`longhorizon/evidence`/`todo/write` progress markers, and facts from the
model's logged file writes to the facts file. A crashed tool effect whose
result never persisted is marked `TOOL_OUTCOME_UNKNOWN` by the harness at
load-repair; the fold surfaces it as an uncertain effect — never as a failure
and never as a success — so the controller leaves retry decisions to the
model.

The invariant companion replays every attached session's `longhorizon/state`
and `longhorizon/evidence` streams incrementally and fails the log on
violations, including evidence for unknown requirements or future revisions.

## Replan and task revision semantics

- A replan request is **durable** (`replanRequired: true` in the snapshot),
  survives restart, and is issued on repeated per-tool failures or a
  progress-less stretch. An unrelated successful tool result never clears it.
- It clears only when a **materially different plan** is observed: a
  deterministic SHA-256 digest over the ordered plan content (status flips do
  not count). Acceptance increments `planRevisionCount`, bumps `taskRevision`,
  and invalidates evidence from the previous revision (which the host
  re-verifies at the next drive-loop idle).
- A completed/errored/stalled/budget-exhausted snapshot resumed via
  `--resume` reports and exits with **zero additional agent turns**.

## Known Limitations and Deferred Work

- The Task State section is assembled from the workspace facts file; the
  facts' provenance is the logged write/edit tool calls (and the section text
  is captured per request in `request/header`), but there is no dedicated
  `longhorizon/facts` event yet — a model-facing `remember` tool is deferred.
- **No exactly-once execution.** A crash after a successful effect but before
  its durable result persisted leaves the effect outcome unknown; the harness
  marks such effects `TOOL_OUTCOME_UNKNOWN` at load-repair, and this package
  folds them as "uncertain effect" — surfaced to the model, never counted as a
  failure, never assumed to have succeeded, and re-verified host-side on
  resume. Retry decisions stay with the model rather than being fabricated by
  the controller.
- **Concurrent resume is not solved by this package.** Two processes resuming
  the same run can both drive it; the durable log remains the authority and
  the strict fold fails loud on divergence, but there is no run-level lock.
- Verification proves existence + content identity + command exit codes only;
  semantic correctness of artifact content is out of V1 scope and belongs in
  command/custom verifiers.
- The controller folds on demand (O(log) per assembly); a cached projection
  is deferred until a consumer needs it.
- A legacy snapshot with no declared requirements cannot reach `done` (an
  empty required set is not evidence); the runner refuses to drive it loudly.
