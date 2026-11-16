# 宿主召回，模型决策：目标解析交给模型（2026-11-04）

用户的裁决只有一句：**「模型有决策权，机械层凭什么跟模型抢？」「宿主不该否决模型选的目标」**，
后半句是**「模型看不到足够信息才会选错参数」**。本轮据此只改工具层
`apps/local-api/src/intent/toolCalls.ts`（+ 它自己的 `tests/tool-calls.test.ts`），不碰
`pipeline.ts` / `decision/*` / `data/*` / `packages/*` / `scenes/*`，不部署、不跑线上验收。

本文件**取代** `2026-11-03-tool-surface-and-targets.md` 的第 2 节（“句子点名的清单优先于模型
`card_id`”）、第 5 节（摘要只给 3 条条目、72 字截断）与第 6 节（`hostTarget` 用原话覆盖模型 id）。
那三处正是“宿主跟模型抢”的实现。

## 1. 目标：宿主不再裁决，只做召回

### 之前

`hostTarget(utterance, ctx, route)` 对每个 targeted 工具先跑一遍原话匹配：

1. 条目文本命中 → 用宿主解析出的 `targetId`（+`itemId`）；
2. 原话无卡片指代 → 保留模型 id；
3. 否则 `resolveTarget()` 复核：**唯一命中就覆盖模型 id**，多命中就带编号反问，
   `missing` 直接 `invalid`（“画布上没有能对上这句话的卡片”）。

模型的 `card_id` 只在“原话什么都对不上”时才有意义——决策权实际在机械层手里。

### 现在

`cardFor(modelId, { type?, useEntry?, question })`：

| 输入 | 行为 |
|---|---|
| 模型给的 id 在画布上、类型符合工具要求 | **直接采用**，原话点名另一张卡也不覆盖 |
| 模型给的 id 在画布上但类型不符（如对 NoteCard 追加条目） | `invalid-param` + 该类型候选，模型改选 |
| 模型给的 id 不在画布上 | `unknown-card` + `targetCandidates`（真实卡的 id/标题/条目含条目 id，≤5），进一次修复轮 |
| 没给 id，条目级工具（`update_todo_item`） | 允许按原话把**条目**唯一地落到某张卡（确定性推导）；对不上就召回，不反问 |
| 没给 id，其他 targeted 工具 | `missing-param` + 候选（`focus_card`/`delete_card` 的 schema 本来就必填） |

召回时把候选写进 **issue 的 message**（`标题(id)`），不只放在 `plan.targetCandidates` 里：
管线的修复轮只把 `issues` join 成一段文字交给模型，结构化字段到不了模型手里。条目级召回同样
在 message 里列出该卡的 `条目(item-id)`。

`cardFor` 取代 `hostTarget`/`resolveHostTarget`，`decision/target.ts` 的 `resolveTarget`、
`hasExplicitCardReference` 不再从这个文件里调用（仍供决策路径使用）。`uniqueCanvasMatch` 只剩
两处用途：拒绝一个**不必要**的 `clarify(missing=target)`，以及 `create_todo` 的召回提示。

### 条目级：卡定了，条目按原话对

`highlight_card` / `update_todo_item` 在**模型选定的那张卡**内解析条目：

- 模型给了 `item_id` → 先按 id、再按条目原文匹配（模型填文本是常见行为，纠正不拒绝）；
- 没给 → `namedEntryOf(card, utterance)` 在原话里找这张卡的条目（最长命中的那个）；
- 都没有、但原话点名的是另一张卡的条目 → `entryRecall(card, …)`：**回传这张卡的条目**
  （`鸡蛋(item-1)` 这种带 id 的形式）+ 结构化 `unknown-card`，模型改 `item_id` 或改卡；
- 没有任何条目指代 → 整卡高亮（`highlight_card` 的 `item_id` 本来就是可选）。

即：**“卡选对了、条目对不上”是信息问题，用信息回答；只有“卡/条目都推不出来”才是问题。**

### 删除

- 有效 `card_id` → 直接产出 `card.delete`（确认门仍在 `pipeline.ts`，不是语义中断）；
- `card_id` 不在画布且整批只有这一个调用 → 才用 `deicticDeletion` 的纯指代（“删了它”→ 当前聚焦卡）；
- 其余 → 召回候选，不猜。
  内容点名了另一张卡（“删除周报的卡片”+ghost id）不会退化成删除聚焦卡。

### 追加条目的 `create_todo`

- 有 `card_id` → 就按模型选的卡追加，原话点名别的清单**不再覆盖**；
- 没有 `card_id`、但原话带追加动词且点名了唯一一张清单 → `missing-param` + 清单候选
  （含每张卡的条目 id），让模型补 `card_id`；不再由宿主替模型 append。

## 2. 画布摘要：给全信息，模型才选得对

“模型看不到足够信息才会选错参数”的落点是 `buildToolSystemPrompt` 的卡片行：

- 每张卡：`- id (Type) 「标题」 @x,y WxH [固定] [当前聚焦] 条目：文本(item-id)/…`
- **条目文本 + 条目 id** 都在：模型可以自己把“买牛奶”对到 `本周待办` 的 `item-2`，
  不必再靠宿主猜。带条目但没 id 的旧数据只显示文本。
- 条数预算：聚焦卡给全部条目（最多 30 条），其他卡给 6 条预览 + `/…还有N条`；
  行长度上限 220 字。摘要基数仍是 24 张，另补最多 3 张“最近聚焦但在窗口外”的卡（共 ≤27 张），
  保证 `最近聚焦` 里出现的每个 id 都能在摘要里查到。
- 焦点标记从“只有补进来的卡”扩展到**所有聚焦卡**：最新一张 `[当前聚焦]`，其余 `[最近聚焦]`。
- 摘要标题行写死“只用这里出现过的 id，不要编”，并说明 `[当前聚焦]` 就是用户刚看过的那张、
  条目括号里的 id 就是 `item_id`。
- 工具描述与系统提示的规则 4b 同步写明：**你填的 id 在画布上就按你的选择执行，宿主不会用原话覆盖；
  id 不在画布上时宿主把候选卡（含条目 id）回传给你重选。**
- 规则 11 从“多张卡都能对上时**必须** clarify”改成“先按标题和条目判断，真的分不出来再 clarify”：
  追问也是模型的决策，而不是宿主的强制。

## 3. 天气：未来 7 天内任意一天，模型自己选

`weather(city?, day?)` 的 `day` 不再是 `today|tomorrow` 枚举，而是用户怎么说的就怎么填：

| 写法 | 解析 |
|---|---|
| 不填 / 今天 / 今日 / 现在 / 当前 / `today` | 今天（offset 0，走适配器默认） |
| 明天 / 明日 / `tomorrow` | +1 |
| 后天 / 大后天 | +2 / +3 |
| 周X / 星期X / 礼拜X（裸写取下一次） / 本周X / 下周X / 上周X | 换算成具体日期后再算 offset |
| MM-DD / M月D日 / YYYY-MM-DD | 按 ISO 日期算 offset |
| 昨天 / 昨日 / 前天 | offset < 0 → 结构化 `invalid-param`（历史天气没有出口） |

- 窗口 = 今天 .. 今天+6（`WEATHER_WINDOW_DAYS = 6`）。窗口外或读不出日期 → 结构化 issue
  （`invalid-param`，hint 写“未来 7 天 / 今天明天”），**不会**悄悄变成“今天的天气”。
- 今天是/明天 → 交给 lookup（`day: "tomorrow"`）由既有验证链执行；单独一句带“明天”而模型没填
  `day` 时仍按原话推导（复合句不推导，避免把别的从句的“明天”算到天气上）。

### 已知边界（需要数据层/管线配合，本轮不在范围内）

`data/weather.ts` 的 `WeatherDay = "tomorrow"`、`pipeline.ts:lookupRequestText` 只会把
`day === "tomorrow"` 译成“明天”，所以**窗口内第 2..6 天目前只有解析、没有执行出口**：
本层给出 `unsupported` issue（“在 7 天窗口内，但宿主现在只能执行今天和明天的预报”，hint 指明
不要编、可改用 search），走一次修复轮后由模型如实说明。provider 本身已经返回 7 天 daily 数组
（`FORECAST_DAYS = 7`），要真正执行 第 2..6 天 需要同时放宽 `data/weather.ts` 的 `WeatherDay`
与 `pipeline.ts` 的 lookup 文本，两处都不在本文件范围——这是下一步，不是本层可以独吞的改动。

## 4. 复合句：查询与建卡同一批返回

系统提示已明确（规则 2b）：

- `search` / `weather` **可以和建卡工具同批**；宿主先执行查询，把结果作为**工具结果回灌**，
  模型再按结果填建卡参数；
- 不要因为“要先查一下”就放弃同一句里的建卡，也不要把查询原文照抄成卡片内容、更不要让宿主代写；
- 查询失败/超范围以 issue 回传，模型如实说明，不编。

few-shot 同时给了三条：`answer + create_todo`（特斯拉）、`search + create_todo`（AI 大新闻）、
`weather + create_todo`（明天南京 + 带外套），并写明“不要在‘先查还是先建’之间二选一”。

## 验证

- `pnpm --filter @vivic/local-api exec vitest run tests/tool-calls.test.ts`：**127 passed**。
  新增/改写覆盖：模型 id 合法不被覆盖（focus/delete/edit/arrange/追加）、id 非法回传候选
  （message 里带 `标题(id)`，结构化侧还有条目 id）、条目对不上回传该卡条目、摘要含条目 id 与
  聚焦标记、composite few-shot、weather 的 今天/明天/后天/周X/下周X/MM-DD/窗外/读不出。
- `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：**36 failed / 3001 passed / 3 skipped
  （3040）**；HEAD 基线是 32 failed / 2980 passed（3015）。失败清单见
  `work/verify/round6/after2-failures.txt`，与 `work/audit/baseline-failures.txt` 逐条对比**新增 4 条**，
  全部是 `tests/tool-surface-accept60.test.ts` 里钉住旧语义（宿主覆盖模型 id / 多命中反问）的用例：
  sc-30 高亮、sc-56 反问、sc-15 谷歌卡、谷歌双命中。它们是本裁决的直接对立面，该文件不在本轮修改
  范围（改写建议见 `work/verify/round6/tool-surface-accept60-rewrite.md`）。
- `pnpm --filter @vivic/local-api typecheck`：仅既有 2 个错误（`tests/accept60-regressions.ts:196`、
  `tests/helpers.ts:8`）。
- `pnpm exec oxlint apps/local-api/src/intent/toolCalls.ts apps/local-api/tests/tool-calls.test.ts`：0 warnings / 0 errors。

## 未决 / 需要裁决

1. **`tests/tool-surface-accept60.test.ts` 的 4 条旧语义用例**必须改写或删除，否则“失败集合与 HEAD
   一致”无法达成。它们不在本轮的允许改动范围内，已上报协调代理：建议
   sc-30 → 断言“保留模型选的购物清单 + 回传该卡条目候选”，sc-56/sc-15 两条 → 断言采用模型 id，
   另立“模型选对 id 时高亮正确的条目”用例。
2. **窗口内第 2..6 天的天气执行**需要 `data/weather.ts` + `pipeline.ts`（见 3 的边界）。
3. `decision/deleteTarget.ts:assessDeletion` 在任务流（`decision/taskV2.ts`）里仍会按原话
   refuse/retarget 一次删除提案。它属于 `decision/*`，本轮未动；工具路径本身已按模型 id 产出提案，
   两条路径要一致还需要该模块的负责方跟这一裁决对齐。
