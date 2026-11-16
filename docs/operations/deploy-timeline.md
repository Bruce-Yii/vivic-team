# Vivic 线上发布/部署时间线（2026-11-01 23:26 → 2026-11-03 17:57，Asia/Singapore）

> 只读分析产物。数据源：`work/session-aacee514.jsonl`（8,184 个 JSONL 事件：1,227 条 `tool/call`、1,236 条 `tool/result`、59 个 turn）。
> 生成脚本：`work/audit/build-timeline.py`。本文件不含任何明文凭据。

## 0. 一句话结论

- 会话期间共 **19 次后端 `deploy.sh` 调用**（12 个不同 sha）、**4 次前端 `publish-lock.sh switch`**，其中 **1 次后端部署失败**（11-02 20:33，overlay 校验拒绝），另有 **1 次“假生效”**（03:09 代码被 overlay 覆盖）。
- **会话中没有执行过任何回滚**：`rollback.sh` 全程未跑，只被读过一次（11-03 03:08）；前端也没有切回旧 release，两次线上异常都是“就地修复”。
- **截至会话结束（11-03 17:57）线上状态**：后端 sha **`e6a8909f9e77fe476c194481c04cd630f4019358`**（15:32 部署），前端 release **`sections-20261103-final`**（11:33 切换）。
- 会话最后 4 个 turn（56–59）**没有产生任何部署**：56 的子代理成果（习惯打卡快通道）只落在本地 `work/backend-merge`，随后上下文撑爆（1.11M tokens > 1M 上限）连续 400，会话终止。

---

## 1. 全部发布/切换动作（按时间排序）

时间均为 Asia/Singapore（= 服务器本地时间 UTC+8）。`时间` 取会话事件的 `time`；后台任务的结果时间在「结果」列注明。

| # | 时间 | 类型 | 后端 sha / 前端 release | 结果（tool/result 关键证据） | 本次包含的改动 |
|---|------|------|--------------------------|------------------------------|----------------|
| 1 | 11-02 12:28 | 前端 release 切换 | `sections-20261102-1`（前一版 `voice-wake-toggle-20261101-1`） | `SWITCHED` 成功，但随即 `root 500` / `patch-js 404` / `patch-css 404`；12:29 `chmod 755/644` 后 `root 200`、`patch-js 200`、`patch-css 200`，index 含补丁引用 | #21 sections 的**前端双向兼容层**（读时剥离 `displayProps.sections`、写时注入回 payload、补丁侧渲染），新增 `sections-view.js`（`f6f984a4…`）与 `sections.css`（`ac28c9b1…`），index 只加 2 行注入；release 共 4003 个文件（旧 4001 + 2） |
| 2 | 11-02 12:31 | 后端部署 | `ddeaa766c79d1c5671d803b3224b01cd0eeeb7c3` | `DEPLOY_OK`；`DEPLOYED` = `action=deploy`、`backup=/opt/…/backups/db-20261102T123042-401558`；容器 `vivic-preview-20261027` 起、`healthz` 正常 | 把 #22 工具层合进线上后端基线（基础镜像仍是 `e46222d`，只覆盖 `apps/local-api/src` + `packages/contracts/src` + `packages/card-runtime/src`） |
| 3 | 11-02 12:32 | 后端部署 | `ddeaa766…`（同 sha 重部署） | `DEPLOY_OK`；镜像 digest 变成 `a7334d14…`（与首次 `4ce9f7e6…` 不同，是 bundle 重打包导致，代码未变） | 无源码变化，验证 deploy.sh 可重入 |
| 4 | 11-02 12:35 | 后端部署 | `ddeaa766…` + env 改回 off | `VIVIC_TOOL_CALLS=off`、`VIVIC_SECTIONS=off`；`DEPLOY_OK`；`backup=backups/db-20261102T123438-403566` | 同一 sha，仅 env.list 两个开关翻回 off（当时正在排查 DeepSeek 402） |
| 5 | 11-02 13:15 | 后端部署 | `ddeaa766…` + env 打开 | `VIVIC_TOOL_CALLS=on`、`VIVIC_SECTIONS=on`；`DEPLOY_OK`；`backup=backups/db-20261102T131520-408379`；13:17 `home=200`、`healthz` ok、`live smoke 11/11` | 新 DeepSeek key 生效后正式开工具层 + sections，端到端验收 |
| 6 | 11-02 20:33 | 后端部署（失败） | `44bbb9be7c59e2acc2663023386ab6f68e640a3b` | **失败**：`RuntimeError: Conflicting change in connections/cli.ts; merge the reviewed QR increment before deployment`（`required-overlays/connection-qrcode-20261031-1/apply.py`），容器未切换 | B2 空格修复：`intent/scheduledReminders.ts` 的 `clock()` 允许数字与 `点/分`/`:` 之间有空格（“明天上午 9 点提醒我开会”） |
| 7 | 11-03 00:43 | 后端部署（重试成功） | `44bbb9b…` | `DEPLOY_OK`；`backup=backups/db-20261103T004256-469084`；`home=200` / `healthz=200`；00:48 `live smoke 11/11` | 同 B2 空格修复；bundle 改为“以线上 `bundles/ddeaa766…` 为底，只替换 5 个哈希校验文件（`connections/*.ts`、`online/sessions.ts`）后重打包”，overlay 变成 `changes: []` 的 no-op |
| 8 | 11-03 03:09 | 后端部署 | `3923b85cc7eead37a6590db72dac4bc4aba8cc20` | `DEPLOY_OK`；但这一版把 6 个 overlay 文件都换成了线上版本，我们改的 `hosted/service.ts` 被覆盖，`VIVIC_DECISION_MODE` 代码实际缺失 | 关闭旧 4B 路由的代码开关（`hosted/service.ts` 不再强制 `mode:"on"`）+ 模板工具提示“内容说清就直接建卡、别追问” |
| 9 | 11-03 03:11 | 后端部署 | `3923b85…` + `VIVIC_DECISION_MODE=off` | `16:VIVIC_DECISION_MODE=off` 写入 env.list；`DEPLOY_OK`；容器内代码仍未含开关 | 仅 env 变更 + 重部署（同一 sha） |
| 10 | 11-03 03:13 | 后端部署（修正后重部署） | `3923b85…`（重打包） | 先 `grep -c VIVIC_DECISION_MODE …/hosted/service.ts` 命中再 `RETAR_OK`，03:14 `DEPLOY_OK`；03:15 `home=200/healthz=200`、`live smoke 11/11` | 同一 sha 的 bundle 重新打包：只替换 5 个哈希校验文件，**保留我们改过的 `hosted/service.ts`**，让 overlay 对它做文本增补 |
| 11 | 11-03 03:32 | 后端部署 | `b53803230828b7e15f97592f9ac4d74c89b5d943` | `DEPLOY_OK`；03:34 `live smoke 11/11` | 卡片摆放修复：抽出 `placeNewCards(actions, canvasContext)`，在 `runIntent` settle 时给所有 envelope 的 `card.create` 补 layout（规则直通/工具/复合都覆盖），按 1440×900 二维寻空、pinned 不动 |
| 12 | 11-03 03:38 | 后端部署 | `1f09f0e2e2ab7d887a419593a4ba84feaaffffb3` | `DEPLOY_OK`；03:40 `live smoke 11/11` | 摆放修复第二版（按相机原点/视口细化坐标，确保新卡与已有 40 张卡无一相交） |
| 13 | 11-03 03:58 | 前端 release 切换 | `sections-20261103-clock`（前一版 `sections-20261102-1`） | `SWITCHED`，随后 `readlink -f frontend-current` 返回 clock 的 `web` 路径；下一分钟的全量 smoke 为 `11/11` | 倒计时时钟补偿第一版：按响应 `Date` 头算 offset，只对倒计时卡字段平移（`sections-view.js` `a594c237…`，**无**读→写还原表） |
| 14 | 11-03 04:04 | 后端部署 | `fd297b4a67e32cb8293b2922ae4d90cc37b7adf7` | `DEPLOY_OK`；04:08 `live smoke 11/11` | 追问污染修复：新增 `decision/continuation.ts` 判定“回答 vs 新指令”，命中新指令时旧任务置 cancelled、丢 continuation、按新请求执行；hosted tasks 不再 409 |
| 15 | 11-03 04:13 | 前端 release 切换 | `sections-20261103-clock2`（前一版 `sections-20261103-clock`） | `SWITCHED` 行被 `tail -3` 截断；随后实测 `sections-view.js` sha256 `338a3705…`、`home=200`（04:15 smoke 11/11） | 时钟补偿最终版：加“读→写还原表”，保存前把字段平移回去，服务端存储字节不变；死区 2s、三层 kill switch；自测 12/12 |
| 16 | 11-03 11:30 | 后端部署 | `f0b794f3174cacb705c581326878767ff0e815cd` | `DEPLOY_OK`；11:31 复查 `VIVIC_TOOL_CALLS=on`、`VIVIC_DECISION_MODE=off`；11:40 `live smoke 11/11` | 第二批落地：模板工具合并到 4 个、纯操作快通道（显示全部/撤销/重做/恢复视图/自动整理，0 模型）、工具失败不再静默回落、删除直执（`deleteTarget.ts` 三态）、`intentLog.ts` 遥测、回复风格（warm）、`/api/speech` 流式 |
| 17 | 11-03 11:33 | 前端 release 切换 | `sections-20261103-final`（前一版 `sections-20261103-clock2`） | `SWITCHED` 行同样被截断；实测 `sections-view.js` `3d280b39…`、`ControlApp-…-v62.js` `31bc6ff3…`、`home=200` | 前端两处：canvas 写 409 → 重拉画布 + 合并 + 同 requestId 重试一次（版本冲突自动重拉）；`ControlApp` chunk `w.length<=80` → `<=400`（追问上下文不再被丢） |
| 18 | 11-03 11:46 | 后端部署 | `f0b794f…` + `VIVIC_LEGACY_FALLBACK=on` | `24:VIVIC_LEGACY_FALLBACK=on`；`DEPLOY_OK` | 把旧规划器兜底重新打开（实测关掉后 48 条里 6 条“本可出卡”变澄清） |
| 19 | 11-03 12:07 | 后端部署 | `e80e648605524fa6d78fa82f1602898fa45e788f` | `DEPLOY_OK` | 工具层补齐 scene/template 输入再校验：示例、评分/打卡归一化、可选字段（`fix(tools): build complete scene/template inputs instead of re-asking`） |
| 20 | 11-03 12:09 | 后端部署 | `44ea1f9f33e14fcc8eddd9a4405f9e6e9618b617` | `DEPLOY_OK` | 撤回“习惯打卡 weekday 推导” grounding 门（把明确句子变成报错/澄清），恢复到只认原话星期词/区间 |
| 21 | 11-03 12:48 | 后端部署 | `2663d30c0c1062df77a736f47acb365e6fdd5dbc` | `DEPLOY_OK`；12:50 `live smoke 11/11`；实测书籍 4.5 → BookCard rating 5 + notes“评分 4.5” | 回复风格收敛为 `warm`/`normal` 两种；书籍半星归一化；习惯打卡按本周一换算 ISO；追问泄漏第三类判定（名词性开头/结构化内容/长句） |
| 22 | 11-03 15:28 | 后端部署 | `0bbaed928d1633c456f0ecf0f31af4e09b175df0` | `DEPLOY_OK`；实测「删了它」真实页面直接删除、「删掉那张卡片」仍追问 | 工具层“校验→修复”循环（`VIVIC_TOOL_REPAIR` 默认开，遥测 `path=tool-repair`）；指代删除直执（`deleteTarget.ts` 用 focus 证据）；prompt 卡片 id 一致性 |
| 23 | 11-03 15:32 | 后端部署 | `e6a8909f9e77fe476c194481c04cd630f4019358` | `DEPLOY_OK`；15:33 线上实测 B12「习惯打卡：每天背单词，本周一到周三做到了」仍回 `clarify`「打卡要具体到日期：这周哪几天打了卡？」 | 相对星期换算（“本周一到周三”等不再追问日期） |

> 说明：前端两次切换（04:13、11:33）的 `SWITCHED` 行被命令里的 `tail -3` 截断，靠随后的资源 sha256 / `home=200` / `readlink` 和 `docs/decisions/*` 交叉确认；其余每条都能在结果里找到 `DEPLOY_OK` 或 `SWITCHED` 原文。

### 1.1 不是发布、但容易看错的动作

| 时间 | 动作 | 说明 |
|------|------|------|
| 11-02 12:28 | `publish-lock.sh run sections-20261102-1 -- bash publish-frontend-remote.sh …` | **prepare**：只生成候选 release，不切指针（结果里 `preparedOnly: true`、`PREPARED ONLY (not switched)`） |
| 11-02 20:33 / 11-03 00:43 等 | `upload-backend.py <tar> <sha>` | 只写服务器 `backend/uploads/<sha>.tar` 并校验 sha256，**不发布**；随后才 `deploy.sh` |
| 11-03 11:30 / 12:07 / 12:08 / 12:48 / 15:27 / 15:32 | `SHA=<sha> … for f in connections/*.ts online/sessions.ts; do cp …; done; tar -cf …; echo RETAR_OK; bash deploy.sh $SHA` | `RETAR`：用线上已部署 bundle 打底、替换 6 个 overlay 托管文件后再发布（绕开 LF/CRLF 哈希冲突） |

---

## 2. 备份产物（实测到的）

| 时间 | 产物 | 说明 |
|------|------|------|
| 11-02 12:30:42 | `backups/db-20261102T123042-401558` | 部署 `ddeaa766` 前（deploy.sh 自动做 DB 备份） |
| 11-02 12:34:38 | `backups/db-20261102T123438-403566` | 12:35 关 flags 重部署前 |
| 11-02 13:15:20 | `backups/db-20261102T131520-408379` | 13:15 开 flags 前 |
| 11-03 00:42:56 | `backups/db-20261103T004256-469084` | 00:43 部署 `44bbb9b` 前 |
| 11-03 03:08:26 | `backups/db-20261103T030826-481436` | 03:09 部署 `3923b85` 前 |
| 11-02 12:31:12 | `backend/env.list.bak-sections-20261102T123112` | 改 `VIVIC_TOOL_CALLS/SECTIONS` 前的 env 备份 |
| 11-03 03:11 | `backend/env.list.bak-decisionoff-20261103` | 改 `VIVIC_DECISION_MODE=off` 前的 env 备份（`cp -n`） |
| 每次前端发布 | `releases/<新 release>/web`（`cp -al` 硬链接自旧 release） | 旧 release 原样保留，可秒级切回；`publication.json` 记录 previous / index sha |
| 每次后端部署 | 旧容器改名 `vivic-api-prev`；失败容器 `vivic-api-failed-<ts>-<pid>` | 回滚目标 = `vivic-api-prev`（`backend/rollback.sh`） |

后端 `deploy.sh` 的固定流程（从脚本内容读出）：`flock deploy.lock` → 检查磁盘 ≥2 GiB → 校验 `env.list` 权限 600 → staging 容器（18891）健康/依赖导入/SQLite 校验 → 备份 DB → 旧容器转 `vivic-api-prev` → 起新容器 → `/healthz` 轮询 → 失败自动回滚。

---

## 3. 失败与异常（本次会话内）

| 时间 | 现象 | 根因 | 处置 |
|------|------|------|------|
| 11-02 12:27–12:29 | 切 `sections-20261102-1` 后 `root 500`、补丁 js/css 404 | `publish-frontend-remote.sh` 用 `umask 077` → release 目录 700、文件 600，nginx（非 root）`stat` 失败 | `chmod 755` 目录 / `644` 新文件（不碰硬链旧文件），约 2 分钟恢复；见 `docs/postmortems/2026-11-02-frontend-release-permissions.md` |
| 11-02 12:31–13:0x | 线上调用全 402 `insufficient_balance` | 公开仓库 `Bruce-Yii/vivic-latest-test` 里的 `.env.local` 泄露 DeepSeek key，余额被刷空 | 仓库转 private、旧 key 作废、换新 key（三处写入）；见 `docs/postmortems/2026-11-02-deepseek-key-leak.md` |
| 11-02 20:33 | `deploy.sh 44bbb9b` 失败，容器未动 | overlay `apply.py` 对 `connections/cli.ts` 做“已知 before 哈希”校验；本地 LF 包与线上 CRLF+QR 增量不一致 | 改用以线上 bundle 为底、只替换 6 个文件的 `RETAR` 手法，00:43 部署成功 |
| 11-03 03:09–03:14 | `VIVIC_DECISION_MODE=off` “看起来生效但其实没生效” | 误把 6 个文件都换成线上版本，我们改过的 `hosted/service.ts` 被覆盖 | 03:13 重打包只替换 5 个哈希校验文件、保留 `service.ts`，03:14 部署后真正生效；见 `docs/decisions/2026-11-03-decision-router-off.md` §部署注意 |
| 11-03 12:07–12:09 | 习惯打卡一度变成报错/澄清 | 前一版加了 weekday 推导的 grounding 门，把明确句子判成“日期不在原话里” | 12:09 部署 `44ea1f9` 撤回该门 |
| 11-03 15:32 之后 | B12「本周一到周三」仍 `clarify` | 模型主动选择澄清，不触发“校验→修复”循环 | 记入待办（确定性快通道方案 A）；17:38 起子代理实现，**未部署** |

---

## 4. 截至会话结束的线上状态推断

| 项 | 值 | 依据 |
|----|----|------|
| 后端 sha | **`e6a8909f9e77fe476c194481c04cd630f4019358`** | 15:32 最后一次 `DEPLOY_OK`（image `vivic-api:e6a8909…`）；15:33:54 助手总结也写“当前线上：后端 `e6a8909`” |
| 后端镜像 / 容器 | `vivic-api:e6a8909f9e77fe476c194481c04cd630f4019358` → 容器 `vivic-preview-20261027` | 同上；上一版容器为 `vivic-api-prev` |
| 前端 release | **`sections-20261103-final`** | 11:33 最后一次 `SWITCHED`；助手总结写“前端 `sections-20261103-final`”；`frontend-current` 未再变 |
| 工具层开关 | `VIVIC_TOOL_CALLS=on`（11-03 11:31 复查）；`VIVIC_SECTIONS=on`（最后观测 11-03 03:39，之后未见关闭 → 推断仍 on） | 会话内 `grep` 输出；SECTIONS 在 11:31 那次复查里没被 grep，故标为推断 |
| 决策路由 | `VIVIC_DECISION_MODE=off`（4B 已退出主链路） | 11-03 03:11 起；11:31 复查仍 off |
| 旧规划器兜底 | `VIVIC_LEGACY_FALLBACK=on` | 11:46 写入并 `DEPLOY_OK` |
| 工具修复循环 | `VIVIC_TOOL_REPAIR` 默认开（遥测 `path=tool-repair`） | 15:28 部署的代码 + 15:33 总结 |
| 最后一次全量 smoke | `live smoke 11/11`（12:50） | 15:28 / 15:32 两次部署后**没有**再跑全量 smoke，只做了针对性实测 |
| 未上线的本地改动 | 习惯打卡快通道（`intent/habitFast.ts` + `envelope.ts` + `build.ts` 的 `weekdayWordsIn`）、遥测聚合脚本、照片墙上传待办 | 17:39–17:55 子代理只在 `work/backend-merge` 改代码 + 测试，未 commit、未部署 |

**推断**：会话结束时线上可用——15:32 的 `DEPLOY_OK` 表示 `deploy.sh` 内置的 `home/healthz` 校验通过，之后没有任何发布动作改变线上；代码等价于“batch2 + 修复循环 + 相对星期换算”，不含 17:55 才完成的习惯打卡快通道，也不含 15:32 之后的任何改动。注意：15:32 之后**没有**再做独立的全量 smoke 或容器状态复查（我可用的最后一条独立证据是 12:50 的 `live smoke 11/11`）。

---

## 5. 没有被执行的动作

- `backend/rollback.sh`：**0 次执行**（03:08 只 `sed -n 1,60p` 读了脚本，用于确认回滚逻辑）。
- 前端切回旧 release：**0 次**（12:28 的 500/404 用 chmod 修复，没有回切）。
- `deploy-lock.sh` 手工加锁：未单独执行（`deploy.sh` 内部 `flock deploy.lock`；前端走 `publish-lock.sh` 的 `frontend-publish.lock`）。
- 数据库结构/数据变更：未执行（只有 `deploy.sh` 自带的 DB 备份；`decision_log` 只做读取排查）。
- 服务器 nginx 配置变更：会话内只对 `60-vivic-preview-20261025.conf` 做只读检查；前端切换只动 `frontend-current` symlink，没有触发配置改写的 reload（`publish-lock.sh` 每次都提示 “NEXT: nginx -s reload（仅当你同时改了 nginx 配置）”，本次不需要）。
- 服务器服务重启：只重启过 `quant-throne-api`（11-02 13:14，轮换 DeepSeek key 后），与 Vivic 发布无关。

---

## 6. 疑点与待确认

1. 11-02 12:31 的 `ddeaa766` 是否就是“#22 工具层 + 线上基线”的最终合并体：镜像 `FROM` 显示基线为 `e46222d`，bundle 只含 `apps/local-api/src`、`packages/contracts/src`、`packages/card-runtime/src`，与交接文档一致；但 `ddeaa766` 这个 sha 本身没有对应的 commit message 留在会话里（是子代理在 `work/backend-merge` 里产生的合并提交）。
2. 12:32 的同 sha 重部署是否为“误触”：结果 `DEPLOY_OK`、镜像 digest 变化但代码未变（bundle 重打包导致），按“确认动作”记录。
3. `sections-20261103-clock` 与 `clock2` 的 release 生成时间未单独记录（只有切换时间）；`clock` 的补丁 sha 为 `a594c237…`（见 `docs/decisions/2026-11-03-countdown-clock-compensation.md` 的注）。
4. 15:28 / 15:32 两次部署后没有全量 smoke，若需要“会话结束时的健康基线”，建议补跑一次（本次任务为只读，未连服务器）。

---

## 附录：产出与脚本

| 文件 | 作用 |
|------|------|
| `work/audit/build-timeline.py` | 生成本文件：机械提取 deploy/switch 事实 + 人工注解 + 交叉校验（注解事件与 JSONL 事实同分钟对不上就报错退出） |
| `work/audit/build-infra.py` | 生成 `infra-inventory.md`：掩码、行号、事实校验 |
| `work/audit/build-tail.py` | 生成 `session-tail-56-59.md`：turn 56–59 原文、回答、子代理/后台任务 |

复现：`python work/audit/build-timeline.py && python work/audit/build-infra.py && python work/audit/build-tail.py`（只读，不连服务器）。
