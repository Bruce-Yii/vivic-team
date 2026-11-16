# VIVIC 团队交接说明

> 状态：源码快照、交接文档与基础运行验证已完成。`Bruce-Yii/vivic-team` 是**原始基准仓库（Public）**，只作来源参考；后续实际协作发生在协作者复刻后的仓库（见 `docs/team/FRONTEND_SOURCE_AND_VERSION_SYNC.md`）。

## 1. 基线来源

| 项目 | 值 |
| --- | --- |
| 服务器真实后端版本 | `069b2dcb27e1cfbf921e4d3d2d5aeae75642d35f`（Docker 镜像 `vivic-api:069b2dc…`） |
| 服务器真实 Web release | `key-input-placeholder-20261108-1`（2026-11-08 发布，产物未纳入 Git） |
| 全双工研发分支 | `Bruce-Yii/vivic` → `codex/full-duplex-w0` |
| 全双工分支 HEAD | `a3e5f434dde94b246ebedae9de61a8a14692baf9` |
| 相对服务器后端基线 | ahead 67 commits / 41 files |
| 本仓库初始快照 | `5806af499d094bc9a59971da23552afc76e2b7e8`（root commit，无历史） |

说明：服务器后端 `069b2dc` 是全双工分支的祖先，两者**没有分叉**；本仓库直接以全双工分支为源码基线，不需要合并另一条 `codex/live-backend-20261103`（该分支相对 `069b2dc` 仅多 3 个部署/文档提交，无代码差异）。

## 2. 纳入范围

- `apps/web`、`apps/local-api`、`apps/android`、`contrib/mobile-console`、`packages/*` 全部源码与依赖。
- 全双工功能：`fullDuplex.ts`、`turnTaking.ts`、`vad.ts`、`asrGatewayClient.ts`、`taskProjection.ts`、`asrGateway*.ts`、`packages/contracts/src/asrTransport.ts`。
- 工程配置：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.github/workflows/ci.yml`、`deploy/backend`、`deploy/decision`、`deploy/release`。
- 文档：`docs/` 下的产品、架构、决策与验证记录（不含历史 archive / research / updates / postmortems）。

## 3. 排除范围

`archive/`、`outputs/`、`work/` 临时脚本、`evals/`、`training/`、`.codex/`、`deploy/online-patches|manifests|online-snapshot`、`docs/{archive,research,postmortems,updates,superpowers}`、`tooling/reports/` 历史部署报告。

服务器 Web release 产物（约 845MB）**不纳入 Git**，见第 6 节。

## 4. 已验证（本地干净环境，node 24.16 / pnpm 12.11.2）

| 项 | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | ✅ 791 包 |
| `pnpm --filter @vivic/web exec vite build` | ✅ 可打包（Web） |
| `pnpm typecheck` | ✅ 0 errors |
| `pnpm build` | ✅ Web + Mobile 构建通过 |
| `pnpm test` | ⚠️ 存在既有历史失败用例；以实际输出为准 |
| `pnpm --filter @vivic/local-api typecheck` | ✅ 0 错误 |
| 后端启动 + `/healthz` | ✅ `{"ok":true,"service":"vivic-local-api"}` |
| ASR Gateway 启动 | ✅ `ws://127.0.0.1:8799/asr` |
| 单元测试（定向） | ✅ web 11 / local-api 13 passed |
| E2E `fullDuplex.spec.ts` | ✅ 1 passed（fake media + WS mock） |
| `pnpm contracts:check` | ✅ 通过 |

## 5. 已知问题（如实标注，不伪造）

1. **构建与测试现状**：本仓库存在既有的历史测试失败与构建注意事项，属遗留状态，不是协作文档引入的问题。具体结果以仓库当前实际命令输出与 CI 页面为准；本文件不把某次窗口运行的具体数值当作基线证据。
2. **陈旧测试已按当前组件 API 修正**：构建与类型检查相关的两个历史测试已修正，`pnpm typecheck` 与 `pnpm build` 可通过。
4. **全双工未通过产品验收**：ASR 为 Mock、意图为规则、TaskProjection 未接真实 HostedTask；P3（YU-405）保持未通过。此项是产品能力验收状态，不影响本次代码仓库快照与基础启动交接。
5. **Web 源码无法 100% 重建服务器 release**：服务器元数据标记 `sourceBuildReproducible: false`，缺 card-packages authoring generator。

## 6. 服务器 Web release 产物

- 产物为生成物，不是源码，**不纳入 Git**。
- 如需核对线上表现，应从服务器 `releases/key-input-placeholder-20261108-1/web` 获取；该 release 内存在指向 `login-panel-20261031-2` 的符号链接，其中部分目标已失效，属服务器当前真实状态。
- 队友开发请以本仓库可构建源码为准，不要依赖该产物。

## 7. 接手步骤

先由协作者复刻本仓库，并从**复刻后的协作者仓库**克隆（原始仓库不是开发目标）：

```bash
git clone https://github.com/<COLLABORATOR_OWNER>/<COLLABORATOR_REPO>.git
cd <COLLABORATOR_REPO>
pnpm install --frozen-lockfile
pnpm dev:web
pnpm --filter @vivic/local-api start
pnpm --filter @vivic/local-api exec tsx src/asrGatewayServer.ts
```

打开 `http://127.0.0.1:5175/`，点聊天头部 `fd` 按钮可看到全双工开关与状态条（当前为 Mock ASR）。
