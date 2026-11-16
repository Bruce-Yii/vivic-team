# tooling：可复现资产（验收 / 发版 / 汇报）

这个目录存放**运行时不参与、但复现和交接必需**的东西。之前它们散落在本机 `work/` 下（被 gitignore），机器一换就丢；现在收进仓库。

## 内容

| 目录 | 内容 | 用途 |
|---|---|---|
| `acceptance/` | 60 条验收套件、判分规则、场景数据集、48 题批量脚本 `scenario-batch.mjs` | 对本地或线上后端跑验收 |
| `release/` | 发版 v2 脚本、Dockerfile、nginx 上游补丁、预编译脚本、前端发布锁 `publish-lock.sh` | 复现后端发布与前端 release 切换 |
| `reports/` | 7 份阶段汇报 + 前端交接文档 | 工作量/根因/对比记录，交接材料 |

## 不含凭据

- 验收脚本的账号 cookie 从仓库外的 `work/product-account-session.json` 读取，仓库里没有；
- 发版脚本只写路径与环境变量名，不写 key；
- 数据集是用户话术和画布描述，不含账号信息。

## 使用提醒

- `acceptance/` 默认指向线上；跑本地时用 `VIVIC_ACCEPT_BASE=http://127.0.0.1:<port>`；
- 结果目录用 `VIVIC_ACCEPT_OUT` 指定，避免覆盖历史结果；
- `release/` 只描述方法，**不包含服务器凭据**，真正发版需要服务器上的 `deploy.sh` / `env.list`（见 `docs/deployment/`）。
