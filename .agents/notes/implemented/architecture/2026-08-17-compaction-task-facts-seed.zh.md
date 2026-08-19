# Agent Note: task-facts 种子让持久的任务事实跨压缩存活

Status: implemented

[English](2026-08-17-compaction-task-facts-seed.md) | 中文

## 问题

长时程压缩会总结会话 surface 中较旧的区域；被截断的区域可能丢掉压缩后的运行继续所需的那些事实（目标、状态与早期步骤的学习），加重上下文爆炸与丢失早期信息的失败模式。LongMemEval 类证据（前缘报告）量化了持续交互记忆上约 30% 的准确率下降。

## 决策

在 `@deepseek-ai/dsh-compaction-basic` 中增加一个单向的摘要种子接缝：`registerSummarySeed(provider)` + `summarySeedFor(session)`。`region.ts` 的 `buildSummarizationInput` 在压缩指令之前，把折叠后的种子作为一个框架化的 `<task-state>` 用户消息注入，因此摘要器重新派生出持久事实，而不是让它们丢失在截断窗口里。`@deepseek-ai/dsh-longhorizon` 注册一个 provider（在控制器的 `apply` 中通过 `ctx.effect`），从持久的 `longhorizon/state` 快照与 evidence 流折叠出运行的目标/状态/修订号/步骤预算，以及必需条件是否已验证。依赖方向是单向的：`longhorizon → compaction-basic`；`compaction-basic` 不依赖 `longhorizon`。对于没有 longhorizon 快照的会话，该 provider 不贡献任何内容，因此 harness 的其他用途不受影响。

（`web-search-minimax`，那个一度随该种子一起发布的 MiniMax 搜索 provider，已再次移除——超出 v0 范围。）

## 后果

- 压缩后的运行重新派生面向验证的事实（哪些必需条件仍未验证），而不是从截断窗口重新学习。
- 该种子是机制层面的确定性保证；它钉住的是事实的存活，而不是某个模型准确率数字。三级 warn/auto/hard 压缩阶梯或连续失败断路器仍未交付——两者都推迟为向后兼容的 opt-in 后续（它们会触碰一个被重度固定核心包的触发路径）。

## Alternatives considered

- 仅依赖摘要器从幸存的 surface 推断目标/状态：已否决——那正是截断会加重的有损路径；种子让存活变成结构性保证。
- 把单独的 `longhorizon/facts` 事件作为种子来源：暂缓——持久的快照 + evidence 流已经重建已验证状态，因此种子没有额外的写入者需要保持同步。

## Testing

- `packages/compaction/compaction-basic/tests/seed.spec.ts`（注册表语义）与 `tests/eval/eval.spec.ts`（带标签的事实有种子时存活、无种子时全部丢失，合成子集 8/8 保留）。
- 完整的 compaction + longhorizon + web + headless 套件保持绿色（498 个测试）；lint 干净。

## Risks

- 种子文本按会话注入在压缩指令之前；过大的种子会牺牲 KV-cache 连续性——provider 必须让自己的贡献保持小巧（longhorizon 种子是一条目标、一个状态、一个修订号、步骤预算和一行已验证/未验证）。
