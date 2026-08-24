# AGENTS.md

面向开发者与 AI 代理的仓库指南。本仓库是 `@deepseek-ai/dsh-longhorizon` 的
独立快照：长时程 agent 任务的 durable 状态域 + 控制器 + 一次性 runner。

## 仓库地图

| 路径 | 职责 |
| --- | --- |
| `src/domain.ts` | `longhorizon/state` 事件类型、snapshot 语义、revision 解码默认值 |
| `src/fold.ts` | 严格回放折叠：create/update/clear → 快照；拒绝 revision 缺口/过期 clear |
| `src/guards.ts` | 纯决策逻辑：步数预算、按工具连续失败峰值 → replan 强制、stalled 判定 |
| `src/controller.ts` | `ctx.longhorizon` 服务 + 循环守卫插件行；可选 compaction summary seed |
| `src/section.ts` | 模型可见 Task State 段（每步重渲染，防目标漂移） |
| `src/runner.ts` | 一次性 runner：create/resume → 播种 → 驱动 → completion gate → 退出码 → 轨迹 |
| `src/invariant.ts` | 持久流 invariant 伴随插件（增量回放状态流） |
| `src/trajectory.ts` | 可读的 step-by-step 轨迹渲染 |
| `tests/` | vitest 套件：fold / service / 脚本化 happy-path / keyless boot |
| `docs/` | 技术设计（`technical.md`）与状态陈述（`status.zh.md`） |

## 基础命令

```sh
pnpm install          # 安装（lockfile 已提交，CI 用 --frozen-lockfile）
pnpm run build        # tsc -b && tsdown → lib/
pnpm test             # vitest run（当前 4 文件 / 25 用例全绿）
pnpm pack --dry-run   # 验证发布面（28 文件 tarball，含 LICENSE）
```

## 分支角色（重要）

- `main` — 唯一发布面：独立快照 + 收尾，可 `pnpm install && build && test`。
- `longhorizon-v0` — `deepseek-ai/DeepSeek-Harness` monorepo 的推送镜像
  （完整仓库树），不是独立包布局；不在此分支上开发独立仓内容。
- `v0-product-closure` — v0 收尾工作的归档线，内容已合入 `main`。

## 约定

- **构建与测试必须保持绿色**（`pnpm run build` + `pnpm test`）。改代码后
  必须本地跑通再提交；CI 也跑同一组命令。
- **durable log 是单一事实源**：`longhorizon/state` 事件流之外的任何状态
  都是派生事实。新增字段必须带向后兼容的解码默认值，旧日志不得因新字段
  而拒绝回放。
- **completion gate 不可放宽**：`done` 只允许在声明的 artifact 全部被确认
  （非空常规文件，必要时 host 校验命令有界退出 0）时可达。文本声称完成不
  算数；不要把"模型说完了"当作证据。
- **文档与代码同步**：改了 config 字段、退出码或事件语义时，更新
  `docs/technical.md` 与 README 的对应段落。
- **不要引入未发布的依赖 API**：本仓独立构建依赖 npm 已发布版本；对
  `@deepseek-ai/dsh-compaction-basic` 这类可能缺导出 API 的包，用
  namespace 导入 + 运行时探测（参考 `src/controller.ts` 的 seed 处理）。
- 不主动删除/翻译代码注释；保持 `@note` 风格注释原样。

## 文档导航

- [README.md](README.md) — 入口：简介、能力、快速开始、消费
- [docs/technical.md](docs/technical.md) — 设计：状态域、守卫、runner、退出码
- [docs/status.zh.md](docs/status.zh.md) — 状态陈述与验证记录