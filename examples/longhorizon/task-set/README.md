# Search task set

English | [中文](README.zh.md)

Four targeted tasks exercising the demo's workspace-search abilities
(`glob` / `grep` / `read`) over the task workspace in `../task/`. Each runs
through the same long-horizon runner with the demo overlay; `--max-steps 15`
bounds each task. Expected answers:

- `search-1` → 3 files (`01_basic.csv` 5 rows, `09_basic.csv` 3 rows, `11_basic.csv` 3 rows)
- `search-2` → only `README.md` (its "todo"-free content actually contains no TODO; expect "no matches" or the README lines)
- `search-3` → `01_basic.csv` and `05_dup_of_01.csv` (byte-identical)
- `search-4` → `08_large.csv`, 2000 rows, last row `8 2000 row-2000 3000.0`

Run one task (from `../task/`, which is the sandbox workspace):

```sh
cd ../task
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml --max-steps 15 \
  "$(cat ../task-set/tasks/search-1.txt)"
```

## Web search tasks (`web-tasks/`)

The demo overlay disables `web_search`; the search variant
`search-overlay.cordis.yml` keeps it enabled. The shipped search providers
each need their own credential env:

| Provider row | Credential env | Status here |
|---|---|---|
| `web-search-deepseek` (default) | `DEEPSEEK_API_KEY` | no valid key — `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `web-search-exa` | `EXA_API_KEY` | not mounted in the overlay |
| `web-search-perplexity` | `PERPLEXITY_API_KEY` | not mounted in the overlay |

To run a web task (from `web-run/` so the workspace stays separate):

```sh
cd web-run
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… DEEPSEEK_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/search-overlay.cordis.yml --max-steps 10 \
  "$(cat ../web-tasks/web-1.txt)"
```

The MiniMax search provider (`@deepseek-ai/dsh-web-search-minimax`) was
trimmed as out of v0 scope; the shipped `web-search-deepseek` /
`web-search-exa` / `web-search-perplexity` rows cover the search variant.

Verified here: the `web_search` tool is wired and called (session log shows
`web_search` tool calls); search itself is credential-blocked until a valid
provider key is supplied.
