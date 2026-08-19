# Long-Horizon 智能体 Demo（产品栈）

[English](README.md) | 中文

在随附的 headless profile 上的一次真实 LLM long-horizon 运行，由产品包 `@deepseek-ai/dsh-longhorizon` 驱动（持久任务状态、步骤预算、失败/重规划守卫、Task State 小节、runner、流不变量）。本 leaf 只保留组合、persona 与 demo 任务；行为由包拥有并测试。

## 运行

前置条件：已构建或从源码启动的 `dsh`（在本次检出中使用 `node --import tsx/esm apps/cli/src/bin.ts`）、`python3`，以及环境里 harness 可路由的模型密钥（例如配合 pi-ai `opencode-go` profile 的 `OPENCODE_GO_API_KEY`，或 DeepSeek 密钥）。

```sh
cd task
DSH_HOME=<repo>/examples/longhorizon/.dsh-home OPENCODE_GO_API_KEY=… \
  node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml \
  "Repair the pipeline so all 12 files are processed successfully, then write REPORT.md (per-file results + what was fixed) and verify by rerunning."
```

runner 先打印 `run session: <id>`，然后是最终回答。退出码：`0` done · `1` error · `2` 步骤预算耗尽 · `3` 停滞。

## 恢复、预算、轨迹

```sh
# resume an interrupted run
… --resume <session-id> "finish the job"
# hard step cap (stops with exit 2 at the cap)
… --max-steps 10 "<task>"
# readable step-by-step trajectory
… --trajectory ../out.md "<task>"
```

## 检查一次运行

- `task/.sessions/<id>/session.jsonl` —— 完整的持久日志，包括 `longhorizon/state` 快照流（事实来源；可从包的 fold 回放）。
- `task/.run/facts.md` —— 模型选择持久化的事实。
- `task/REPORT.md` + `task/pipeline.out` —— 生成产物。
- `sh verify.sh` —— 宿主侧产物验证（作为 runner 的 `artifactVerify` 接线，因此完成门槛只接受被验证的报告）。

## 产品 vs 本 leaf

| 面 | 位置 |
|---|---|
| 持久状态域（`longhorizon/state` 事件、fold、`ctx.longhorizon`） | `packages/longhorizon/longhorizon` |
| 控制器（预算 / 重规划守卫 / 共享运行时） | 同包，`./controller` |
| Runner（驱动、完成门槛、退出码） | 同包，`./runner` |
| 流不变量 | 同包，`./invariant`（由诊断工具挂载，不在本 overlay 中） |
| 组合 + persona + 任务 | 本 leaf |

Task State 小节是从持久快照加上派生 fold 组装的面模型可见内容；每次请求的系统提示词（含该小节）被日志的 `request/header` 捕获。

## 搜索变体

`search-overlay.cordis.yml` 为网页搜索任务保留 `web_search`（见 `task-set/`）。随附的搜索 provider 各自需要自己的凭据环境变量（`DEEPSEEK_API_KEY` / `EXA_API_KEY` / `PERPLEXITY_API_KEY`）——没有凭据时，`web_search` 报告 `WEB_PROVIDER_CREDENTIAL_MISSING`。

## 开发与测试

产品行为位于包内，而不是本 leaf：

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

`task/data/` 下的任务夹具由 `python3 pipeline.py` 读取；运行 `sh verify.sh` 可在没有模型的情况下本地检查 REPORT.md 完成门槛。
