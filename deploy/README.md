# deploy

部署相关的脚本、配置模板与发布记录。**不含任何真实凭据。**

| 路径 | 内容 |
|---|---|
| `backend/` | 后端发布/回滚脚本、Dockerfile、发布说明 |
| `online/` | 线上 nginx 配置模板（location/verify） |
| `online-patches/` | 历史前端/线上补丁：每个补丁的 manifest、nginx 头、验证记录 |
| `manifests/` | 线上版本快照（sha/镜像/前端 tag/开关，2026-11-05 起） |
| `decision/` | 旧决策模型部署脚本（该路径已从理解链路删除，仅留档） |

## 当前线上快照

- 机器可读：`manifests/live-20261105.json`
- 项目当前状态：[../docs/operations/current-state-20261105.md](../docs/operations/current-state-20261105.md)
- 仓库与服务器对应：[../docs/deployment/2026-11-05-repo-vs-server.md](../docs/deployment/2026-11-05-repo-vs-server.md)
- 分批发布计划：[../docs/deployment/2026-11-05-repo-vs-server.md](../docs/deployment/2026-11-05-repo-vs-server.md)（§5）

## 边界

- 真实 `env.list`、TLS 私钥、生产数据在服务器上，不进仓库；
- 部署脚本运行版在服务器 `/opt/vivic-preview-20261025/backend/`，本目录是仓库副本/模板；
- 前端发布是独立流程，见 `online-patches/` 与 `tooling/release/README.md`。
