# src/ — 模块地图

| 文件 | 职责 |
| --- | --- |
| `index.ts` | 包入口：默认导出状态域插件行（`ctx.longhorizon` 服务） |
| `domain.ts` | `longhorizon/state` 事件类型、快照语义、revision 向后兼容解码默认值 |
| `fold.ts` | 严格回放折叠：事件流 → 快照（拒绝 revision 缺口/过期 clear/非 create 首变更） |
| `guards.ts` | 纯决策逻辑：预算拒绝、失败 replan 强制、stalled 判定（无副作用，便于单测） |
| `controller.ts` | 循环守卫插件行：挂 `ctx.longhorizon`、facts 文件、可选 compaction seed |
| `section.ts` | Task State 段装配：从快照 + 派生折叠渲染模型可见文本 |
| `runner.ts` | 一次性 runner 插件行：create/resume → 驱动 → completion gate → 退出码 |
| `invariant.ts` | 持久流 invariant 伴随插件（增量回放，违规 fail loud） |
| `trajectory.ts` | 轨迹渲染（step-by-step markdown，`trajectoryPath` 落盘） |
| `types.ts` | 跨模块共享类型 |
| `verification.ts` | （monorepo 后续版本的验证证据；本快照尚未包含） |

## 依赖方向

```
guards / fold / domain     ← 纯层，无 Cordis 依赖
section / trajectory       ← 消费 fold/domain
controller / runner / invariant   ← 插件行，注入 Cordis 上下文
```

## 约定

- 插件行导出 `name` + `Config`（schemastery）+ `apply(ctx, config)`；
  服务通过 `ctx.get()` 读取可选服务，硬依赖用 `inject` 声明。
- 新事件字段必须带解码默认值（见 `domain.ts`）。
- 对可能缺导出的依赖 API 用 namespace 导入 + 运行时探测
  （见 `controller.ts` 的 seed 处理）。