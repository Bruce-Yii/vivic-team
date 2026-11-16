# 项目当前状态（2026-11-05）

> 给「只能看 GitHub、看不到服务器」的协作者：看完这一篇就知道项目在哪、线上是什么、代码怎么跑、还差什么。

## 1. 你在哪

- 仓库：`Bruce-Yii/vivic`（私有），远程分支 `codex/live-backend-20261103`
- 本地 HEAD：`e312e2b`（含 `tooling/` 资产）
- 线上后端：`7918e99`（2026-11-03 23:24 部署）；线上前端：`sections-20261103-final`
- **仓库领先线上 86+ 个提交，尚未部署**

## 2. 这是什么项目

卡片式个人画布 Agent：用户说话 → 模型决定动作 → 宿主校验/执行 → 卡片出现在画布。

**当前架构（一句话）**：规则只做“格式完全确定”的直出；其余全部交给模型工具调用（14 个能力工具）；宿主只做校验/执行/报告，不替模型做决定。

关键组成：

| 目录 | 作用 |
|---|---|
| `apps/local-api` | 后端（在线/本地两种模式、意图流水线、工具层、数据适配器） |
| `apps/web` | 前端源码（线上产物是独立 release，见 §6） |
| `packages/contracts` | 卡片/Action/信封契约（严格 schema） |
| `packages/card-runtime`、`card-builder` | 卡片构建运行时 |
| `deploy/` | 服务器部署脚本、Dockerfile、nginx 配置、在线补丁记录 |
| `tooling/` | 验收套件、数据集、发版 v2 资产、阶段汇报（本次新增） |
| `docs/decisions` | 33 篇决策记录（为什么这么做） |
| `docs/audits`、`docs/operations` | 决策点审计、能力/校验对账、基础设施与部署时间线 |

## 3. 线上 vs 仓库

| 项 | 仓库 | 线上 |
|---|---|---|
| 后端 commit | `e312e2b` | `7918e99` |
| 前端 release | 源码在 `apps/web` | `sections-20261103-final`（补丁产物，独立发布） |
| 环境变量 | `.env.example`（只有名字/默认值） | 服务器 `env.list`（含真实 key，不进仓库） |
| 数据 | 不进仓库 | `/var/lib/vivic-preview-20261025`（SQLite+资产） |
| nginx/TLS | `deploy/` 里有配置模板与补丁记录 | 宿主机实际配置与证书 |

线上开关（`env.list`，2026-11-05 实测）：`TOOL_CALLS=on`、`SECTIONS=on`、`DECISION_MODE=off`、`LEGACY_FALLBACK=on`、`DECIMAL_RATING=off`、`TELEMETRY_DIR=/data/vivic/telemetry`。

## 4. 怎么跑

```bash
pnpm install
pnpm --filter @vivic/local-api test          # 后端单测（当前：2848 通过 / 8 条既有基线失败）
pnpm --filter @vivic/local-api typecheck
pnpm build                                    # 前端/后端构建

# 本地起后端（在线模式，用数据副本）
# 参考 scripts/start-staging.ps1 / docs/operations/infrastructure-inventory.md

# 60 条验收（对线上或本地）
node tooling/acceptance/accept60.mjs
VIVIC_ACCEPT_BASE=http://127.0.0.1:8796 node tooling/acceptance/accept60.mjs
```

## 5. 发布计划（后端分三批，前端独立）

| 批次 | 内容 | 状态 |
|---|---|---|
| 1 | 观测：token 计量、前缀稳定、遥测字段、截断识别 | 未部署 |
| 2 | 架构：删第二套决策系统、工具面 14、find_cards、歧义/复合句/回执协议、查询只读 | 未部署 |
| 3 | 新能力：Bing 搜索、金价、IP 城市、天气 7 天、read_url、通用卡/图片（后端部分） | 未部署 |

批次必须是 1 → 2 → 3；前端不阻塞，按自己的发布线走。

## 6. 仓库外的东西（看不到服务器时需知道）

| 东西 | 在哪 | 说明 |
|---|---|---|
| 真实密钥/密码 | 服务器 `env.list`、本机 `HANDOFF-CREDENTIALS.local.md`（gitignore） | 不进仓库 |
| 生产数据 | 服务器 `/var/lib/vivic-preview-20261025` | 不进仓库 |
| 前端 release 产物 | 服务器 `releases/<tag>/web` | 仓库只有源码与补丁记录 |
| 部署脚本运行版 | 服务器 `backend/deploy.sh`、`rollback.sh` | 仓库有同源副本（`deploy/backend/`） |
| 服务器 nginx vhost | `/etc/nginx/conf.d/60-vivic-preview-20261025.conf` | 仓库有模板与补丁（`deploy/online*`） |

## 7. 未完成 / 待决策

- 部署（批次 1/2/3）；
- 前端五件：半星/满分渲染、通用卡风格渲染、照片墙上传、TTS 流式播放、回复风格设置；
- `find_cards` 全画布（前端发全量 vs 后端检索接口，待拍板）；
- 真机语音测试；MOSS-Live 接入（能力评估完成，暂不接）；
- 8 条既有单测基线失败（其中 provider-main-transport 3 条可能对应真实配置问题）。

## 8. 文档索引

- 阶段汇报与对比：`tooling/reports/`（01–07 + 前端交接）
- 决策记录：`docs/decisions/`
- 决策点审计 / 能力与校验对账：`docs/audits/`
- 仓库与服务器对应：`docs/deployment/2026-11-05-repo-vs-server.md`
- 基础设施与部署时间线：`docs/operations/infrastructure-inventory.md`、`deploy-timeline.md`
