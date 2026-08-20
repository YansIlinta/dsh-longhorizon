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

- **Completion correctness:** a run can reach `done` only when its declared
  artifacts exist and, when configured, the host-side `artifactVerify` command
  exits 0. Repeated model text claiming completion does not satisfy the gate.
- **Compaction compatibility:** `registerSummarySeed` is treated as an optional
  enhancement. Published `@deepseek-ai/dsh-compaction-basic` versions that do
  not expose that hook no longer cause a named-export typecheck failure; Task
  State still re-renders from durable session state, while summary seeding is
  simply unavailable on those versions.
- **Tests in this snapshot:** fold/service tests, a scripted create → artifact →
  done integration path, a scripted false-completion regression, and a keyless
  boot/failure smoke test.
- **Environment verification still required:** a fresh install/build/test must
  be run against a mutually compatible set of published DeepSeek Harness
  package versions. This repository does not vendor those dependencies or ship
  its own launcher.

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
