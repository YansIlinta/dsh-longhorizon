# longhorizon/ —— 验证过的 long-horizon 智能体控制层

[English](README.md) | 中文

持久的任务状态、步骤预算、失败/无进展/重规划守卫，以及面向模型的 Task State 小节，用于长时程智能体运行。运行自身的事实（目标、状态、修订号、requirements、重规划控制状态）位于持久的 `longhorizon/state` 会话事件中；计划、步骤计数、失败计数与验证 evidence 在渲染时从基础会话日志派生，因此日志始终是唯一的真实来源。**模型提出进展；只有当前 task revision 下每个必需 requirement 都通过宿主侧的验证 evidence，运行才能判定为 `done`。** 只用文本说 “done” 永远不会完成任务。

| 包 | 角色 | 挂载 |
|---|---|---|
| `longhorizon/` | 状态域（事件、fold、`ctx.longhorizon` 服务） | 默认导出 |
| `longhorizon/controller` | 循环守卫：预算、失败/无进展重规划、重规划接受 | 子路径行 |
| `longhorizon/runner` | 一次性驱动器：创建/恢复、验证、完成门槛、退出码 | 子路径行 |
| `longhorizon/invariant` | 持久流不变量伴生插件 | 子路径行 |

## 安装

这是 DeepSeek Harness monorepo 的工作区包。在检出中：

```sh
pnpm install
# Build the publishable lib surface (the repo host build also covers it):
pnpm exec tsc -b packages/longhorizon/longhorizon
pnpm exec tsdown --config packages/longhorizon/longhorizon/tsdown.config.ts
```

消费者按包名挂载这些行：

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

## 快速开始

从工作区目录，使用随附的 headless profile：

```sh
node --import tsx/esm <repo>/apps/cli/src/bin.ts --profile headless \
  --patch <repo>/examples/longhorizon/overlay.cordis.yml \
  "Repair the pipeline and write REPORT.md"
```

恢复与预算：

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

## 测试与构建

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

- **面向模型的输入：** “Task State” 提示词小节，由 runner 按 agent 注册，每次提示词组装时根据持久快照加上派生的计划/步骤/失败/requirement 折叠与工作区 facts 文件重新渲染。它展示目标（绝不截断）、任务状态、当前 task revision、逐 requirement 的验证状态、当前计划、最近的已验证进展、最新的失败指纹、no-progress 计数器、剩余步骤预算，以及完成资格行（仅当每个必需条件都被验证时为 `ALLOWED`）。每次请求的系统提示词被日志的 `request/header` 捕获，因此该小节可从日志重建。
- **Token 影响：** 小节有上限（约 650 token：8 行计划、6 行 requirement、12 行 facts、120 字符行裁剪）。控制器只在转换时追加 `longhorizon/state` 事件（状态变化、重规划请求/接受），evidence 事件只在结果或内容变化时追加，因此日志增长保持在 O(transitions)。
- **KV-cache 影响：** 小节只在快照或派生事实变化时改变；稳定的运行跨请求渲染相同的小节文本。

## 配置

`longhorizon/controller`：

| 字段 | 默认 | 含义 |
|---|---|---|
| `workspace` | `process.cwd()` | facts 文件解析所依据的工作区根 |
| `factsFile` | `.run/facts.md` | 相对工作区的 facts 文件路径 |
| `failureLimit` | `3` | 触发一次重规划请求的按工具连续失败峰值 |
| `replanLimit` | `3` | 运行判定停滞前的重规划请求数 |
| `stallSteps` | `6` | 触发一次重规划请求的无已验证进展的连续步数 |

`longhorizon/runner`：`task`（必填）、`resumeSessionId`、`maxSteps`（100）、`trajectoryPath`、`workspace`、`artifacts`（`['REPORT.md']`）、`artifactVerify`（可选 argv，宿主侧运行；变成一个 command requirement）、`requirements`（可选显式 requirement 声明——在 `artifacts`/`artifactVerify` 之上的增量面）、`factsFile`。

Requirement 形式：

```ts
{ id: 'artifact:REPORT.md', description: 'Produce artifact REPORT.md', required: true,
  verifier: { type: 'artifact', path: 'REPORT.md' } }
{ id: 'command:verify', description: 'Host verification command passes', required: true,
  verifier: { type: 'command', command: ['sh', 'verify.sh'] } }
```

退出码：`0` done（当前修订下每个必需条件都验证通过）· `1` error · `2` 预算耗尽 · `3` 停滞。非 `done` 结束的运行会把未验证的必需条件打印到 stderr——绝不会静默。

## 持久状态

`longhorizon/state` 事件携带修订版完整快照（`create`/`update`/`clear`），对 v1 之后新增的字段有确定性解码默认值（`taskRevision` 1、`replanRequired` false、`planRevisionCount` 0、`requirements` 空）。严格回放 fold 拒绝修订缺口、过期 clear 与非 create 的首个变更。

`longhorizon/evidence` 事件携带每个 requirement 在每个 task revision 上的一次宿主侧验证检查（产物存在 + 普通文件 + 大小 + SHA-256 内容身份，或 command argv 的退出码）。Evidence 绑定 `requirementId` + `taskRevision`：旧修订的 evidence 从不计入当前修订。只有当每个必需 requirement 在当前修订都有通过的 evidence 时才能达到 `done`。

派生事实（从不存储于快照）：来自 `todo/write` 快照的计划（稳定内容派生步骤 id）、来自 `step/start` 的 `stepCount`、来自 `tool/result` 的失败计数器（含逐指纹总计、最新失败与最近效果未知项）、来自 `longhorizon/evidence`/`todo/write` 进展标记的 no-progress，以及来自模型对 facts 文件已记录文件写入的事实。崩溃的工具效果其结果从未持久化时，宿主会在加载修复时将其标记为 `TOOL_OUTCOME_UNKNOWN`；fold 会把它呈现为不确定效果——既不是失败也不是成功——因此控制器把重试决定留给模型。

不变量伴生插件会增量回放每个已附加会话的 `longhorizon/state` 与 `longhorizon/evidence` 流，并在违反时使日志失败，包括针对未知 requirement 或未来修订的 evidence。

## 重规划与 task revision 语义

- 重规划请求是**持久的**（快照中的 `replanRequired: true`），跨重启存活，并在重复的按工具失败或一段无进展期被发出。无关的成功工具结果永远不会清除它。
- 只有观察到**内容实质不同**的计划时才清除：对有序计划内容做确定性 SHA-256 摘要（状态翻转不计）。接受会使 `planRevisionCount` 递增、提升 `taskRevision`，并使上一修订的 evidence 作废（宿主会在下一个空闲驱动轮重新验证）。
- 已完成的/出错的/停滞的/预算耗尽的快照通过 `--resume` 恢复时，报告并以**零额外 agent 轮次**退出。

## 已知限制与推迟工作

- Task State 小节从工作区 facts 文件组装；facts 的出处是记录在案的写入/编辑工具调用（且小节文本按请求被 `request/header` 捕获），但还没有专门的 `longhorizon/facts` 事件——面向模型的 `remember` 工具被推迟。
- **没有 exactly-once 执行。** 效果产生后、持久结果落盘前崩溃会使效果结果未知；宿主在加载修复时将其标记为 `TOOL_OUTCOME_UNKNOWN`，本包将其折叠为“不确定效果”——呈现给模型，绝不视为成功，也绝不视为失败，并在恢复时由宿主侧重新验证。重试决定留给模型而不是由控制器捏造。
- **本包不解决同一运行的并发恢复。** 两个进程恢复同一运行可以同时驱动它；持久日志仍是权威，严格 fold 会在分歧时大声失败，但没有运行级锁。
- 验证只证明存在 + 内容身份 + 命令退出码；产物内容的语义正确性超出 V1 范围，属于 command/自定义 verifier。
- 控制器按需 fold（每次组装 O(log)）；在出现消费者之前，缓存投影被推迟。
- 没有声明 requirements 的遗留快照无法达到 `done`（空必需集不是 evidence）；runner 会大声拒绝驱动它。
