# Agent Note: longhorizon 运行器的验证完成与持久控制状态

Status: implemented

[English](2026-08-19-longhorizon-verified-completion.md) | 中文

## 问题

v0 longhorizon 运行器只要模型连续两次以纯文本结尾（`textEndings >= 2`）或没有文件缺失（`missing.length === 0`），就能以退出码 0 把运行判定为 `done`。完成权威是 LLM 自己的“完成”声明而不是 verifier 证据，因此即使产物不存在或宿主验证命令失败，运行仍可能报告成功。重规划只是一条 prompt nudge，靠一个 `WeakMap` 标志支撑，重启后系统就忘记是否有待处理的重规划。

## 决策

`@deepseek-ai/dsh-longhorizon` 现在把一条完成不变量——**每个必需 requirement 必须在当前 task revision 持有通过的验证证据**——作为进入 `done` 的唯一路径：

- **Requirements** 由运行器配置映射而来（`artifacts` → artifact verifier，`artifactVerify` → command verifier，`requirements` 用于显式声明），并存入持久 snapshot。
- **`longhorizon/evidence`** 是一个新的持久会话事件，携带一次宿主侧检查（产物存在 + 普通文件 + 大小 > 0 + SHA-256 内容身份，或 command argv 的退出码），绑定 `requirementId` + `taskRevision`。旧 revision 的证据永远不能证明新 revision。结果发生变化的检查会去重，使事件流保持在 O(transitions)。
- **Task revision** 是持久的，在接受 plan revision（以及 requirement/objective 变更）时递增，并使旧证据作废、进入重新验证。
- **Replan 请求**是持久的（snapshot 中的 `replanRequired`），只有观察到内容实质不同的 `todo_write` 计划才会清除——对有序计划内容做确定性 SHA-256 摘要比较；仅改写状态或无关的工具成功都不会清除。接受会使 `planRevisionCount` 递增并提升 revision。
- **No-progress 检测**统计“没有新证据或计划步骤完成”的连续步数，与工具报错次数区分开来，并汇入同一条持久 replan 请求路径。
- **被恢复的终态** snapshot（done/error/stalled/budget-exhausted）直接报告并以零额外 agent 轮次退出。
- **轨迹写入**原子化（临时文件 + rename），并携带 revision、证据与完成原因。

## 后果

- LLM 不再能直接把任务转为 `done`；产物缺失时仅以纯文本声称“Done”的运行会以 `budget-exhausted`（退出码 2）结束，并在 stderr 上报未验证的必需条件。
- `longhorizon/evidence` 已加入生成的 `KNOWN_SESSION_EVENT_TYPES` 词汇表（重新生成 `packages/core/session/src/known-event-types.ts` 与 `docs/persistence-catalog.md`），持久化的证据能通过协调器的加载门槛在重启后存活。
- 弃用 `WeakMap` 控制器运行时；持久 snapshot 是唯一的重规划权威，Task State 小节渲染 `snapshot.replanRequired`。

## Alternatives considered

- 只在收尾时（结束前一次性）做宿主验证，而不是每次空闲驱动轮都做：已否决——它无法在旧证据通过后再捕获“产物内容被修改”（hash 漂移），而空闲时的反复检查可免费发现。
- 在 snapshot 中保存计划指纹，而不是从事件流折叠参考计划：已否决——参考计划完全可由持久事件重建（arm 状态事件之前的 `todo/write`），额外的持久字段只会增加不一致风险。
- 允许任意新的 todo write 清除 `replanRequired` 重规划：已否决——仅改写状态不能掩盖一个卡住的计划。
- 空/遗留的 requirement snapshot：完成门槛拒绝 `done`（空必需集不是证据），运行器也会大声拒绝驱动被恢复的遗留 snapshot，而不是静默重新解释。

## Testing

- `tests/verified-completion.spec.ts` —— 失败矩阵：虚假完成（A）、command verifier 失败（B）、验证完成（C）、零 agent 轮次的恢复（D）、重启后重规划仍然存活（E）、无关工具成功不清除重规划（F）、计划修订接受（G）、产物 hash 漂移（J）。
- `tests/fold.spec.ts` —— 严格 revision 缺口拒绝（H）、证据 revision 绑定（I）、计划摘要 / 接受重规划、no-progress 测量、失败指纹。
- `tests/coverage.spec.ts` —— fail-loud 解码矩阵、宿主 verifier 边界情形、小节裁剪、原子轨迹写入。
- `tests/service.spec.ts` + `tests/happy-path.spec.ts` + `tests/boot.spec.ts` 在新的完成权威下保持绿色。

## Risks

- 宿主验证在每次空闲驱动轮重复运行；command verifier 每次空闲会派生一个有界（30 秒）子进程，超大产物会整体哈希。
- 本包不解决同一运行被两个进程并发恢复（已记为已知限制）；持久日志仍是权威，严格的 fold 会在分歧时大声失败。
- 不宣称 exactly-once：效果产生后、持久结果落盘前崩溃，效果结果未知。宿主持久加载修复时会把这类效果标记为 `TOOL_OUTCOME_UNKNOWN`；本包将其折叠为不确定效果并向模型呈现，而不是伪造失败或成功。
