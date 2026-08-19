# GitHub-ready runbook

This checklist is for running on a machine with **write access to the repo
root** (the sandbox this package was developed in is read-only outside
`packages/longhorizon/longhorizon`). It covers turning the current v0 into a
buildable, testable, publishable package.

## 1. Wire the package into the Host build

Add this reference to `tsconfig.host.json` (inside the `references` array,
e.g. next to `compaction/compaction-basic`):

```json
{ "path": "./packages/longhorizon/longhorizon" }
```

Then typecheck/build:

```sh
pnpm run build:lib:host
pnpm exec tsc -b packages/longhorizon/longhorizon
```

Expected: `packages/longhorizon/longhorizon/lib/types/*.js` + `.d.ts` are
generated, and the only remaining TypeScript surface is clean.

## 2. Sync dependency declarations

`src/runner.ts` and `src/invariant.ts` reference these packages for types /
optional subpaths. Add them to `packages/longhorizon/longhorizon/package.json`
as `devDependencies` (or `peerDependencies` for the public `invariant` row),
then run `pnpm install` so `pnpm-lock.yaml` is updated:

- `@deepseek-ai/dsh-agent-default-model`
- `@deepseek-ai/cordis-plugin-loader`
- `@deepseek-ai/dsh-cmdline`
- `@deepseek-ai/dsh-invariants` (currently dev-only; if `invariant` is a
  shipped subpath, promote to peer)

```sh
pnpm install --offline
pnpm verify-lockfile   # or the repo's lock hygiene gate
```

## 3. Build the publishable `lib/`

```sh
pnpm --filter @deepseek-ai/dsh-longhorizon run build
# equivalent:
pnpm exec tsc -b packages/longhorizon/longhorizon
pnpm exec tsdown --config packages/longhorizon/longhorizon/tsdown.config.ts
```

Verify the tarball does not contain the `export * from '../src/*.ts'`
placeholders:

```sh
pnpm --filter @deepseek-ai/dsh-longhorizon pack
tar -xOf <tarball> package/lib/index.js | head
```

## 4. Run the full keyless gate

```sh
pnpm vitest run packages/longhorizon
pnpm exec oxlint packages/longhorizon
```

Current baseline: 3 spec files / 20 tests green, 0 oxlint errors.

## 5. Real-model end-to-end verification (outside sandbox)

With a key and a working sandbox, from `examples/longhorizon/task`:

```sh
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=... \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml \
  "Repair the pipeline so all 12 files are processed successfully, then write REPORT.md ..."
```

Checklist of paths to verify manually:

- [ ] exit 0 + `REPORT.md` produced + `verify.sh` passes
- [ ] exit 2 on `--max-steps` budget exhaustion
- [ ] `--resume <session-id>` continues and persists a final snapshot
- [ ] `--trajectory out.md` shows a real step count (not `undefined`)
- [ ] `.sessions/<id>/session.jsonl` replays through the package fold

## 6. Polish the example leaf

`examples/longhorizon/README.md` has one known typo (`))` in the Search
variant section) and lacks a Development/tests section; fix on a writable
checkout:

```diff
- env (`DEEPSEEK_API_KEY` / `EXA_API_KEY` / `PERPLEXITY_API_KEY`)) — without
+ env (`DEEPSEEK_API_KEY` / `EXA_API_KEY` / `PERPLEXITY_API_KEY`) — without
```

## 7. CI

Wire two jobs/steps into the repo CI:

```sh
pnpm vitest run packages/longhorizon
pnpm exec oxlint packages/longhorizon
```

## 8. Pre-publish sanity

- [ ] `license: MIT` present (already added)
- [ ] package README has Install / Quick start / Tests (already added)
- [ ] `pnpm publint` passes for `@deepseek-ai/dsh-longhorizon`
- [ ] secret scan: no `.dsh-home/settings.yaml`, logs, or session files land
      in git (current `.gitignore`s cover `.dsh-home/`, `.log`, `.sessions/`,
      `.run/`, `REPORT.md`, `pipeline.out`)
