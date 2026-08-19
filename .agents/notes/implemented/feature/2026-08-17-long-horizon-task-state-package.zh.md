# Agent Note: 持久的 long-horizon 任务状态与控制器包

Status: implemented

[English](2026-08-17-long-horizon-task-state-package.md) | 中文

## 问题

长时程智能体运行（几十步、plan/replan、中断后恢复）在 harness 中没有持久的任务状态面。会话日志携带轨迹，goal 域携带目标，但没有任何东西拥有运行自身的事实：状态、步骤预算、重规划次数、计划与失败历史。此前的 demo 把这一层实现为工作区 sidecar（`examples/longhorizon/runtime`、`task-state.json`），那不是产品面。

## 决策

一个产品包 `packages/longhorizon/longhorizon`（`@deepseek-ai/dsh-longhorizon`），包含四个入口：

- `.` —— 持久状态域：携带修订版完整快照（`create`/`update`/`clear`）的 `longhorizon/state` 会话事件、严格回放 fold（拒绝修订缺口、过期 clear、非 create 的首个变更）、requirement/evidence 词汇（`longhorizon/evidence`），以及 `ctx.longhorizon` 服务（`view`/`snapshot`/`append`/`clear`/`appendEvidence`）。
- `.` 还导出面向 agent 的 “Task State” 提示词小节安装器。该小节在每个 agent 安装时注册（组装上下文不携带会话），每一步都从快照加上派生的 fold 重新渲染，并被每次请求的 `request/header` 捕获。
- `./controller` —— 一个函数插件，接线循环守卫：步骤预算拒绝、按工具的连续失败与 no-progress 重规划请求（快照中的持久 `replanRequired`）、在内容实质不同的 `todo_write` 计划上接受重规划，以及停滞停止。转换作为快照更新追加。
- `./runner` —— 一次性驱动器：创建/恢复、播种快照与 requirements、驱动验证完成（只有当前修订下所有必需 evidence 通过才判定 `done`）、在最终 flush 前提交最终状态，并以状态码 `0`/`1`/`2`/`3`（done/error/budget/stalled）退出。
- `./invariant` —— 对 state 与 evidence 两条流都生效的持久流不变量伴生插件，由诊断工具安装（产品 profile 中不存在 `invariants` 服务）。

## 后果

- 完成权威是宿主的验证 evidence，而不是模型的文本断言；产物缺失时仅以纯文本声称 “done” 的运行会以 `budget-exhausted`（退出码 2）结束，并在 stderr 上报未验证的必需条件。`WeakMap` 控制器运行时已移除——持久快照是唯一的重规划权威。
- `longhorizon/evidence` 已加入生成的 `KNOWN_SESSION_EVENT_TYPES` 词汇（见持久化目录重新生成），因此持久化的 evidence 能通过持久化协调器的加载门槛在重启后存活。
- 计划、步骤计数、失败计数器、no-progress 与 evidence 都在渲染时从日志派生；快照从不复制它们。事实保留在模型写入的 `.run/facts.md`（目前还没有 `longhorizon/facts` 事件——面向模型的 `remember` 工具被推迟），也还没有 `session-projection` 单元；fold 就是查询面。

## Alternatives considered

- 用工作区 sidecar（`task-state.json`）而不是持久流：已否决——sidecar 不是产品面，也无法回放。
- 在快照中存储计划/步骤/失败事实而不是从日志派生：已否决——日志是它们唯一的真实来源，快照应保持小巧。

## Testing

- `packages/longhorizon/longhorizon/tests/` —— 67 个无密钥测试：严格 fold 语义、派生 fold、守卫阈值、小节与轨迹渲染、真实 `SessionStore` 上的 service CAS、真实组合引导（service + controller + runner + JSONL 持久化，无密钥），以及[验证完成失败矩阵](../architecture/2026-08-19-longhorizon-verified-completion.md)（虚假完成、command verifier、零 agent 轮次的恢复、重规划存活、产物 hash 漂移）。
- 通过 `examples/longhorizon/overlay.cordis.yml` 的真实模型 profile 运行产生了 `longhorizon/state` create+update 流与 budget 退出码 2。
- 示例 leaf 消费该包；行为测试位于包内。`startup.ts` 的标志（`--resume`/`--max-steps`/`--trajectory`）原样服务于这一面。

## Risks

- 小节按 agent 注册；同一进程中的多个 long-horizon agent 各自渲染自己的小节（作用域隔离），每次组装 O(log) fold。
- `invariant` 入口绝不能在产品 profile 中安装（那里没有 `invariants` 服务）。
- 宿主验证在每个空闲轮重复执行；没有 exactly-once 保证，也不解决同一运行的并发恢复（见[验证完成架构 note](../architecture/2026-08-19-longhorizon-verified-completion.md)）。
