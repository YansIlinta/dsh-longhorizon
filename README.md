# @deepseek-ai/dsh-longhorizon — standalone package snapshot

Long-horizon agent state domain and controller for the DeepSeek Harness: durable
task state (`longhorizon/state` session events), step budget, failure/replan
guards, a model-visible Task State section, and a one-shot runner with a
host-side completion gate.

This is the standalone snapshot of `packages/longhorizon/longhorizon` from the
`deepseek-ai/DeepSeek-Harness` monorepo, extracted for independent packaging.
It is a Harness plugin package, not a standalone CLI; a Harness/dsh launcher
must mount the package rows shown below.

## Status: v0 product-closure work

- **Completion correctness:** a run can reach `done` only when every declared
  artifact is a non-empty regular file and, when configured, the bounded
  host-side `artifactVerify` command exits 0. Repeated model text claiming
  completion, empty files, directories, and failed/timed-out verification do
  not satisfy the gate.
- **Compaction compatibility:** `registerSummarySeed` is treated as an optional
  enhancement. Published `@deepseek-ai/dsh-compaction-basic` versions that do
  not expose that hook no longer cause a named-export typecheck failure; Task
  State still re-renders from durable session state, while summary seeding is
  simply unavailable on those versions.
- **Tests in this snapshot:** fold/service tests, a scripted create → artifact →
  done integration path, false-completion/empty-artifact/verifier-failure
  regressions, and a keyless boot/failure smoke test.
- **Standalone verification (2026-08-21):** a fresh `pnpm install` against a
  published DeepSeek Harness dependency set (resolved `dsh-compaction-basic`
  0.1.0-rc.8, which lacks the summary-seed hook) followed by `pnpm run build`
  (`tsc -b && tsdown`) and `pnpm test` (4 files / 25 tests) is fully green in
  this repository, and `npm pack` produces a clean 27-file tarball. `tsdown`
  and the test-only `@deepseek-ai` packages are declared in `devDependencies`
  so the snapshot builds and tests without the monorepo toolchain. This
  repository does not vendor those dependencies or ship its own launcher.

## Build / test

With a compatible DeepSeek Harness dependency set installed:

```sh
pnpm install
pnpm run build   # tsc -b && tsdown
pnpm test        # vitest run
```

## Consume

Mount the rows by package name from a Harness/dsh composition:

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

The runner also accepts `resumeSessionId`, `workspace`, `trajectoryPath`,
`artifactVerify`, and `factsFile` through its plugin config. The concrete CLI
flags/profile mapping live in the external Harness launcher, not in this repo.

## License

MIT
