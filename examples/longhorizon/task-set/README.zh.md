# 搜索任务集

[English](README.md) | 中文

四个针对性任务，在 `../task/` 的任务工作区上练习 demo 的工作区搜索能力（`glob` / `grep` / `read`）。每个任务都通过同一个带 demo overlay 的 long-horizon runner 运行；`--max-steps 15` 为每个任务设限。预期答案：

- `search-1` → 3 个文件（`01_basic.csv` 5 行、`09_basic.csv` 3 行、`11_basic.csv` 3 行）
- `search-2` → 只有 `README.md`（其不含 “todo” 的内容实际上没有 TODO；预期 “no matches” 或 README 行）
- `search-3` → `01_basic.csv` 与 `05_dup_of_01.csv`（字节完全相同）
- `search-4` → `08_large.csv`，2000 行，最后一行 `8 2000 row-2000 3000.0`

运行一个任务（从 `../task/`，即沙箱工作区）：

```sh
cd ../task
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml --max-steps 15 \
  "$(cat ../task-set/tasks/search-1.txt)"
```

## 网页搜索任务（`web-tasks/`）

demo overlay 禁用了 `web_search`；搜索变体 `search-overlay.cordis.yml` 保留它。随附的搜索 provider 各自需要自己的凭据环境变量：

| Provider 行 | 凭据环境变量 | 此处状态 |
|---|---|---|
| `web-search-deepseek`（默认） | `DEEPSEEK_API_KEY` | 无有效密钥 —— `WEB_PROVIDER_CREDENTIAL_MISSING` |
| `web-search-exa` | `EXA_API_KEY` | 未在 overlay 中挂载 |
| `web-search-perplexity` | `PERPLEXITY_API_KEY` | 未在 overlay 中挂载 |

运行一个网页任务（从 `web-run/` 以便工作区保持独立）：

```sh
cd web-run
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… DEEPSEEK_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/search-overlay.cordis.yml --max-steps 10 \
  "$(cat ../web-tasks/web-1.txt)"
```

MiniMax 搜索 provider（`@deepseek-ai/dsh-web-search-minimax`）作为超出 v0 范围被裁掉；随附的 `web-search-deepseek` / `web-search-exa` / `web-search-perplexity` 行覆盖搜索变体。

此处已验证：`web_search` 工具已接线并被调用（会话日志显示 `web_search` 工具调用）；在提供有效 provider 密钥之前，搜索本身受凭据阻断。
