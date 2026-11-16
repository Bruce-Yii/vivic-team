# 部署记录：批次 2（架构与协议，含批次 3 的数据能力）

- 时间：2026-11-05 19:42（Asia/Singapore）
- 部署 sha：`069b2dcb27e1cfbf921e4d3d2d5aeae75642d35f`（分支 `codex/live-backend-20261103` HEAD）
- 上一版：`dc053c8`（批次 1），容器 `vivic-api-prev` 可回滚
- 镜像：`vivic-api:069b2dc...`
- 备份：`backups/db-20261105T194218-815787`
- 健康：`/healthz` 200、首页 200，磁盘 35G/40G（剩 5.0G）

## 范围说明

批次 2/3 的提交在历史上是交错的，无法在不大量 cherry-pick 的前提下干净拆开，因此本次一次性部署了分支 HEAD：架构收口 + 工具面 14 + 回执协议 + 查询只读 + find_cards + 通用卡 + 图片路径 + Bing 搜索 + 金价 + IP 城市 + 天气 7 天 + 评分/日期契约。

- 这等于 **批次 2 + 批次 3 合并上线**；
- 批次 3 的数据能力默认已生效（`VIVIC_SEARCH_PROVIDER` 未设置 = auto，先 Bing 后 Exa；`VIVIC_TRUST_PROXY_IP` 未设置 = on，但 Docker 端口发布导致拿不到客户端 IP，会安全回退为追问城市）。

## 部署方式

沿用批次 1 的方法：取正在运行的 bundle 作底（`bundles/dc053c8`，已含 QR overlay），用 `git diff dc053c8 069b2dc` 覆盖三个运行时目录，再打包上传执行 `deploy.sh`。不要直接 `git archive`（QR overlay 会拒绝）。

## 验证

- 线上 60 条：**59 / 60**；唯一失败 sc-48（模型直接执行了“勾牛奶 + 删天气卡”，期望是整句澄清；本地同版本曾通过，属抽样波动）。
- 口播首句不达标：**2 / 60**（批次 1 是 34/60，回执协议已生效）。
- p50 **1807ms**、p95 5937ms。
- 遥测：缓存命中约 **98.8%**（例如 input 14893 / cacheHit 14720）。
- 日志里唯一的 `error` 是 `dropped-clause` 校验（宿主正确拒绝了没执行的子句），不是崩溃。

## 回归方式

```
bash /opt/vivic-preview-20261025/backend/rollback.sh   # 切回批次 1（dc053c8）
```
数据不回滚。

## 已知前端兼容风险

旧前端仍是 11-03 的 release，新后端可能产出旧前端不认识的东西：

- `TodoCard` 空条目（“新建清单”类请求）——旧前端 schema 可能拒收；
- 通用卡的 `sourceData.vicicStyle`（旧前端会忽略，不报错）；
- 评分小数（`VIVIC_DECIMAL_RATING=off` 已兜底）。

建议前端 release 尽快跟上；在此期间如遇到相关卡片异常，可先回滚或用开关关闭。
