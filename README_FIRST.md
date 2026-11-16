# 从这里开始（VIVIC 团队协作仓库）

> 本仓库是 VIVIC 的团队协作基线：**服务器后端部署基线对应的源码 + 当前可取得的 Web 可编辑源码 + MOSS-Live 方向的全双工阶段成果**。服务器 2026-11-08 Web release 的部分内容只有构建产物，没有完整可编辑源码，不属于本仓库可重建范围。
> 仓库：`Bruce-Yii/vivic-team`（Private）。原仓库 `Bruce-Yii/vivic` 保持不动，仅作历史与研发溯源。

## 1. 这个仓库包含什么

| 部分 | 内容 | 状态 |
| --- | --- | --- |
| Web 前端 | `apps/web`（React + Vite + Hark UI） | 可构建、可启动 |
| 本地后端 | `apps/local-api`（Hono + Hosted Tasks + Space SQLite） | 可启动、typecheck 通过 |
| 全双工语音 | `apps/web/src/ai/{fullDuplex,turnTaking,vad,asrGatewayClient}.ts` + `apps/local-api/src/asrGateway*.ts` | **阶段成果，未通过产品级验收** |
| 共享契约 | `packages/contracts`、`packages/card-runtime` | 稳定 |
| 移动端 | `apps/android`（Java WebView 壳）、`contrib/mobile-console` | 可读，非当前主线 |

代码基线：服务器后端 `069b2dc` + 全双工分支 `codex/full-duplex-w0@a3e5f43` 的功能集（67 commits / 41 files 相对基线）。

## 2. 快速开始

前置：Node 24、pnpm 12.11.2（`corepack enable` 或全局安装）。

```bash
pnpm install --frozen-lockfile
pnpm dev:web                                     # Web: http://127.0.0.1:5175
pnpm --filter @vivic/local-api start             # API: http://127.0.0.1:8787
pnpm --filter @vivic/local-api exec tsx src/asrGatewayServer.ts   # ASR Gateway: ws://127.0.0.1:8799/asr
```

验证后端存活：`curl http://127.0.0.1:8787/healthz` → `{"ok":true,"service":"vivic-local-api"}`

常用命令：

```bash
pnpm typecheck                                   # 类型检查
pnpm lint                                        # oxlint
pnpm --filter @vivic/web exec vite build         # 仅打包 Web（绕过 tsc -b）
pnpm --filter @vivic/web test turnTaking         # 定向单测
```

## 3. 当前能力边界（务必先读，不要误判）

**真实能力**
- 麦克风持续采集（getUserMedia + AudioWorklet）、RMS 能量 VAD
- TTS 播放与 Playback Ledger（MSE 流式 + playedMs 实际进度）、duck/unduck
- Web / API / ASR Gateway 三进程可独立启动互通
- Hosted Tasks / Space 的业务读写链路（沿用既有实现）

**Mock / 规则能力（不得称为已完成真实能力）**
- **ASR 是 Mock Provider**：Gateway 默认 `MockAsrProvider`，输出「词1词2…」合成文本，没有真实语音识别。真实 StepFun / 离线 Provider 尚未适配。
- 意图判断是**正则规则**（`turnTaking.ts`），不是上下文语义模型。
- `taskProjection.ts` 未消费真实 HostedTask 的 status / receipt / version。
- 浏览器 E2E 使用 fake media device + `routeWebSocket` mock，属链路 smoke，不是真实语音验收。

**已知未通过**
- P3 全双工产品行为闭环（YU-405）未通过独立验收：连续多轮 ASR、真实插话意图、HostedTask 真实回执均未验证。

**已知既有失败（原仓库同样存在，不是本仓库引入）**
- 本次干净环境验证中，`pnpm typecheck` 通过（0 errors），`pnpm build` 的 Web + Mobile 构建通过。此前阻断构建的两个陈旧测试已按当前组件 API 修正；这不代表全量 `pnpm test` 已通过。
- `pnpm test` 仍存在失败用例（web / local-api / mobile-console 各一批），属于本次交接前已存在的测试债；本轮未以修复全部产品测试为建仓前提。
- GitHub Actions 当前无法执行：账号私有仓库 Actions 额度耗尽，job 在分配 runner 前即失败（`runner=""`、`steps=0`）。这不是代码失败。

## 4. 阅读顺序

1. 本文件 → 2. `HANDOFF.md`（交接范围与验收状态）→ 3. `AGENTS.md`（协作与边界规则）
2. 架构约束：`docs/moss-live-full-duplex-architecture-constraints.md`（MOSS-Live 对齐的职责划分）
3. 设计与决策记录：`docs/decisions/`、`docs/design/`
4. 历史验证：`docs/verification/`

## 5. 协作约定

- 分支：从 `main` 切任务分支，PR 回 `main`；一个任务一个 PR。
- 不把 Mock/规则实现写成真实供应商能力；新增能力必须有可复现测试。
- 不提交凭据、生产数据库或线上配置；`.env*` 默认不入库。
- 线上部署、生产配置变更需要单独明确授权；本仓库不承担部署职责。
