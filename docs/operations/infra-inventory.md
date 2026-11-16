# Vivic 基础设施与账号清单（只读盘点，2026-11-03）

> **脱敏声明**：本文件不包含任何完整明文密码/密钥。所有敏感值均为掩码，并标注明文位置（文件 + 行号 / 会话 seq），
> 供本人自查；掩码规则：密码取前 3 + `****` + 后 3，密钥取前 6 + `…` + 后 4。
> 数据源：`work/session-aacee514.jsonl`（8,184 事件）、`work/HANDOFF-CREDENTIALS.local.md`、`docs/postmortems/*`、`docs/decisions/*`、`outputs/VIVIC-HANDOFF-20261101.md`。
> 生成脚本：`work/audit/build-infra.py`（每次运行都会重新校验下面每条事实是否仍能在源里找到）。

## 0. 一页总览

| 资产 | 数量/位置 | 风险点 |
|------|-----------|--------|
| 服务器 | 1 台阿里云 ECS（`47.108.117.1`，2C2G/40G，CentOS 8） | 内存/磁盘都紧（92% 磁盘占用）；root 单账号 + 密码登录 |
| 线上服务 | Vivic 后端容器 + nginx + 前端 symlink 发布 | 发布依赖两个 shell 脚本 + 一个 overlay 校验，历史事故都出在这三处 |
| 域名/控制台 | `vivic.edsionc.top`、`edsionc.top`（控制台/4B/quant-throne） | 控制台密码与 SSH 同密码 |
| 账号 | 产品 1、控制台/SSH 1、本地预览 1、GitHub 2 | 产品密码与控制台密码不同（易混） |
| 密钥 | DeepSeek 2（1 已废）、StepFun 2、网关/决策 token 2、站点邀请码 1、数据密钥 1、会话 cookie 1 | 多把以明文出现在本机文件/会话 JSONL/公开仓库/服务器 `env.list`，逐一标了位置 |
| 数据 | SQLite `space.sqlite`（accounts / account_values / decision_log 等） | 备份靠 deploy.sh；无独立 DB 账号体系 |

---

## 1. 服务器

| 项 | 值 | 依据 |
|----|----|------|
| 公网 IP | `47.108.117.1` | SSH 直连；见凭据文件 L8 |
| 主机名 / 元数据 | `iZ2vcewzmu8bs0hcre19nbZ` / `100.100.100.200` | 阿里云 ECS；交接文档 §1 |
| 规格 | 2 vCPU / 2 GB 内存 / 40 GB 系统盘（`/dev/vda1`） | 11-02 14:27 实测：内存 1735 MB 总、659 MB 可用；Swap 4095 MB（用 664）；`/` 40G 用 37G（92%），剩 3.4G |
| 系统 | CentOS 8；nginx 1.14.1；宿主机 SQLite 3.26.0（`python3 -c "import sqlite3"`） | 会话内 `nginx -v` / python sqlite3 版本输出；HTTP 响应头 `server: nginx/1.14.1` |
| 运行时 | Docker；容器内 Node v24.21.0 | `docker exec … node -v` |
| 登录方式 | `root` + 密码（掩码 `cjr****lxl`） | 凭据文件 L10 |
| 角色 | Nginx + Docker：Vivic 线上、模型网关/quant-throne、其他项目（beam-lab） | `docker ps` 实测 |

### 1.1 目录与脚本地图

| 路径 | 用途 |
|------|------|
| `/opt/vivic-preview-20261025/` | 项目根（前后端发布都在这里） |
| `…/backend/deploy.sh <40位sha>` | 后端发布入口：flock `deploy.lock` → 磁盘≥2GiB 检查 → staging(18891) 校验 → DB 备份 → 旧容器转 `vivic-api-prev` → 起新容器 → `/healthz` 轮询 |
| `…/backend/rollback.sh` | 回滚入口：切回 `vivic-api-prev`，失败容器改名 `vivic-api-failed-<ts>-<pid>` |
| `…/backend/env.list`（600） | 运行时环境变量：`VIVIC_TOOL_CALLS`/`VIVIC_SECTIONS`/`VIVIC_DECISION_MODE`/`VIVIC_LEGACY_FALLBACK`/`VIVIC_TOOL_REPAIR`/`VIVIC_REPLY_STYLE` 等；**含明文模型 key** |
| `…/backend/DEPLOYED` | 当前部署记录：`sha=` / `image=` / `time=` / `backup=` / `action=deploy\|rollback` |
| `…/backend/uploads/<sha>.tar` | 后端 bundle 落地处（`upload-backend.py` 写入并校验 sha256） |
| `…/backend/bundles/<sha>/` | 已部署 bundle 的展开副本；`RETAR` 部署时用它打底 |
| `…/backend/required-overlays/connection-qrcode-20261031-1/apply.py` | 发布前置 overlay：对 `connections/*.ts`、`online/sessions.ts`、`hosted/service.ts` 做哈希校验/增补（LF/CRLF 陷阱来源） |
| `…/frontend-current` | 指向 `releases/<release>/web` 的 symlink（原子切换点） |
| `…/releases/<release>/web` | 前端 release；`publication.json` 记录 previous / index sha / preparedOnly |
| `…/publish-lock.sh` | 前端发布锁：`run <tag> -- <cmd>`（prepare，不切）/ `switch <path> <tag>`（切指针） |
| `…/backups/db-<ts>-<pid>` | 每次后端部署的 SQLite 备份 |
| `…/model-settings/` | 模型设置面板注入脚本稳定目录（对外 `https://vivic.edsionc.top/model-settings/inject.js`） |
| `…/frontend-sources/frontend-source-20261101-2/source/upstream-project-20261025` | 线上前端源码快照（13 MB） |
| `…/nginx-backup-20261101T125344.conf` | nginx 配置备份 |
| `/var/lib/vivic-preview-20261025` | 生产数据目录（`space.sqlite`）；`deploy.sh` 要求它是真实路径且存在 `space.sqlite` |
| `/var/lib/vivic-staging` | staging 数据目录（18891） |
| `/etc/nginx/conf.d/60-vivic-preview-20261025.conf` | vivic.edsionc.top 的 vhost（80 跳 443、letsencrypt ACME、静态 root = `frontend-current`） |
| `/var/log/nginx/{access,error}.log`、`vivic-startup-errors.log` | 访问/错误/启动错误日志 |
| `/var/www/vivic-preview-acme` | ACME 校验 webroot（`/.well-known/acme-challenge/`） |
| `/etc/letsencrypt/live/…` | TLS 证书（letsencrypt） |
| `/var/www/edisonc-game/private-quant-throne/runtime.env` | quant-throne 运行环境（600，含明文 DeepSeek key） |
| `/var/www/edisonc-game/services/quant-throne/releases/api-<ts>/server.mjs` | quant-throne 已部署版本；`PREFIX = "/quant-throne/api"` |

### 1.2 发布/回滚入口（本人复现时按这个顺序）

1. 后端：`cd /opt/vivic-preview-20261025/backend && bash deploy.sh <40位sha>`（bundle 先经 `upload-backend.py` 落到 `uploads/<sha>.tar`）。
2. 前端：先 `publish-lock.sh run <tag> -- bash publish-frontend-remote.sh …`（prepare，不切），校验 sha/权限/文件数后再 `publish-lock.sh switch <release>/web <tag>`。
3. 回滚：后端 `bash backend/rollback.sh`（切 `vivic-api-prev`）；前端 `publish-lock.sh switch …/releases/<上一版>/web rollback`（秒级）。
4. 注意：`deploy.sh` 会先跑 `required-overlays/connection-qrcode-20261031-1/apply.py`，**本地 LF 包不能直接覆盖线上 CRLF 文件**（11-02 20:33 的失败原因）。

---

## 2. Docker 容器 / 镜像 / 端口

| 容器 | 镜像 | 说明 |
|------|------|------|
| `vivic-preview-20261027` | `vivic-api:<当前sha>` | 线上 Vivic 后端（唯一对外） |
| `vivic-api-prev` | 上一版镜像 | `rollback.sh` 的回滚目标 |
| `vivic-api-staging` | 同版本镜像 | 18891 上的 staging 校验容器（deploy.sh 临时起） |
| `vivic-api-failed-<ts>-<pid>` | 被替换下来的旧容器 | 失败/被替换容器的留档（11-01 23:56 见过 3 个 `23e2c00` 的 failed 容器） |
| `beam-lab-web-1` / `beam-lab-model-1` | `beam-lab-web` / `beam-lab-model` | 同机其他项目（模型网关相关），与 Vivic 发布无关 |

镜像命名：`vivic-api:<40位sha>`（基线 `vivic-api:e46222d`、工具层 `vivic-api:23e2c00` 也出现过）。

| 端口 | 服务 | 说明 |
|------|------|------|
| 443 / 80 | nginx | `vivic.edsionc.top`（HTTP 308 跳 HTTPS） |
| 18890 | Vivic 后端（回环） | `http://127.0.0.1:18890/healthz` → `{"ok":true,"service":"vivic-space-api","mode":"online",…}` |
| 18891 | staging 后端（回环） | deploy.sh 用它做导入/SQLite/健康校验 |
| 18894 | quant-throne-api（systemd） | `/quant-throne/api/health` → 200（公网同路径 200；`/quant-throne/health` 404） |
| 8790 | 容器内 online server | 日志：`loopback port 8790; public origin https://vivic.edsionc.top` |
| 8791 / 8792 | 本机 staging 预览 | 本地起过的两个 online 预览（`VIVIC_ONLINE_ORIGIN=http://127.0.0.1:8791\|8792`），**不在服务器上** |

---

## 3. 网站 / 域名 / 控制台

| URL / 域名 | 用途 | 账号类型 / 备注 |
|------------|------|-----------------|
| `https://vivic.edsionc.top` | Vivic 产品主站（登录、`/`、`/display`、`/api/*`、`/healthz`、`/model-settings/inject.js`） | 产品账号（见下）；公开可访问 |
| `https://edsionc.top/api/` | EC Studio 工作台 / 控制台（模型网关、4B 决策服务、模型探测） | 控制台密码（与 SSH 同一把，掩码 `cjr****lxl`） |
| `https://edsionc.top/api/v1` | 模型网关 base（`VIVIC_MODEL_API_BASE_URL`） | `VIVIC_MODEL_API_TOKEN` = `vvc_HL…g540` |
| `https://edsionc.top/api/v1/decisions` | 旧 4B 决策服务（`startlux-decision-4b`，也可 `-2b`） | `VIVIC_DECISION_API_KEY` = `vvc_3p…ALSa` |
| `https://edsionc.top/quant-throne/api/health` | quant-throne 教练 API（公网） | 与 Vivic 后端独立；同一把 DeepSeek key 的另一个消费方 |
| `www.edisonc.top` / `edisonc.top` | 旧域名/其他站点 | 会话里只出现在 nginx 访问日志的爬虫扫描（`.git/HEAD`、`.env`、`wp-` 等），不是我们要维护的入口 |
| `https://api.deepseek.com/v1` | DeepSeek 官方 API（主模型 `deepseek-chat`） | key 见密钥表 |
| `https://api.stepfun.com/v1`、`/step_plan/v1` | StepFun（备用/规划器） | 当前 provider 停用 |
| `https://github.com/ECdison6227/vivic-canvas` | 上游私有仓库（PR #20/#21/#22） | reviewer/owner `ECdison6227`；分支保护，不能强合 |
| `https://github.com/Bruce-Yii/vivic-latest-test` | 公开镜像仓库（桌面 release、曾含 `.env.local`） | 2026-11-02 已转 private；泄露源 |

---

## 4. 账号

| 类型 | 标识（掩码） | 明文位置 / 说明 |
|------|--------------|-----------------|
| Vivic 产品账号 | `cjr`（掩码 `che****lxl`） | 凭据文件 L25；产品登录要求 ≥12 位，别用控制台那把 |
| Vivic 产品会话 cookie | `__Host-vivic_space=dTTn…NUg`（掩码） | `work/product-account-session.json`（155 B，含明文 cookie；脚本里大量 `Invoke-WebRequest -Headers @{Cookie=…}` 使用它） |
| 控制台 / SSH 账号 | `cjr` / 密码掩码 `cjr****lxl` | 凭据文件 L10（SSH）与 L18（控制台）是同一把密码 |
| 服务器 root | `root` | 凭据文件 L9；`remote-exec.py`/`ssh-ro.py` 从这里读，不打印 |
| 本地预览测试账号 | `preview` / 密码掩码 `prev****2026` | 明文在 `outputs/VIVIC-HANDOFF-20261101.md` L163（仅本地 8790 预览，已停） |
| GitHub：upstream owner/reviewer | `ECdison6227` | PR #20/#21 需要 review；PR #22 stacked 在 #21 上 |
| GitHub：公开镜像/桌面 release | `Bruce-Yii` | 曾把 DeepSeek key 提交进 `apps/local-api/.env.local` |
| 数据库账号 | 无独立账号体系 | `accounts` 表存 `password_salt`/`password_hash`（盐+哈希，非明文） |

---

## 5. 密钥 / Token

| 名称 | 掩码 | 明文位置 | 状态 |
|------|------|----------|------|
| DeepSeek 新 key（当前主用） | `sk-d1b…98c9` | 凭据文件 L32；会话 seq 3093 起出现明文（用户经 inbox 提供，随后 `sed` 命令回显） | 已轮换（2026-11-02）；**余额需控制台核对**：postmortem 记 4.99 CNY，凭据文件 L39 记“仍为 0 / 402” |
| DeepSeek 旧 key（作废） | `sk-c800…a6d8` | 曾出现在公开仓库 `.env.local`；本机凭据文件只留掩码（L33）；**旧版文件**的明文在会话 seq 31 被读入并回显 | **已泄露 + 已作废**（余额被刷空，402） |
| StepFun key（备用，凭据文件） | `2v0UZW…BboH` | 凭据文件 L36；服务器 `backend/env.list` 也有一份明文（600） | 停用；未轮换（暴露面：服务器 env.list + 本机文件） |
| StepFun key（容器内 `VIVIC_STEPFUN_API_KEY`） | `2lkU7…UDYf`（与上面不同的一把） | 会话 seq 4083（`docker exec … env` 回显）；`VIVIC_STEPFUN_BASE_URL=https://api.stepfun.com/step_plan/v1` | 停用中；未轮换 |
| 4B 决策服务 key `VIVIC_DECISION_API_KEY` | `vvc_3p…ALSa` | 会话 seq 4083；服务器 `backend/env.list` | 4B 路由已下线（`VIVIC_DECISION_MODE=off`），key 未吊销 |
| 模型网关 token `VIVIC_MODEL_API_TOKEN` | `vvc_HL…g540` | 会话 seq 4083（另见 seq 5946 的 env 备份列表）；服务器 `backend/env.list` | 在用（网关探测） |
| 站点邀请码 `VIVIC_SPACE_INVITE` | `7b2884…d226` | 会话 seq 4083（容器 `env` 回显）；服务器 `backend/env.list` | 在用（注册邀请码，等同半公开凭据） |
| 容器数据密钥 `.secret-key` | 32 字节随机（未在会话中回显） | 容器内 `/data/vivic/.secret-key`（600） | 不能外传；丢失会导致 account-providers 解不开 |
| 产品账号会话 cookie | `__Host-vivic_space=dTTn…NUg` | `work/product-account-session.json` | 测试账号凭证，随密码轮换而失效 |

### 5.1 轮换状态一句话

- **必须继续当作已泄露**：DeepSeek 旧 key（已作废）、公开过的 `VIVIC_LOCAL_TOKEN`、本机 `work/HANDOFF-CREDENTIALS.local.md` 与 `work/session-aacee514.jsonl` 里的所有明文。
- **在用但未轮换**：StepFun 两把（当前停用中，可先吊销）、`VIVIC_DECISION_API_KEY`（4B 已下线，可吊销）、`VIVIC_MODEL_API_TOKEN`（网关在用）。
- **轮换方式（历史做法）**：Vivic provider → `PATCH /api/providers`；quant-throne → 改 `runtime.env` 后 `systemctl restart quant-throne-api`（先 `cp -a` 备份）；服务器 env → `backend/env.list`（600）后重新 `deploy.sh`。

---

## 6. 数据库与存储

| 位置 | 内容 | 备注 |
|------|------|------|
| `space.sqlite`（+`-wal`） | 容器内 `/data/vivic/space.sqlite`；宿主 `/var/lib/vivic-preview-20261025/space.sqlite` | 生产数据；`deploy.sh` 只备份不改结构 |
| `accounts` | `id`、`username`(unique)、`password_salt`、`password_hash`、`created_at`、`cursor`… | 账号密码是盐+哈希，**不是明文** |
| `account_values` | `account_id`、`key`、`value_json` | 按账号存键值（provider 配置等，可能加密存） |
| `decision_log` | `id`、`at`、`account_id`、`space_id`、`path`、`text`、`trace_json`、`outcome`、`undone` | 意图排查主表（本次分析用过它的 `outcome`/`trace_json`） |
| `/data/vivic/providers.json`（600） | 模型平台配置 | 含 provider 凭据引用 |
| `/data/vivic/account-providers/`（700） | 按账号的 provider 配置目录 | DeepSeek/StepFun key 加密落在这一层 |
| `/data/vivic/assets/` | 上传附件/图片 | 照片墙等卡片资源 |

---

## 7. 同机其他服务

| 服务 | 位置 | 与 Vivic 的关系 |
|------|------|-----------------|
| `quant-throne-api`（systemd，18894） | `/var/www/edisonc-game/private-quant-throne/`（`runtime.env` 600）、`/var/www/edisonc-game/services/quant-throne/releases/api-<ts>/` | 共用同一把 DeepSeek key，是最早的 key 泄露排查对象之一；公网 `https://edsionc.top/quant-throne/api/health` |
| 模型网关（`edsionc.top/api/v1`） | 同机（`beam-lab-web-1` / `beam-lab-model-1` 容器） | Vivic 的 `VIVIC_MODEL_API_BASE_URL` 指向它；控制台同一入口 |
| 4B 决策服务（`/api/v1/decisions`） | 同机（`startlux-decision-4b`） | 2026-11-03 起 Vivic 不再调用（`VIVIC_DECISION_MODE=off`） |
| nginx + letsencrypt | `/etc/nginx/conf.d/60-vivic-preview-20261025.conf`、`/etc/letsencrypt/` | `vivic.edsionc.top` 的 TLS/静态/反代全在这一份 vhost 里 |

### 7.1 环境变量里出现的第三方集成（只在容器 `env` 里见过，未单独验证）

| 变量 | 值（掩码/路径） | 含义 |
|------|-----------------|------|
| `VIVIC_LARK_CLI_PATH` | `/opt/v…-cli` | 飞书（Lark）CLI 路径；配套 overlay `feishu-app-auth-20261031-1` |
| `VIVIC_WECOM_CLI_PATH` | `/opt/v…-cli` | 企业微信 CLI 路径 |
| `VIVIC_DINGTALK_CLI_PATH` | `/opt/v…/dws` | 钉钉 CLI 路径 |
| `VIVIC_DECISION_ROUTES` | `countd…tore`（枚举串） | 4B 只对这些 route 生效（现已整体 off） |
| `VIVIC_SPACE_DATA_DIR` | `/data/vivic` | 容器内数据目录 |
| `VIVIC_ONLINE_BIND_HOST` | `0.0.0.0` | 容器内监听地址（对外由 nginx 反代） |

---

## 8. 安全事故与轮换记录

| 时间 | 事件 | 根因 | 处置 |
|------|------|------|------|
| 2026-11-02 12:27–12:29 | 切前端 release 后首页 500、补丁 404（约 2 分钟） | `umask 077` 让新 release 目录 700/文件 600，nginx 读不到 | chmod 755/644；发布脚本加权限断言；见 `docs/postmortems/2026-11-02-frontend-release-permissions.md` |
| 2026-11-02 03:16–12:31 | DeepSeek 402，余额被刷空 | 公开仓库 `Bruce-Yii/vivic-latest-test` 的 `apps/local-api/.env.local` 泄露 key（公开约 24h） | 仓库转 private（raw 200→404）、旧 key 作废、新 key 写 3 处、quant-throne `systemctl restart`；见 `docs/postmortems/2026-11-02-deepseek-key-leak.md` |
| 2026-11-02 20:33 | 后端部署失败（overlay 哈希冲突） | 本地 LF bundle 覆盖线上 CRLF+QR 增量文件 | 改用“线上 bundle 打底 + 只换 6 个文件”的 RETAR 手法 |
| 2026-11-03 03:09–03:14 | `VIVIC_DECISION_MODE=off` 假生效 | overlay 覆盖了我们改的 `hosted/service.ts` | 重打包只换 5 个哈希校验文件，保留 `service.ts` |
| 2026-11-01 之前（历史） | 误删 release `login-panel-20261031-2` 导致最新 UI 大量 symlink 断裂 | 把删 release 当清磁盘手段 | 已恢复字体/worklet/背景 CSS；**旧 release 之间有硬链接依赖，不能删** |
| 持续 | `work/session-aacee514.jsonl` 内含多处明文 key/密码回显 | 远程命令输出原样落盘（`docker exec env`、`awk` 打印 env、凭据文件被 read） | 本文件只给掩码；建议对该 JSONL 做访问控制或脱敏后再归档 |

---

## 9. 明文位置索引（自查用，按文件）

| 文件 | 含什么 | 建议 |
|------|--------|------|
| `work/HANDOFF-CREDENTIALS.local.md` | SSH/控制台密码（L10、L18）、产品密码（L25）、DeepSeek 新 key（L32）、StepFun key（L36）、余额说明（L39） | 已 gitignore（`work/*`，已验证未入库）；建议读完转密码管理器并删除 |
| `work/session-aacee514.jsonl` | 上述明文 + 容器 `env` 回显（seq 4083 的 `VIVIC_STEPFUN_API_KEY`/`VIVIC_DECISION_API_KEY`）、seq 5946 的 `VIVIC_MODEL_API_TOKEN`、seq 31 的旧 DeepSeek key | 限制访问；归档前脱敏 |
| `work/product-account-session.json` | 产品账号会话 cookie（明文） | 视为凭据；用完即弃 |
| 服务器 `backend/env.list`（600） | StepFun / 决策 / 网关 key 明文 | 只有 root 可读；建议改用 systemd EnvironmentFile 或密钥管理 |
| 服务器 `private-quant-throne/runtime.env`（600） | DeepSeek key 明文（`DEEPSEEK_API_KEY`） | 同上；有 `runtime.env.bak-newkey-*` 历史副本 |
| 服务器 `/data/vivic/.secret-key`（600） | 32 字节数据密钥 | 不可外传；备份策略要覆盖 |

> 名字有坑的文件：`work/users.json` **不是**账号表，是 213 条用户消息的导出（`turn/time/len/text`）；`work/users-index.txt` 是上次跑脚本留下的报错文本，不是索引。

---

## 10. 未确认 / 需要本人核对

1. **DeepSeek 当前余额**：`docs/postmortems/2026-11-02-deepseek-key-leak.md` 说新 key 余额 4.99 CNY，`work/HANDOFF-CREDENTIALS.local.md` L39 说“仍为 0，需充值才能调用”。两者矛盾，以控制台为准（本任务只读，未连服务器/未调 API）。
2. **StepFun 两把 key 的归属**：凭据文件那把（`2v0UZ…`）与容器 `VIVIC_STEPFUN_API_KEY`（`2lkU7…`）不同，不清楚哪把是“正式备用”。
3. **`www.edisonc.top` / `edisonc.top` 归属**：会话里只出现在爬虫扫描日志，未确认是否仍属本项目。
4. **`vivic-api-failed-*` 容器数量**：11-01 23:56 见到 3 个（都是 `23e2c00`），之后是否清理、磁盘是否回收未确认（磁盘长期 92%）。
5. **产品账号是否有第二个测试账号**：会话只用到 `cjr` 与其 cookie；`accounts` 表里可能有更多（未导出核对）。
