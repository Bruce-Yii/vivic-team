# 部署记录：批次 1（观测与缓存）

- 时间：2026-11-05 19:31（Asia/Singapore）
- 部署 sha：`dc053c89161758974aea06a29d6a84a2318820bd`
- 分支：`release/b1-observability`（基于线上 `7918e99` + token 计量提交）
- 镜像：`vivic-api:dc053c89161758974aea06a29d6a84a2318820bd`
- 备份：`backups/db-20261105T193110-813922`
- 回滚点：上一版容器 `vivic-api-prev`（`vivic-api:7918e99...`），`bash backend/rollback.sh` 可切回

## 部署方式（重要，后续批次沿用）

线上 `deploy.sh` 会先跑 `required-overlays/connection-qrcode-20261031-1/apply.py`，它要求 `connections/*.ts` 是「原始版」或「QR 增量版」的固定哈希。当前 `7918e99` 的这些文件已被 11-03 部署覆盖过，直接 `git archive` 会因哈希不匹配被拒（失败信息：`Conflicting change in connections/cli.ts`）。

本次采用的方式：

1. 从服务器取**正在运行的 bundle**（`backend/bundles/7918e99...`），它已经包含 QR overlay；
2. 用 `git diff 7918e99 dc053c8` 把本批次改动的文件覆盖进去（只动观测相关文件）；
3. 重新打包成 deploy 期望的 tar（三个运行时目录），上传并执行 `deploy.sh <sha>`。

这样 overlay 看到的是「已应用版」，不再冲突。**批次 2/3 也按这个方式打包**，不要直接 `git archive`。

## 验证

- `DEPLOYED` 已更新为 `dc053c8...`，`/healthz` = 200；
- 意图遥测开始出现 token 字段，例如：
  `"tokens":{"input":7046,"output":77,"cacheHit":2816,"cacheMiss":4230,"model":"deepseek-flash","turns":1}`
- 线上 60 条：**58 / 60**，与批次 1「行为不变」的预期一致；两条失败是批次 2 才修的旧行为：
  - sc-49（查询+建卡同回合，旧版只能澄清）
  - sc-59（传送到用户页没有工具入口）
- 口播首句 34/60 不达标：批次 1 未改回执协议，属预期；批次 2 的 act→observe→speak 会修。
