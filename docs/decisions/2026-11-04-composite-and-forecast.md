# 复合句"查询 + 建卡"与明日天气（2026-11-04）

> **2026-11-05 更新（查询协议已被取代）**：`search` / `weather` / `read_url` 改为只读、
> 必须单独调用，结果只回灌一次，出卡与回答由模型决定；本文 §1–§3 的
> 「lookup 与建卡同批 + 宿主合并 envelope」不再成立。
> 见 `2026-11-05-query-tools-are-read-only.md`。§4 起的天气 7 天 daily/「明天」部分仍有效。

- worktree：`work/backend-merge`（`codex/live-backend-20261103`），基线 `ed5b8b1`。
- 依据：`docs/decisions/2026-11-04-single-decision-authority.md`（模型决定，宿主推导/校验/执行）。
- 不做：不部署、不碰服务器、不跑线上验收（60/48 一条都没跑）；本轮只跑单测、typecheck、oxlint。
- 本轮两条：P1 复合句允许 lookup 与建卡同批；P0 天气适配器接 7 天 daily 并支持"明天"。

## 1. 为什么原来只能二选一

工具面的 `search` / `weather` 在 `planFromToolCalls` 里显式拒绝与任何建卡/画布操作同批：

```ts
if (actions.length || created.length || hostOperation) return fail("search 必须单独一批…");
```

于是"查一下最近 AI 大新闻，顺便加个待办跟进"这类句子只有两个坏结果：把查询降级成一张
`SearchResultCard` 丢掉待办，或只建待办、假装查过。这不是模型能力问题，是宿主把工具面
写成了互斥闭集。

## 2. 复合句：一次响应，宿主按顺序执行

### 2.1 映射层（`intent/toolCalls.ts`）

- lookup 在进入建卡循环**之前**解析一次（最多一个；`search` 与 `weather` 仍互斥），
  `ToolCallPlan.lookup` 与 `actions` 可以同时存在。
- 建卡参数校验失败时返回的 `invalid` / `clarify` 计划会带上 `lookup`，pipeline 因此知道
  "模型还要查询"，可以先把查询执行掉再回灌。
- 顺序由宿主决定：**先 lookup，后建卡**，与模型返回顺序无关（卡片的构建是纯函数，不产生
  副作用；真正的提交顺序由合并后的 envelope 决定）。
- `weather` 增加可选 `day: "today" | "tomorrow"`；城市或日期仍只来自用户原话。单句
  天气请求里用户已经说了"明天"时，宿主按自己的日期推导补上 `day=tomorrow`（与相对日期
  换算同一类"推导"，不是替模型写内容）；复合句不猜，避免"明天"属于另一个分句。

### 2.2 执行与合并（`intent/pipeline.ts`、`intent/envelope.ts`）

- lookup 走与纯查询完全相同的验证链（`runIntent(..., adapterOnly)`），没有新增凭据、
  代码或网络能力。
- `mergeEnvelopes` 把已验证的查询 envelope 放在前面、模型建的卡片放后面；一次
  `stage.awaken`、一次镜头移动（多卡时丢掉逐卡 focus，末尾一个 `canvas.fit`），
  `spokenText` 按执行顺序合并（"已整理 N 条结果，已创建 M 张卡片"）。
- lookup 失败/为空：**同批的独立建卡照常提交**，口播追加一句"查询没完成：…"；不重试、
  不拿失败结果当答案、也不静默吞掉。
- 合并后超过 envelope 上限（12 条动作）时不静默丢卡：提交卡片并说明"查询结果太多，
  没能和卡片一起放上画布"。

### 2.3 依赖缺失只回灌一次

模型把依赖查询结果的建卡参数留空（例如 `create_todo(items=[])`）时：

1. 宿主先执行 lookup；
2. 把**已验证的查询结果**作为"工具结果"拼进一次追加用户回合（`lookupFollowUpPrompt`），
   连同宿主的校验错误一起回传；
3. 模型只返回修正后的工具调用，宿主照常重新校验并建卡；
4. 仍缺 → 宿主澄清，且澄清必须写明缺什么（`lookupClarifyMessage` 带上 plan.message 与
   issues；`create_todo` 的空列表现在直接说"待办条目不能为空"）。

边界：

- **宿主不代写卡片内容。** 回灌的是事实（当前温度、明天 5~12°C、降水 30%、检索标题/摘要/URL），
  卡片的每个字段仍然来自模型自己的参数，由既有 card contract 构建。单测直接断言卡片正文
  不包含 `降水概率` 之类的证据原文。
- 追加回合最多 1 次（`VIVIC_TOOL_REPAIR=off` 时 0 次）。模型在追加回合里再次调 lookup
  不会被执行第二次。
- 纯查询（batch 里没有卡片）路径完全不变：仍是 `kind: "lookup"`，adapter 拒绝仍是
  `issues` + 1 次修复轮 + `vendor-unavailable` 兜底。
- 旧规划器（`prompt.ts` 的 JSON `lookup`）仍是单用途输出；on-mode 任务调度里的
  `tools.weather(city)` 也没有改，它们是没有工具面的降级路径。

### 2.4 遥测

`IntentPath` 增加 `tool-lookup`：一次响应里查询 + 建卡、且发生了"结果回灌"的追加回合。
`IntentLogSink.lookup = { tool, outcome: "ok" | "empty" }` 与 `repairs` 一起写进每请求
一行 JSON；没有追加回合的复合批次仍是 `tool`。既有 `tool` / `tool-repair` / `planner`
/ `legacy` 语义不变。

## 3. 明日天气：同一适配器，多取 7 天

### 3.1 请求与解析（`data/weather.ts`）

```ts
forecast_days: "7"
daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max"
```

`current` 参数一字未改（现有当前天气行为不变）。`daily` 的每个序列都是可选的、每个值都
允许 null：

- 缺 `daily` 或选中的那天缺最高/最低/天气码 → `forecastDay` 不产出，卡片**降级为当前天气**
  并在口播里说明"没取到明天的预报"；
- 缺降水概率 → 该字段不展示（不是 0）；
- 未知天气码 / 最高 < 最低 → 跳过该天，不编默认值。

"明天"是**地点自己的明天**：daily 是 GMT 日期，宿主用 GeoNames 返回的 `timezone`
把 `now` 换成当地日期再 +1，所以上海凌晨 4 点问"明天"不会因为服务器在 UTC 而错一天。
`utc_offset_seconds` 仍是 `z.literal(0)`（保持 `timezone=GMT` 的既有断言与行为）。

### 3.2 卡片

- `WeatherEvidence` 增加 `day?: "tomorrow"`、`forecastDay`、`forecast[]`（7 天，证据）。
- `weatherCardFields`：明天卡片 `displayProps.tempC` = 明天最高温（真实值），图标 = 明天的
  WMO 码；`sourceData.forecastDay = { date, tempMaxC, tempMinC, weatherCode,
  precipitationProbability? }`，`sourceData.forecast` 放整条 daily 证据。
- Web `WeatherCardView` 只在 `sourceData.forecastDay` 存在时显示"明天 5~12°C，降水 30%"；
  当前天气卡片渲染完全不变（既有单测逐字断言 `-3.5°C`）。
- 当前天气卡片的 payload、口播、来源标题都保持原样；只有明天卡片把来源标题改成
  "Open-Meteo daily forecast (model data)"。

### 3.3 输入与降级

`parseWeatherInput` 支持"明天/明日"（`day: "tomorrow"`），并保留对昨天/前天/后天/未来/
下周/本周/一周/小时/早上/晚上/今晚的明确拒绝（`当前天气` 里的"前天"用负向断言避开）。
"后天"及更远仍不支持，错误信息改为"目前只支持当前和明天的天气"，不再把当前天气冒充明天。
`continueWeatherInput` 在补城市名时保留原来的 `day`。

## 4. 测试

新增 `apps/local-api/tests/tool-composite-lookup.test.ts`（6 条，假 provider）：

- 一次响应 search + todo：一个模型回合、一个 envelope、查询卡在前待办在后；
- lookup 失败：待办仍提交，口播"查询没完成"，不额外调用模型；
- 依赖缺失：天气结果回灌恰好一次，第二次请求里含 `5~12°C`，卡片正文是模型自己的话；
- 回灌后仍缺：`clarify` 说明"待办条目不能为空"，没有卡；`path=tool-lookup`、
  `repairs=1`、`lookup={tool:"weather",outcome:"ok"}`；
- 参数齐全的复合批不浪费回灌回合；
- 纯查询回归不变。

新增 `apps/local-api/tests/weather-forecast.test.ts`（7 条，fixture 响应）：

- `forecast_days=7` 与四个 daily 字段的 URL 断言、明天行解析（含最高/最低/天气码/降水）；
- 地点时区选择明天（GMT 日窗与当地日期错位时仍取当地明天）；
- 无 `daily` → 降级当前天气并口播"没取到…当前天气"；
- 缺最高温的明天行被跳过；当前天气卡片 payload 逐字不变；
- `parseWeatherInput` 的明天/当前/后天边界；
- `handleDataIntent("明天南京天气")` 产出带 `forecastDay` 的 `WeatherCard` 与明天口播。

更新既有测试：`data.test.ts` 把"明天"从"未来天气拒绝"清单移出（保留昨天/后天/未来一周/
混合句）；`clarification.test.ts` 增加"补城市时保留明天"；`tool-surface-accept60.test.ts`
的 sc-21 现在断言适配器被要求 `tomorrow`；`tool-repair.test.ts` 的空待办错误文案改为新的
"待办条目不能为空"（不是放宽断言）。

## 5. 验证

实际跑的命令与结果（日志在 `work/verify/composite/`）：

- 定向：`npx vitest run tests/tool-composite-lookup.test.ts tests/weather-forecast.test.ts
  tests/tool-calls.test.ts tests/tool-repair.test.ts tests/tool-surface-accept60.test.ts
  tests/data.test.ts tests/clarification.test.ts tests/intent-log.test.ts` 全绿；
- 全量 `pnpm --filter @vivic/local-api test`：
  - HEAD `ed5b8b1` 基线：**32 failed / 2943 passed / 3 skipped（2978）**，13 个文件失败；
  - 本轮：**32 failed / 2956 passed / 3 skipped（2991）**，同样 13 个文件失败；
  - `Compare-Object` 逐条比对失败集合：**差集 0**（清单 `baseline-failures.txt`、
    `after-failures.txt`）；新增的 13 条断言全部通过（6 复合 + 7 天气）。
- `pnpm --filter @vivic/local-api typecheck`：仅既有 2 个错误
  （`tests/accept60-regressions.test.ts:196`、`tests/helpers.ts:8`）。
- `pnpm --filter @vivic/web typecheck`：仍是既有的 `stage.sleep` / ControlApp 等存量错误，
  与本轮改动无关（stash 到 HEAD 后同一组错误；`WeatherCardView.tsx` 无新增错误）。
- Web 卡片测试：`npx vitest run src/cards/__tests__/dataCards.test.tsx
  src/location/__tests__/liveWeather.test.ts` → 54 passed（含新增 2 条 forecast 渲染）。
- `npx oxlint` 改动文件（15 个）：**0 warnings / 0 errors**。

## 6. 仍未做

- 多日预报卡片（未来 3/7 天列表）只留了 `sourceData.forecast` 证据，没有新卡型；
- 旧规划器与 on-mode 任务调度的 `lookup` 仍是单用途输出（它们没有工具面可重选）；
- 线上 60/48 验收未跑（硬约束），`VIVIC_TOOL_CALLS` 仍是本地实验开关。
