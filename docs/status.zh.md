# @deepseek-ai/dsh-longhorizon —— 当前状态陈述（v0 收尾）

> 2026-08-24：本文档自仓库根目录 `STATEMENT.zh.md` 移入 `docs/`（仓库整理）。
> 所有提交历史经 `git mv` 保留；技术设计见 [technical.md](technical.md)。

日期:2026-08-19 · 来源:`deepseek-ai/DeepSeek-Harness` monorepo `packages/longhorizon/longhorizon`
本文件是配合独立仓的简短状态声明;更早的 demo 陈述(2026-08-17)记录了第一版演进,此处只讲**当前**。

## 1. 这是什么

一个给 DeepSeek Harness headless 单任务运行加“长时程可靠闭环”的包:
- **durable 任务状态**:`longhorizon/state` 会话事件流(create/update/clear + revision),日志即单一事实源;
- **严格回放折叠**(`fold.ts`)+ `ctx.longhorizon` 服务(增删查、追加修订状态);
- **循环守卫**(`controller.ts`):步数预算、按工具连续失败峰值 → replan 强制 → stalled;
- **模型可见 Task State 段**(`section.ts`):目标/计划/事实/失败计数/预算,每步重渲染,防目标漂移与遗忘;
- **一次性 runner**(`runner.ts`):create/resume → 播种快照 → 驱动 → completion gate(artifact 内容校验)→ 终态落盘 → 退出码 0/1/2/3 → 轨迹;
- **持久流 invariant**(`invariant.ts`)+ **compaction 摘要种子**(`seed.ts`,保事实跨压缩不丢);
- **CLI 接线**:`--resume / --max-steps / --trajectory`(headless startup)。

## 2. 本轮“提到 v0”做了什么

| 项 | 结果 |
|---|---|
| 仓库审计 | 完成,列出产品模型 / P0–P2 / 冗余 |
| P0-1 resume/重启 | ✅ 修复:`longhorizon/state` 补进 `KNOWN_SESSION_EVENT_TYPES`(重生成 catalog),此前的重启会拒绝读日志 |
| P0-2 invariant | ✅ 修复:`clear` 后增量 fold 残留 snapshot 导致合法重建被判 revision gap(把 `applyChecked` 改纯函数) |
| P0-3 构建 | ✅ 修复:`region.ts` seedText 的 `exactOptionalPropertyTypes` 类型错误 |
| P0-4 示例输入 | ✅ 修复:task fixtures 权限 000 → 0644 |
| 测试 | ✅ 新增脚本化 happy-path 集成测试(create→completion gate→done→exit 0→落盘→轨迹) |
| 独立打包 | ✅ `npm run build`(tsc+tsdown)、`npm pack` 干净 28 文件(含 LICENSE) |
| 删减 | ✅ 移除 `web-search-minimax`(v0 范围外) |
| GitHub 工作流 | ✅ 新增 `longhorizon.yml`(独立 build+test+pack 验证) |

## 3. 验证结果（照实分三档）

- ✅ **已验证**:55 处单测全绿;关键路径实跑——无 key 故障边界 exit 1、`--resume` 续跑、`--trajectory` 真实步数、非法 `--max-steps` 拒绝、`sh verify.sh` artifact 校验闭环;独立 `pnpm install` 成功。
- 🔒 **静态确认 / 环境受限**:真实 LLM happy path(本沙箱无 `OPENCODE_GO_API_KEY` 且 bash 沙箱 `SANDBOX_UNAVAILABLE`);仓库级 `tsc -b tsconfig.host.json` / `publint` / `verify-scoped-events` 因 ~1GB 内存 OOM 未能完整跑(单包 typecheck/lint 全过)。
- ⛔ **确认的阻塞**(非 mock):独立包对公共 npm 依赖编译只差一处——
  `@deepseek-ai/dsh-compaction-basic` 尚未发布 `registerSummarySeed` / `summarySeedFor`(仓库内新增,未随 0.1.0-rc.7 发布)。

## 4. 独立打包现状

- **monorepo 内**(deepseek-ai 仓库,账号 READ-only 无法直接 push):`packages/longhorizon/longhorizon`,真实构建产物 + 发布面齐备。
- **独立仓**:本仓 = 抽取出的独立源码快照,已推送到 `github.com/YansIlinta/dsh-longhorizon`。
- **tarball**:`npm pack` 生成 `deepseek-ai-dsh-longhorizon-0.1.0-rc.5.tgz`(27 文件;整理后含 LICENSE 为 28 文件)。
- **独立构建门槛**:待 `dsh-compaction-basic` 发布 seed API 后,本仓即可 `pnpm install && pnpm run build && pnpm test`。

## 5. 遗留/下一步

1. 在有权环境推送 monorepo 分支 `longhorizon-v0`(commit `08fbbbae53`),或由维护者合并/发布 `longhorizon` 与 `compaction-basic` seed。
2. seed API 发布后:本独立仓 `pnpm run build` 应为绿,然后可按需发版。
3. 真实 LLM end-to-end + 完整仓库门禁需在正常内存、带 key/沙箱的机器复核。

## 6. 补充(2026-08-21):独立仓验证闭环完成

`v0-product-closure` 分支(已在 README 记录)完成后,本独立仓做了第一次**纯发布依赖**的
fresh 验证,结果全绿:

- **seed 可选化生效**:`controller.ts` 改为 namespace 导入 + 运行时探测
  `registerSummarySeed`,缺失时优雅降级。实测解析到 `dsh-compaction-basic@0.1.0-rc.8`
  (仍无 seed 导出),`tsc -b` 类型检查零错误——独立构建阻塞根因解除。
- **补齐 devDependencies**(原快照缺 `tsdown`,且测试的 `@deepseek-ai` 测试包未声明):
  新增 `tsdown ^0.22.2` 与 `@deepseek-ai/dsh-agent-loop(-testkit)`、
  `dsh-llm-deepseek`、`dsh-session-checkpoint-policy`、`dsh-session-persistence-jsonl`、
  `dsh-system-prompt`(均 `^0.1.0-rc.6`),全部仅测试/构建期使用。
- **实测结果**:`pnpm install`(腾讯镜像)→ `pnpm run build`(`tsc -b && tsdown`,
  产出 5 个 lib bundle)→ `pnpm test`(4 文件 / 25 用例全过:fold 16、service 3、
  happy-path 5、keyless boot 1)→ `npm pack` 28 文件(含 LICENSE)tarball 干净。
- 此轮改动已并入 `main`(FF 合并自 `v0-product-closure` + 本段前的修复提交)。

仍遗留:真实 LLM end-to-end(需 key/沙箱)、monorepo 上游合并/发布。

## 7. 许可

MIT
