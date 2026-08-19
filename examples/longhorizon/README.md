# Long-Horizon Agent Demo (product stack)

English | [中文](README.zh.md)

A real-LLM long-horizon run on the shipped headless profile, powered by the
product package `@deepseek-ai/dsh-longhorizon` (durable task state, step
budget, failure/replan guards, Task State section, runner, stream invariant).
This leaf holds only the composition, the persona, and the demo task; the
behavior is owned and tested by the package.

## Run

Prerequisites: a built or source-launched `dsh` (`node --import tsx/esm
apps/cli/src/bin.ts` from this checkout), `python3`, and a model key in the
environment that the harness can route (e.g. `OPENCODE_GO_API_KEY` with the
pi-ai `opencode-go` profile, or a DeepSeek key).

```sh
cd task
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml \
  "Repair the pipeline so all 12 files are processed successfully, then write REPORT.md (per-file results + what was fixed) and verify by rerunning."
```

The runner prints `run session: <id>` first, then the final answer. Exit
codes: `0` done · `1` error · `2` step budget exhausted · `3` stalled.

## Resume, budget, trajectory

```sh
# resume an interrupted run
… --resume <session-id> "finish the job"
# hard step cap (stops with exit 2 at the cap)
… --max-steps 10 "<task>"
# readable step-by-step trajectory
… --trajectory ../out.md "<task>"
```

## Inspecting a run

- `task/.sessions/<id>/session.jsonl` — the full durable log, including the
  `longhorizon/state` snapshot stream (ground truth; replays through the
  package fold).
- `task/.run/facts.md` — facts the model chose to persist.
- `task/REPORT.md` + `task/pipeline.out` — the produced artifacts.
- `sh verify.sh` — host-side artifact verification (wired as the runner's
  `artifactVerify`, so the completion gate only accepts a verified report).

## Products vs. this leaf

| Surface | Where |
|---|---|
| Durable state domain (`longhorizon/state` events, fold, `ctx.longhorizon`) | `packages/longhorizon/longhorizon` |
| Controller (budget / replan guards / shared runtime) | same package, `./controller` |
| Runner (drive, completion gate, exit codes) | same package, `./runner` |
| Stream invariant | same package, `./invariant` (mounted by diagnostic tooling, not this overlay) |
| Composition + persona + task | this leaf |

The Task State section is model-visible content assembled from the durable
snapshot plus derived folds; every request's system prompt (including the
section) is captured by the log's `request/header`.

## Search variant

`search-overlay.cordis.yml` keeps `web_search` enabled for web-search tasks
(see `task-set/`). Shipped search providers each need their own credential
env (`DEEPSEEK_API_KEY` / `EXA_API_KEY` / `PERPLEXITY_API_KEY`) — without
one, `web_search` reports `WEB_PROVIDER_CREDENTIAL_MISSING`.
## Development and tests

The product behavior lives in the package, not this leaf:

```sh
# keyless unit + scripted happy-path + real-composition boot smoke
pnpm vitest run packages/longhorizon
# persistence catalog (the durable longhorizon/state event vocabulary)
pnpm run verify-persistence-catalog
# lint + typecheck/build the package
pnpm exec oxlint packages/longhorizon
pnpm exec tsc -b packages/longhorizon/longhorizon
pnpm exec tsdown --config packages/longhorizon/longhorizon/tsdown.config.ts
```

The task fixtures under `task/data/` are read by `python3 pipeline.py`; run
`sh verify.sh` locally to check the REPORT.md completion gate without a model.
