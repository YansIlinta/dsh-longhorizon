<div align="center">

# @deepseek-ai/dsh-longhorizon

**Long-horizon reliable loop // 长时程可靠闭环**

DeepSeek Harness 长时程 agent 任务的可靠运行层：durable 任务状态、步数预算、
失败/replan 守卫、模型可见 Task State 段，以及带宿主侧 completion gate 的
一次性 runner。

[![License](https://img.shields.io/github/license/YansIlinta/dsh-longhorizon)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=node.js&logoColor=white)](.nvmrc)
[![Package](https://img.shields.io/badge/package-%40deepseek-ai%2Fdsh--longhorizon-blue)](package.json)

</div>

## 项目简介

长时程 agent 任务（数十到上百步）最大的失败模式是：目标漂移、遗忘事实、
死循环、以及"模型声称完成"但产物缺失。本包把运行的事实放进 durable
会话事件流（`longhorizon/state`），日志即单一事实源；控制器在每一步强制
预算与 replan 守卫；Task State 段把目标/状态/失败/预算持续渲染给模型；
runner 只有在全部声明产物被宿主侧确认后才允许 `done`——**模型在文本里
说"完成了"永远不算完成**。

这是 `deepseek-ai/DeepSeek-Harness` monorepo 中
`packages/longhorizon/longhorizon` 的独立快照，可独立安装、构建、测试、
打包，作为 Harness 插件包按行挂载消费。

## 状态

- ✅ **独立验证全绿（2026-08-21）**：`pnpm install` → `pnpm run build`
  （`tsc -b && tsdown`）→ `pnpm test`（4 文件 / 25 用例）→ `npm pack`
  （28 文件 tarball，含 LICENSE），全部在纯发布依赖下通过。
- 🟡 真实 LLM end-to-end 与上游合并/发布仍未做（需要 key/沙箱与上游权限）。
- 详细记录见 [docs/status.zh.md](docs/status.zh.md)。

## 核心能力

| 模块 | 说明 |
| --- | --- |
| Durable 任务状态 | `longhorizon/state` 会话事件流（create/update/clear + revision 解码默认值），日志即单一事实源 |
| 严格回放折叠 | `fold.ts` 把事件流折叠为快照：拒绝 revision 缺口、过期 clear、非 create 首变更 |
| 循环守卫 | 步数预算拒绝、按工具连续失败峰值 → replan 强制 → stalled，纯决策逻辑（`guards.ts`） |
| Task State 段 | 目标/状态/失败计数/预算每步重渲染给模型，防目标漂移与遗忘（约 650 token 上限） |
| 一次性 runner | create/resume → 播种 → 驱动 → **completion gate**（产物非空常规文件 + 可选有界校验命令）→ 退出码 0/1/2/3 → 轨迹落盘 |
| 持久流 invariant | 增量回放状态流，违规即失败日志（`invariant.ts` 伴随插件） |
| 独立打包 | 单仓 `pnpm install && pnpm run build && pnpm test`，与 monorepo 工具链解耦 |
| 可选 compaction seed | `registerSummarySeed` 缺失时优雅降级（namespace 导入 + 运行时探测），不阻塞构建 |

## 快速开始

```sh
pnpm install          # lockfile 已提交，CI 用 --frozen-lockfile
pnpm run build        # tsc -b && tsdown → lib/
pnpm test             # vitest run
pnpm pack --dry-run   # 验证发布面
```

## 使用

本包是 Harness 插件包，不是独立 CLI——由 Harness/dsh 启动器按行挂载：

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

runner 配置：`task`（必填）、`resumeSessionId`、`maxSteps`、`trajectoryPath`、
`workspace`、`artifacts`、`artifactVerify`（宿主侧校验命令，有界 30s；设置了
它之后产物还需其退出 0 才算确认）、`factsFile`。

退出码：`0` done（全部声明产物已确认）· `1` error · `2` 预算耗尽 ·
`3` stalled。未达 done 的结束会在 stderr 打印未确认产物清单——绝不静默。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/technical.md](docs/technical.md) | 设计：状态域、折叠语义、守卫、runner 生命周期、退出码 |
| [docs/status.zh.md](docs/status.zh.md) | 状态陈述与验证记录（原 STATEMENT） |
| [AGENTS.md](AGENTS.md) | 仓库指南：地图、命令、约定、分支角色 |
| [CONTRIBUTORS.md](CONTRIBUTORS.md) | 贡献者与来源说明 |

## 仓库结构

```
src/        状态域 + 折叠 + 守卫 + 控制器 + 段 + runner + invariant + 轨迹
tests/      vitest 套件（fold/service/happy-path/boot）
docs/       技术设计与状态陈述
.github/    CI（build · test · pack 验证）
```

## 分支角色

- `main` — 唯一发布面，独立仓内容开发于此。
- `longhorizon-v0` — monorepo 的推送镜像（完整仓库树），dev-only。
- `v0-product-closure` — v0 收尾归档线，已合入 `main`。

## License

MIT — 见 [LICENSE](LICENSE)。上游来源：deepseek-ai/DeepSeek-Harness。