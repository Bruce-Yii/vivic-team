# VIVIC Team Handoff — Clean Snapshot

> 交付性质：精简、可运行的独立仓库初始基线（干净 Git 初始提交，不继承原仓库历史）
> 生成时间：2026-11-16

## 基线来源
- Backend / Web 源码基线：服务器真实部署版本对应 commit `069b2dcb27e1cfbf921e4d3d2d5aeae75642d35f`（Docker 镜像 vivic-api 版本）。
- 全双工研发：`Bruce-Yii/vivic` 分支 `codex/full-duplex-w0`，HEAD `a3e5f434dde94b246ebedae9de61a8a14692baf9`（相对基线 67 commits / 41 files）。
- 服务器 Web Release 产物：`key-input-placeholder-20261108-1`（详见 `server-web-release/README.md`；产物已按 .gitignore 排除，不作为构建输入）。

## 纳入内容
- `apps/`：web / local-api / android / hosted 全部源码（含全双工功能：fullDuplex、turnTaking、vad、asrGatewayClient、taskProjection、ASR Gateway Server、Streaming TTS/Playback Ledger）。
- `packages/`：contracts（含 asrTransport）/ card-runtime / 共享契约。
- `contrib/`、`deploy/backend`、`deploy/decision`：运行与部署依赖。
- `.github/workflows/ci.yml`：CI 配置（checks: contracts:check / typecheck / lint / test）。
- `docs/`：产品与 MOSS-Live 架构约束（不含历史 archive/research/updates）。
- 必要配置：package.json / pnpm-lock.yaml / pnpm-workspace.yaml / .env.example / AGENTS.md 等。

## 排除内容
- archive/、outputs/、work/ 临时脚本、deploy/online-patches | manifests | online-snapshot、docs/archive | research | postmortems | updates | superpowers、evals/、training/、.codex/、空的 src/ tests/。
- 服务器 Web Release 产物（845MB）不进 git，单独存档于 server-web-release/，按需从服务器重新获取。

## 已验证（干净环境，node 24.16 / pnpm 12.11.2）
- pnpm install --frozen-lockfile：✅ 791 包
- pnpm --filter @vivic/web exec vite build：✅ 2.28s（产品本体可打包）
- pnpm --filter @vivic/local-api typecheck：✅ 0 错误
- backend 启动 + /healthz：✅ {"ok":true,"service":"vivic-local-api"}
- ASR Gateway 启动（:8799）：✅ ws://127.0.0.1:8799/asr
- 单元测试：web turnTaking+speechStreaming 11 passed；local-api asr-gateway 13 passed
- E2E：fullDuplex.spec.ts 1 passed（fake media + routeWebSocket mock）

## 已知限制（如实标注，不伪造）
1. `pnpm build` 的 `tsc -b` 阶段被 4 个既有 stale 测试类型错误阻断（SettingsExperience.test.tsx 的 local prop、SpaceEditing.test.tsx 的 CanvasManager/onBeforeClear），原仓库即有，与全双工无关；产品本体用 vite build 可直接打包。
2. `pnpm contracts:check` 失败：`Vivic_Kimi_Handoff_v0.6/contracts/*.schema.json` 缺失，原仓库同样缺失（未跟踪），既有问题。
3. Web 源码无法 100% 重建服务器 release：`sourceBuildReproducible:false`，缺 card-packages TSX/authoring generator（详见 server-web-release/README.md）。
4. ASR 为 Mock Provider（Gateway 默认 MockAsrProvider），无真实 StepFun/离线适配；意图为规则正则；TaskProjection 未消费真实 HostedTask receipt/version。
5. P3 产品行为闭环未通过 GPT 侧独立验收（YU-405 保持 In Progress）；本报告仅为代码范围交接，不代表功能验收通过。

## 启动
pnpm install
pnpm dev:web                                    # 或 pnpm dev 同时起 web(5175)+api(8787)
pnpm --filter @vivic/local-api exec tsx src/asrGatewayServer.ts   # ASR Gateway :8799
