# 发版 v2 资产

## 文件

- `deploy-v2.sh`：发版流程（预编译校验 → 上传/校验 → staging 启动 → 切换 → 健康检查 → 保留回滚点）。
- `precompile.mjs`：构建期预编译，消除首次请求的 tsx 冷启动。
- `Dockerfile`：后端镜像。
- `nginx-upstream.patch`：nginx 配置补丁（含 `X-Real-IP` / `X-Forwarded-For` 透传，IP 城市兜底依赖它）。

## 和服务器上脚本的关系

服务器 `/opt/vivic-preview-20261025/backend/` 下已有 `deploy.sh` / `rollback.sh` / `env.list`（运行时环境与凭据），**不在本仓库**。
这里放的是 v2 方案：预编译 + 预热 + 更明确的健康检查，用于替换“首次请求冷启动”的旧流程。

## 关键环境变量（部署时确认）

| 变量 | 线上当前值 | 说明 |
|---|---|---|
| `VIVIC_TOOL_CALLS` | on | 工具层总开关 |
| `VIVIC_SECTIONS` | on | 前端 sections 补丁兼容 |
| `VIVIC_DECISION_MODE` | off | 4B 路由（已删除代码，保留变量无害） |
| `VIVIC_LEGACY_FALLBACK` | on（线上） | 旧规划器兜底；新代码默认 off |
| `VIVIC_DECIMAL_RATING` | off | 前端支持半星/满分后打开 |
| `VIVIC_SEARCH_PROVIDER` | 未设置（auto） | auto = Bing → 账号链 → Exa |
| `VIVIC_TRUST_PROXY_IP` | 未设置（on） | 可信代理 IP；Docker 端口发布后需配置可信网段 |

## 回滚

- 每个 release 独立目录 + `DEPLOYED` 记录；
- 失败时切回上一版后端镜像/目录，数据层只做备份、不改 schema。
