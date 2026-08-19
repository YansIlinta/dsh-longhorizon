# @deepseek-ai/dsh-longhorizon — standalone package snapshot

Long-horizon agent state domain and controller for the DeepSeek Harness: durable
task state (`longhorizon/state` session events), step budget, failure/replan
guards, and a model-visible Task State section.

This is the standalone snapshot of `packages/longhorizon/longhorizon` from the
`deepseek-ai/DeepSeek-Harness` monorepo, extracted for independent packaging.

## Status: keyless-tested in-repo; needs one upstream release

- **Build:** `tsc -b && tsdown` compiles fully EXCEPT one import:
  `registerSummarySeed` from `@deepseek-ai/dsh-compaction-basic`.
  That API exists in the monorepo's `compaction-basic` but is **not yet
  published** (`npm @deepseek-ai/dsh-compaction-basic@0.1.0-rc.7` lacks it).
  Until it ships, the standalone build cannot pass typecheck and the compaction
  survival feature is inert outside the monorepo.
- **Tests:** the full suites (fold, service, scripted happy-path, keyless boot
  smoke) are green **inside the monorepo** where the matching sources resolve.
- The publishable tarball (`deepseek-ai-dsh-longhorizon-0.1.0-rc.5.tgz`,
  `npm pack`) is produced from the monorepo build and packs cleanly (27 files).

## Pending dependency (real, not mocked)

- Publish `@deepseek-ai/dsh-compaction-basic` with
  `registerSummarySeed` / `summarySeedFor` (in-repo `src/seed.ts`).
  After that lands, `pnpm install && pnpm run build` here should pass and the
  package is independently publishable.

## Build / test (once the dependency lands)

```sh
pnpm install
pnpm run build   # tsc -b && tsdown
pnpm test        # vitest run
```

## Consume

Mount the rows by package name:

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

## License

MIT
