# 60 条验收套件

## 文件

- `accept60.mjs`：主套件。向 `POST /api/intent` 发送 60 条指令（带合成画布），记录响应与耗时。
- `accept60-rules.mjs`：判分规则（卡型任一匹配、澄清、路由不可观测记 N/A、产品变化标记等）。
- `judge.mjs`：判分入口（与 `accept60.mjs` 配套）。
- `scenarios-20261031.json`：60 题数据集 + 画布定义 + 期望值 + 产品变化备注。

## 运行

```bash
# 线上
node tooling/acceptance/accept60.mjs

# 本地后端（推荐联调/回归）
VIVIC_ACCEPT_BASE=http://127.0.0.1:8796 \
VIVIC_ACCEPT_OUT=./acceptance-out \
node tooling/acceptance/accept60.mjs
```

## 账号 cookie

脚本从仓库外的 `work/product-account-session.json` 读取（字段 `cookie`）。
本地后端要能通过该 cookie 认证，通常要用**同一份数据副本**启动本地实例。

## 判分口径（重要）

- 路由层：4B 分类器已删除，`trace.route` 恒为 null → 记 N/A，不扣分；
- 卡型：期望集合内**任一**出现即通过；
- `card_optional`：允许“回答/追加”代替新建卡，但**工具失败形态不算通过**；
- 产品变化：如 sc-49/sc-52/sc-47 已在数据集 notes 里注明，按产品变化处理。

## 已知波动

模型有抽样波动：同一版本 6 轮结果在 58–60 之间；出现单条失败先看是 `fail-transport`（网络）还是行为差异。
