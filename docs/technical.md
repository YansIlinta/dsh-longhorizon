# 技术与设计说明

本仓库是 `@deepseek-ai/dsh-longhorizon` v0（rc.5 快照 + 收尾）的技术文档。
配套入口见 [README](../README.md)，状态陈述见 [status.zh.md](status.zh.md)。

## 1. 总览

给 DeepSeek Harness headless 单任务运行加"长时程可靠闭环"：

- **durable 任务状态**：`longhorizon/state` 会话事件流（create/update/clear
  + revision），日志即单一事实源；任何运行状态都能从日志重放得到。
- **严格回放折叠**（`fold.ts`）+ `ctx.longhorizon` 服务（增删查、追加修订状态）。
- **循环守卫**（`controller.ts`）：步数预算、按工具连续失败峰值 → replan
  强制 → stalled。
- **模型可见 Task State 段**（`section.ts`）：目标/计划/事实/失败计数/预算，
  每步重渲染，防目标漂移与遗忘。
- **一次性 runner**（`runner.ts`）：create/resume → 播种快照 → 驱动 →
  completion gate（artifact 内容校验）→ 终态落盘 → 退出码 0/1/2/3 → 轨迹。
- **持久流 invariant**（`invariant.ts`）+ 可选 compaction 摘要种子（seed，
  缺失时优雅降级）。

## 2. 状态域（domain.ts / fold.ts）

`longhorizon/state` 事件携带 **revisioned 完整快照**：

| 事件 | 语义 |
| --- | --- |
| `create` | 首次创建任务状态（必须为流中第一个变更） |
| `update` | 更新快照全量字段，revision 递增 |
| `clear` | 清空任务状态（仅允许在既有快照之上） |

**回放规则（严格，违规即判失败）**：

- 拒绝 revision 缺口（例如 1 → 3 中间缺 2）；
- 拒绝过期 clear（clear 之后残留的旧 snapshot 再被增量 fold 时不得误判为
  revision gap）；
- 拒绝非 create 首变更。

**向后兼容解码**：新版本为后加字段提供确定性默认值（`taskRevision` 1、
`replanRequired` false、`planRevisionCount` 0、`requirements` 空），旧日志
不得因新字段而拒绝回放。

**派生事实（从不入快照）**：计划来自 todo 快照（稳定内容派生 id）、
`stepCount` 来自 step/start、失败计数（含 per-fingerprint 汇总、最近失败、
最近 outcome-unknown 效应）来自 tool/result。崩溃工具效应结果未持久化时，
harness 在 load-repair 标记 `TOOL_OUTCOME_UNKNOWN`，折叠层把它当"不确定
效应"——不算失败也不算成功，重试决定交给模型。

## 3. 循环守卫（guards.ts / controller.ts）

| 守卫 | 触发 | 动作 |
| --- | --- | --- |
| 步数预算 | `stepCount >= maxSteps`（默认 100） | 拒绝下一步 |
| 失败 replan | 某工具**连续**失败峰值 `>= failureLimit`（默认 3）且 replan 剩余 | 强制注入 replan 提示 |
| stalled | 连续失败峰值超限且 replan 次数 `>= replanLimit`（默认 3） | 停止运行，终态 stalled |

per-tool 追踪使单个持续失败的工具不会把整个运行拖死，同时不相关工具的成功
不会清除 replan 请求（本次快照语义；monorepo 后续版本在此基础上演进出
"计划变更验收"语义，见第 8 节）。

配置（controller 行）：`workspace`、`factsFile`（默认 `.run/facts.md`）、
`failureLimit`、`replanLimit`。

## 4. 一次性 runner（runner.ts）

生命周期：

1. `create` 或 `resume`（`resumeSessionId`）一个 agent；`longhorizon/state`
   播种或对 live 会话核验。
2. 安装 Task State 段与模型选择。
3. 驱动循环：`whenIdle` → 取快照 → 若错误或预算耗尽则结束；否则检查
   completion gate——产物未确认则向模型注入"继续"消息。
4. 终态推导：`error` / `done` / `budget-exhausted` / `stalled`，**在最终
   flush 之前** durable 落盘。
5. 退出码并写轨迹（`trajectoryPath`）。

### Completion gate（不可放宽）

- **`done` 仅在全部声明产物被确认时可达**：产物必须是**非空常规文件**
  （目录、空文件、缺失都不算）；配置了 `artifactVerify` 时，还需宿主侧
  校验命令**有界**（30s 超时）**退出 0**。
- 模型连续文本声称完成（consecutive text endings）**不再计入**完成条件。
- 未达 done 的结束在 stderr 打印未确认产物清单——绝不静默。
- 空产物配置回退到默认 `['REPORT.md']`，完成要求不因空配置被绕过。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | done（全部声明产物已确认） |
| 1 | error |
| 2 | 预算耗尽 |
| 3 | stalled |

## 5. Task State 段（section.ts）

- 模型可见输入，runner 按 agent 注册，每次 prompt 装配时从 durable 快照 +
  派生折叠 + workspace facts 文件重渲染。
- 展示：目标（不截断）、任务状态、当前计划、最近已验证进展、最近失败
  fingerprint、无进展计数、剩余预算。
- 容量封顶约 650 token；事件只在状态转移时追加，日志增长 O(transitions)。
- 快照/派生事实不变时，段文本不变，KV 缓存友好。

## 6. 持久流 invariant（invariant.ts）

伴随插件：对每个挂接会话的 `longhorizon/state` 流做增量重放，违反回放规则
（revision 缺口、非法首变更等）即判定日志失败。

## 7. Compaction 摘要种子（可选）

durable 任务事实应当跨 compaction 存活：宿主暴露 `registerSummarySeed`
钩子时，控制器用它把 目标/状态/预算 注入摘要种子。**npm 已发布版本尚未
导出该 API**，因此实现为 namespace 导入 + 运行时探测，缺失时优雅降级
（Task State 仍从 durable 状态重渲染）。引入新依赖 API 时必须保持此模式，
不允许静态具名导入未发布导出。

## 8. 与 monorepo 的关系

- 本仓 = `deepseek-ai/DeepSeek-Harness` `packages/longhorizon/longhorizon`
  v0（rc.5）快照 + 收尾（completion gate 收紧、seed 可选化、独立构建验证）。
- monorepo `longhorizon-v0` 分支继续演进出新语义（requirements/evidence
  验证证据、task revision 绑定、计划变更验收、stallSteps 无进展守卫、
  退出码语义扩展），尚未同步进本独立仓；同步时以 monorepo 为准，并保持
  本仓"纯发布依赖可构建"约束。

## 9. 已知限制

- 无 exactly-once 执行：崩溃后效应结果未持久化 → `TOOL_OUTCOME_UNKNOWN`，
  重试决策交给模型。
- 并发 resume 无运行级锁：durable log 仍是权威，严格折叠对分歧 fail loud。
- 校验只证明存在性 + 内容标识 + 命令退出码，不证明语义正确性。
- 折叠按需 O(log)，无缓存投影。