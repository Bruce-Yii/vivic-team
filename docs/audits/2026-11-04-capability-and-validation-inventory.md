# 能力对账 + 校验对账（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`，HEAD `162ff12`）
- 范围：`packages/contracts`（只读，作为能力清单的事实来源）、`apps/local-api/src`、`apps/local-api/tests`、
  以及本文件。没有部署、没有碰服务器、没有跑 60/48、没有推送。
- 目的：把"验收撞出来的漏项"改成两张可复核的对账表，并让**新增能力/新增参数无法悄悄漏掉**：
  - 表 A：所有可执行宿主能力 → 有没有模型工具入口、入口是否唯一、执行器是否真的支持；
  - 表 B：所有接收指针/事实的工具参数 → 不存在 / 形态不符 / 不唯一 三种失败是否都有结构化语义。
- 结构性保护：`apps/local-api/tests/capability-inventory.test.ts` 把表 A 的分类编码成测试；
  新增 `HostOperation` / `Action` / `CardType` 而不登记，会直接失败并点名。

## 0. 结论摘要

| 项 | 数量 | 说明 |
|---|---:|---|
| 表 A 能力项 | **53** | HostOperation 10 + Action 16 + CardType 27 |
| 模型工具可达 | 40 | HostOperation 8 / Action 9 / CardType 23 |
| 明确不开放/内部使用 | 13 | 每项都有理由（§7） |
| 表 B 参数项 | **47** | 指针/枚举/日期/时间/URL/查询/内容 |
| 本轮发现缺口 | **18** | G01–G18 |
| 本轮补掉 | **7** | G02–G08；G01（surface）为上一轮已补、本轮复核 |
| 有意保留 | **10** | G09–G18，逐条给理由 |
| 新增单测 | **14** | 工具层 9 + find_cards 1 + 能力对账 4（能力对账本身 4 条） |

全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
**2725 tests / 8 failed / 3 skipped**；HEAD 基线 **2711 / 8 failed / 3 skipped**，失败集合逐条差集 **0**。
typecheck 只剩既有 `tests/helpers.ts(8,23)`；改动文件 oxlint 0。

---

## 1. 表 A：能力对账

判定口径：

- **工具入口** = `TOOL_DEFINITIONS`（`apps/local-api/src/intent/toolCalls.ts:250`）里的模型可调用入口；
  规则快通道（`intent/rules|plans|operationsFast`）、决策任务、控制端 UI 不算"工具入口"，但会在"入口唯一"列注明。
- **可执行** = 客户端真的会落成效果：
  HostOperation 看 `apps/web/src/ai/hostOperation.ts`；Action 看
  `apps/web/src/state/canvasStore.ts`（`applyAction`）与 `apps/local-api/src/space/executor.ts`；
  模型动作子集另受 `apps/local-api/src/intent/validation.ts` 限制。
- "内部使用" = 宿主自己产生/消费，没有对应用户意图；"暂不开放" = 能力存在但本轮明确不给模型。

### A1. HostOperation（10 项，`packages/contracts/src/decisionTask.ts:5`）

| # | kind | 工具入口 | 入口唯一 | 可执行 | 判定 |
|---|---|---|---|---|---|
| A1-01 | `card.move` | `arrange(position=left/right/up/down)` | 否：另有 `operationsFast`/决策任务/planner | ✅ | **开放**。本轮补：固定卡移动在工具层先拒（G07）。变体 `relativeTo` 未暴露（G09） |
| A1-02 | `card.pin` | `arrange(position=pin/unpin)` | 否：另有决策任务/手机权限 | ✅ | **开放** |
| A1-03 | `card.surface` | `arrange(surface=user/display)` | 否：另有决策任务/手机权限 | ✅ | **开放**（上一轮补的入口，本轮复核通过） |
| A1-04 | `history.undo` | `history(action=undo)` | 否：`operationsFast`/`exactHostOperation` 同义快通道 | ✅ | **开放**（快通道优先级更高，属有意重叠） |
| A1-05 | `history.redo` | `history(action=redo)` | 否：同上 | ✅ | **开放** |
| A1-06 | `ambient.control` | —（只有整句闭合口令 `exactHostOperation` + planner） | — | ✅ | **暂不开放**（G10）：设备光效偏好，不让模型改写；闭合口令已覆盖明确说法 |
| A1-07 | `canvas.organize.preview` | —（planner/`operationsFast`/`exactHostOperation`） | — | ❌ 执行器固定拒绝 | **暂不开放**（G18）：`apps/web/src/ai/hostOperation.ts:16` 返回"整理与分区已暂时关闭"；契约保留待恢复，本轮把 planner 提示里的宣传撤下（G08） |
| A1-08 | `canvas.arrange` | `arrange(target="canvas")` | 否：`operationsFast`/`exactHostOperation` | ✅ | **开放** |
| A1-09 | `countdown.pause` | `update_card(action=pause_countdown)` | 否：`cards/operations.ts` 契约（当前无调用方）/决策任务 | ✅ | **开放** |
| A1-10 | `countdown.resume` | `update_card(action=resume_countdown)` | 否：同上 | ✅ | **开放** |

### A2. Action（16 项，`packages/contracts/src/actionEnvelope.ts:6`）

| # | type | 工具入口 | 入口唯一 | 可执行 | 判定 |
|---|---|---|---|---|---|
| A2-01 | `stage.awaken` | —（宿主在 STANDBY 建卡/聚焦前自动加） | — | ✅ | **内部使用**：表现动作，不交给模型 |
| A2-02 | `card.create` | `create_card(kind, fields)` | ✅（kind 是同一入口的变体） | ✅ | **开放** |
| A2-03 | `card.delete` | `delete_card(card_id)` | 否：决策任务/规则"删除全部" | ✅（经确认门） | **开放**；直接请求只出确认，不执行 |
| A2-04 | `cards.delete` | —（整句规则"清空画布"/决策任务） | — | ✅ | **暂不开放**（G11）：批量删除只走整句规则，避免模型一次删多张 |
| A2-05 | `card.focus` | `view(mode=focus)` + 新卡自动聚焦 | 否：builder/规则也会加 | ✅ | **开放** |
| A2-06 | `card.subcard.set` | —（控制端编辑器） | — | ✅ | **暂不开放**（G12）：子卡片绑定行锚点，`intent/validation.ts:21` 拒绝模型动作 |
| A2-07 | `card.subcard.delete` | —（控制端编辑器） | — | ✅ | **暂不开放**（G12） |
| A2-08 | `card.highlight` | `view(mode=highlight)` | 否：`commands/parse` 控制端口令 | ✅ | **开放**（条目级仅 Todo，见 G17） |
| A2-09 | `card.update` | `update_card` + `create_card(kind=todo, card_id=…)` 追加 | 否：两个入口写同一动作，语义不同（改内容 / 追加） | ✅ | **开放**（有意重叠，见 §8） |
| A2-10 | `canvas.fit` | `view(mode=fit)` | 否：规则"显示全部" | ✅ | **开放** |
| A2-11 | `canvas.restore` | `view(mode=restore)` | 否：规则"恢复视图" | ✅ | **开放** |
| A2-12 | `canvas.switch` | —（Space UI / 手机权限） | — | ✅（路由层处理） | **暂不开放**（G13）：空间路由不由模型决定 |
| A2-13 | `canvas.create` | —（Space UI） | — | ✅ | **暂不开放**（G13） |
| A2-14 | `ambient.setPreset` | —（设置/URL 主题） | — | ✅ | **暂不开放**（G14）：设备主题偏好 |
| A2-15 | `subtitle.show` | `unsupported(reply)` / 提醒口播 | 否：内部多处 | ✅ | **内部使用**：模型只能通过 `unsupported` 产生诚实的"做不到" |
| A2-16 | `subtitle.hide` | — | — | ✅ | **内部使用**（G15）：没有独立用户意图 |

### A3. CardType（27 项，`packages/contracts/src/cardTargets.ts:15`）

`create_card` 的 11 个 kind 是这 27 种的**生成入口变体**，不是 27 个工具。

| # | CardType | 生产者入口 | 模型工具 | 判定 |
|---|---|---|---|---|
| A3-01 | `FileCard` | 文件上传（`files/routes`） | ❌ | **暂不开放**（G16）：文件来自上传，不交给模型 |
| A3-02 | `TravelOffersCard` | 旅行查询（`scenes/travel`） | ❌ | **暂不开放**（G16）：`create_card(scene=travel_offers)` 明确拒绝并指向旅行入口 |
| A3-03 | `ExtensionCard` | 扩展安装 | ❌ | **暂不开放**（G16）：扩展定义由安装流程校验 |
| A3-04 | `CountdownCard` | `kind=countdown` / `scene=countdown` | ✅ | **开放**（计时 / 日期倒计时两个含义，kind 已分开） |
| A3-05 | `TodoCard` | `kind=todo` | ✅ | **开放** |
| A3-06 | `NoteCard` | `kind=note` | ✅ | **开放**（含通用卡 sections） |
| A3-07 | `SearchResultCard` | `search` | ✅ | **开放** |
| A3-08 | `WeatherCard` | `weather` | ✅ | **开放** |
| A3-09 | `TableCard` | data 适配器（用户给出的数值） | ❌ | **暂不开放**（G16）：数值表格由规则适配器建，模型不能编数据 |
| A3-10 | `ChartCard` | `kind=chart` / `scene=data_visualization` | ✅ | **开放** |
| A3-11 | `PaperCard` | `scene=academic_paper` | ✅ | **开放** |
| A3-12 | `GalleryCard` | `scene=photo_gallery` | ✅ | **开放** |
| A3-13 | `WeeklyScheduleCard` | `kind=weekly_plan` / `kind=schedule` / `scene=weekly_schedule` | ✅ | **开放** |
| A3-14 | `RoadmapCard` | `scene=project_roadmap` | ✅ | **开放** |
| A3-15 | `NewsCard` | `kind=answer` / `scene=news_summary` | ✅ | **开放** |
| A3-16 | `TimelineCard` | `scene=historical_timeline` | ✅ | **开放** |
| A3-17 | `QuoteCard` | `scene=quote_note` | ✅ | **开放** |
| A3-18 | `StoryCarouselCard` | `scene=photo_story` | ✅ | **开放** |
| A3-19 | `ActivityFeedCard` | `scene=activity_feed` | ✅ | **开放** |
| A3-20 | `ProgressRingCard` | `scene=goal_progress` | ✅ | **开放** |
| A3-21 | `HabitHeatmapCard` | `kind=habit` / `scene=habit_tracking` | ✅ | **开放** |
| A3-22 | `BookCard` | `scene=book_record` | ✅ | **开放** |
| A3-23 | `MonthCalendarCard` | `scene=monthly_calendar` | ✅ | **开放** |
| A3-24 | `ComparisonCard` | `scene=option_comparison` | ✅ | **开放** |
| A3-25 | `LinkPreviewCard` | `scene=web_bookmark` | ✅ | **开放** |
| A3-26 | `PhotoCoverCard` | `scene=photo_memory` | ✅ | **开放** |
| A3-27 | `NotificationCard` | `kind=notification` / `scene=single_notification` | ✅ | **开放** |

`create_card` 的 11 个 kind 与卡型一一对应（`countdown→CountdownCard`、`todo→TodoCard`、
`note→NoteCard`、`weekly_plan/schedule→WeeklyScheduleCard`、`template→模板契约的卡`、
`scene→对应场景卡`、`chart→ChartCard`、`notification→NotificationCard`、`habit→HabitHeatmapCard`、
`answer→NewsCard`），没有"有 kind 但建不出卡"或"有卡型但没有 kind/生产者"的项。

---

## 2. 表 B：校验对账

三种失败必须都有确定语义：

1. **不存在**：指针指向的卡/条目/枚举值不在画布或枚举内；
2. **类型或形态不符**：类型不对、日期/时间不可解析、URL 不合规、数值越界；
3. **不唯一**：原话或文本能对上多个真实目标。

统一出口：`kind: "invalid"` + `issues[]`（`code/message/hint`）+ 需要时 `targetCandidates`（≤5）；
模型拿一次修复轮。**没有空响应，没有宿主代选**。`missing-param` 只表示"参数缺"，不是"宿主替问"。

### B1. `create_card`（24 项）

| # | 参数 | 不存在 | 类型/形态 | 不唯一 | 处理 |
|---|---|---|---|---|---|
| B01 | `kind` | — | ✅ enum 11 项 | — | `invalid-param` |
| B02 | `fields` | ✅ 缺→`missing-param` | ✅ 必须是对象 | — | 按 kind 逐类 strict schema |
| B03 | `countdown.minutes` | ✅ 缺→`missing-param` | ✅ 0.1–1440 + 原话时长 grounding | — | `invalid-param`/`missing-param` |
| B04 | `countdown.text` | —（可选） | ✅ ≤160 | — | 内容不逐字校验（模型概括） |
| B05 | `todo.items` | ✅ 缺/空→`missing-param`/`invalid-param` | ✅ 1–30 条、每条 1–160 | — | 空清单单独给"至少一条" |
| B06 | `todo.card_id` | ✅ 不存在→`unknown-card`+候选 | ✅ 非 TodoCard→`invalid-param`+候选 | ✅ 原话点名多张且无唯一证据→`ambiguous-target` | **本轮补**：改走 `cardFor`（G02） |
| B07 | `note.text` | ✅ text/sections 二选一必填 | ✅ 1–500 | — | 两个都给/都不给都拒绝 |
| B08 | `note.sections` | ✅ 同上 | ✅ 1–4 区、每区 1–6 条、每条 ≤180 | — | `invalid-param` |
| B09 | `note.title` | —（可选） | ✅ ≤60 | — | `invalid-param` |
| B10 | `note.style` | —（可选） | ✅ tone/accent 枚举 | — | `invalid-param` |
| B11 | `weekly_plan.topic` | ✅ 缺→`missing-param` | ✅ 1–40 | — | 计划日是建议内容，不算用户事实 |
| B12 | `schedule.title` | ✅ 缺→`missing-param` | ✅ 1–80 | — | 内容不逐字校验 |
| B13 | `schedule.day` | —（省略=今天，既有默认；不编更远的日期） | ✅ 今天/明天/后天/周X/下周X/MM-DD/ISO；**不可解析→`invalid-param`** | — | **本轮补**：不再把读不懂的词默认为今天（G05） |
| B14 | `schedule.time` | —（可选） | ✅ 钟点可解析；时段词（上午/下午）保留在标题；**不可解析→`invalid-param`** | — | **本轮补**：不再静默丢弃时间（G06） |
| B15 | `template.template_id` | ✅ 未知→`unsupported` | ✅ 四个保留模板 + 退休模板映射到新入口 | — | `unsupported` |
| B16 | `template.fields` | ✅ 缺必填→`missing-param` | ✅ 每个模板自己的 builder + grounding | — | `ungrounded` |
| B17 | `scene.scene_id` | ✅ 未知→`invalid-param` | ✅ enum；`travel_offers` 明确拒绝 | — | `unsupported` |
| B18 | `scene.data` | ✅ 缺必填→`missing-param` | ✅ 每个场景自己的 schema + 日期/数值/链接 grounding | — | `invalid-param`/`ungrounded` |
| B19 | `chart.chartKind` | — | ✅ bar/line/pie | — | `invalid-param` |
| B20 | `chart.points` | ✅ 缺→`missing-param` | ✅ 1–100 个 `{x,y}`，y 必须来自原话 | — | `invalid-param`/`ungrounded` |
| B21 | `notification.title/body/level` | ✅ title 缺→`missing-param` | ✅ 1–80 / ≤300 / 四级枚举 | — | `invalid-param` |
| B22 | `habit.habit` | ✅ 缺→`missing-param` | ✅ 1–60 | — | `invalid-param` |
| B23 | `habit.checkins` | —（可选） | ✅ ISO 或可解析的星期/相对日期 | — | 解析不了→`invalid-param`；不重复由契约保证 |
| B24 | `answer.text/title/points` | ✅ text 缺→`missing-param` | ✅ 1–240 / ≤40 / ≤5×60 | — | 实时事实句→`unsupported` 指向 search/weather |

### B2. `update_card` / `delete_card` / `view`（9 项）

| # | 参数 | 不存在 | 类型/形态 | 不唯一 | 处理 |
|---|---|---|---|---|---|
| B25 | `update_card.card_id` | ✅ 不存在→`unknown-card`+候选 | ✅ 卡级动作要求 CountdownCard；条目动作要求 TodoCard | ✅ `cardFor` → `ambiguous-target`+候选 | 已有 |
| B26 | `update_card.action` | — | ✅ 7 个 action；按 action 拒绝外来字段 | — | `invalid-param` |
| B27 | `update_card.title` | ✅ 缺→`missing-param` | ✅ 卡片是否有标题字段 + 每卡型上限 | — | `unsupported`/`invalid-param` |
| B28 | `update_card.item_id` | ✅ 条目不在该卡→`unknown-card`+该卡条目 | ✅ 条目 id 或原文 | ✅ **原文对上多条→`ambiguous-target`+两条 id** | **本轮补**（G03） |
| B29 | `update_card.text` | ✅ rename 缺→`missing-param` | ✅ 1–160 | — | `invalid-param` |
| B30 | `delete_card.card_id` | ✅ 不存在→`unknown-card`+候选（纯"删了它"才读焦点） | ✅ 任意可渲染卡 | ✅ `cardFor` → `ambiguous-target` | 已有；执行仍经确认门 |
| B31 | `view.mode` | — | ✅ 4 个 mode；按 mode 拒绝外来字段 | — | `invalid-param` |
| B32 | `view.card_id` | ✅ 不存在→`unknown-card`+候选 | ✅ 任意可渲染卡 | ✅ `cardFor` → `ambiguous-target` | 已有 |
| B33 | `view.item_id` | ✅ 不在该卡→`unknown-card`+该卡条目 | ✅ 条目 id 或原文；非 Todo 卡条目级高亮→`unsupported` | ✅ **原文对上多条→`ambiguous-target`** | **本轮补**（G03）；G17 是另一条边界 |

### B3. `arrange` / `history` / 外部能力（10 项）

| # | 参数 | 不存在 | 类型/形态 | 不唯一 | 处理 |
|---|---|---|---|---|---|
| B34 | `arrange.target` | ✅ 卡不存在→`unknown-card`+候选 | ✅ 卡 id 或字面量 `"canvas"` | ✅ `cardFor` → `ambiguous-target` | 已有；"卡 id 恰好叫 canvas"是已知低风险边界 |
| B35 | `arrange.position` | — | ✅ pin/unpin/left/right/up/down；与 surface 互斥 | — | **本轮补**：固定卡移动先拒（G07） |
| B36 | `arrange.surface` | — | ✅ user/display；target=canvas 时拒绝；与 position 互斥 | — | 已有 |
| B37 | `history.action` | — | ✅ undo/redo | — | `invalid-param` |
| B38 | `search.query` | ✅ 空→`missing-param` | ✅ 1–200 | — | 不编来源；查不到由适配器如实返回 |
| B39 | `read_url.url` | — | ✅ 公开 HTTPS；http/内网/本机拒绝 | — | `invalid-param`；必须单独调用 |
| B40 | `weather.city` | ⚠️ 城市不存在由适配器 clarify（不是宿主代选） | ✅ 1–40 | ⚠️ 同名城市由适配器列候选 | 适配器负责 |
| B41 | `weather.day` | —（省略=当前） | ✅ 今天/明天/后天/周X/MM-DD；超出 7 天→`invalid-param` | — | 已有（不再静默变成今天） |
| B42 | `find_cards.query` | —（可选） | ✅ 1–120；空查询=按类型列卡 | — | 已有 |
| B43 | `find_cards.type` | ✅ **未知卡型→`invalid-param`** | ✅ 必须是 `CARD_TYPE_LABELS` 的键 | — | **本轮补**（G04）：不再 `as CardType` 后静默 0 命中 |
| B44 | `find_cards.limit` | — | ✅ 1–20，越界拒绝（不静默 clamp） | — | 已有 |
| B45 | `clarify.missing` | — | ✅ 7 个枚举 | — | `invalid-param` |
| B46 | `clarify.question` | ✅ 缺→`invalid-param` | ✅ 1–180；宿主只补"还缺X"标签，不改写问题 | — | 拒绝宿主已能确定的事实 |
| B47 | `unsupported.reply` | —（可选） | ✅ ≤120 | — | 无卡片、不声称完成 |

> 说明：表 B 只对"指针/事实"负责。`note.text`、`countdown.text`、`answer.text` 这类**内容**由模型填写，
> 宿主只校验长度与结构；逐字 grounding 只适用于场景/模板里"用户说过的事实"（B16/B18/B20/B23）。

---

## 3. 本轮补了什么（G02–G08）

| 缺口 | 位置 | 修复 | 单测 |
|---|---|---|---|
| G02 `create_card(kind=todo, card_id=…)` 只查"存在+类型"，不查原话唯一性 | `toolCalls.ts:1368`（`cardFor`）、`toolCalls.ts:1468`（追加路径） | 追加路径改走 `cardFor`：存在/类型/`ambiguous-target`/候选一次对齐；这是上一轮审计明确留下的最后一条缝 | `tool-calls.test.ts`「refuses an append pick…」 |
| G03 `item_id` 用原文匹配时 `find` 取第一条，重复文本静默选错 | `toolCalls.ts:666`（`pickEntry`）、`toolCalls.ts:1349`（`entryAmbiguous`） | id 精确优先；原文只在**恰好一条**时接受；多条→`ambiguous-target`+两条 id | `tool-calls.test.ts`「duplicate entry text…」3 条 |
| G04 `find_cards(type)` 直接 `as CardType`，未知类型返回空"没找到" | `toolCalls.ts:1224` | 用 `CARD_TYPE_LABELS` 白名单校验；未知→`invalid-param`+示例 | `find-cards.test.ts`「rejects an unknown card type…」 |
| G05 `schedule.day` 读不懂时默认为今天 | `toolCalls.ts:523` | 只接受相对词/周X/显式日期；其余→`invalid-param`；显式日期现在会解析成正确周；顺带修掉「大后天」被当成「后天」（+3 变 +2） | `tool-calls.test.ts` 3 条 |
| G06 `schedule.time` 读不懂时静默丢弃 | `toolCalls.ts:1573` | 钟点可解析或时段词才放行；其余→`invalid-param` | `tool-calls.test.ts`「refuses a time…」 |
| G07 固定卡移动：工具接受、客户端执行器拒绝（用户会听到"已移动"但没动） | `toolCalls.ts:1910` | 工具层先拒绝，hint 指向 `position="unpin"` | `tool-calls.test.ts`「refuses to move a pinned card…」 |
| G08 planner 提示仍宣传已关闭的 `canvas.organize.preview` | `decision/hostOperations.ts:44` | 从 `HOST_OPERATION_PROMPT` 撤下该行并留注释；精确口令仍由快通道给出诚实关闭说明 | 由 `capability-inventory.test.ts` 的能力分类钉住 |

## 4. 有意保留（G09–G18）

| 缺口 | 判定 | 理由 |
|---|---|---|
| G09 `card.move.relativeTo` 未进 `arrange` | 暂不开放 | 参照卡不是"决策目标"，把 `cardFor` 的原话歧义规则套到锚点上会误伤（"把A挪到B下面"原话同时点名两张）。方向移动已能表达"往左/往右"；参照关系仍由 planner/决策任务/控制端保留。要开放时应新增独立的锚点校验（存在、非自身、同页），不要复用 `ambiguous-target` |
| G10 `ambient.control` 无模型入口 | 暂不开放 | 设备光效是用户偏好，不是画布内容；整句闭合口令（"光柔和一点"）已覆盖明确说法，避免模型擅自改主题 |
| G11 `cards.delete` 无模型入口 | 暂不开放 | 批量删除不可逆；只允许整句"清空画布"规则 + 确认门，工具面拒绝多目标删除 |
| G12 `card.subcard.set/delete` 无模型入口 | 暂不开放 | 子卡片绑定行锚点（`itemId+anchor`），必须由控制端编辑器在原始行上写；`intent/validation.ts:21` 已拒绝模型动作 |
| G13 `canvas.switch/create` 无模型入口 | 暂不开放 | 空间路由是用户界面/手机权限（`text.submit/canvas.switch/...`），不由模型决定 |
| G14 `ambient.setPreset` 无模型入口 | 暂不开放 | 设备主题偏好，来自设置或 URL 主题 |
| G15 `subtitle.hide` 无入口 | 内部使用 | 没有独立用户意图；`subtitle.show` 已由 `unsupported`/提醒覆盖 |
| G16 File/Travel/Extension/Table 无 `create_card` kind | 暂不开放 | 分别来自上传、旅行查询、扩展安装、数值适配器；模型不能编文件/报价/扩展/数据 |
| G17 条目级高亮只支持 Todo，表格行/便笺行渲染层支持 | 暂不开放 | 行锚点（`row:N`/`line:N`）属于控制端子卡片定位；AI 动作只开放待办条目，避免模型按位置猜行 |
| G18 `canvas.organize.preview` 入口存在但执行器关闭 | 暂不开放（产品开关） | 客户端固定返回"整理与分区已暂时关闭"；契约保留待恢复，本轮只撤下模型面宣传（G08），精确口令仍给同一句诚实说明 |

## 5. 多入口重叠（有意，不是缺陷）

| 能力 | 入口 | 关系 |
|---|---|---|
| 撤销/重做 | `history` 工具 / `operationsFast` / `exactHostOperation` / planner | 整句闭合时快通道先命中；语义相同，输出同一个 HostOperation |
| 整理画布 | `arrange(target="canvas")` / `operationsFast` / `exactHostOperation` | 同上 |
| 移动/固定/传送 | `arrange` / 决策任务 / 手机权限 | 同一 HostOperation，不同传输通道；手机侧仍受 permission 约束 |
| 建待办/便签/计时器 | `create_card` / `rules` / `plans` / `chartFast` / `habitFast` | 确定性整句直出，失败才回落到模型；不会双执行（envelope 去重 + 单请求） |
| 单卡删除 | `delete_card` / 决策任务 / 规则"删除全部" | 单卡与批量是不同能力；工具面只开单卡，且都要确认 |
| 卡片更新 | `update_card` / `create_card(kind=todo, card_id=…)` | 前者改标题/条目，后者只追加条目；`card.update` 是同一动作的两种用户语义 |

## 6. 后续不变式（新增能力时必须满足）

1. **每个 `HostOperation` kind 必须有工具入口，或在 `capability-inventory.test.ts` 的 `CLOSED_HOST_KINDS` 里写明理由。**
2. **每个 `Action` type 必须被工具/宿主产生，或在 `CLOSED_ACTIONS` 里写明理由。**
3. **每个 `CardType` 必须有生产者入口**（工具 kind / 场景 / 适配器 / 上传），并登记在 `CARD_TYPE_ENTRIES`。
4. **任何 `card_id` 必须走 `cardFor`**：存在 → 类型 → 原话唯一性 → 候选。禁止新增 `cards.find(id)` 直接放行
   （G02 就是这条缝）。
5. **任何 `item_id` 必须走 `pickEntry`**：id 精确优先，原文只在唯一时接受，重复文本 → `ambiguous-target`。
6. **枚举参数禁止 `as` 断言**：`kind/scene_id/template_id/type/chartKind/mode/action/position/surface/missing`
   必须在宿主侧白名单校验（G04）。
7. **日期/时间参数必须"可解析或结构化拒绝"**：禁止默认到今天、禁止静默丢弃（G05/G06）。
8. **工具能产出的宿主操作必须能被执行器执行**；执行器会拒绝的前置条件（如固定卡移动）在工具层先拒（G07）。
9. **失败只有一种形状**：`invalid` + `issues(code/message/hint)` + 需要时 `targetCandidates`；
   不许空响应、不许宿主代选、不许把失败说成"请换一种说法"（修复预算耗尽除外）。
10. **工具描述 / `TOOL_CATALOG` / 系统提示三处同步**：已有测试钉住；新增变体要同时更新。

## 7. 验证证据

```text
# 针对性
pnpm exec vitest run tests/tool-calls.test.ts tests/find-cards.test.ts tests/capability-inventory.test.ts --maxWorkers=2
→ 3 files / 213 tests passed（tool-calls 191、find-cards 18、capability-inventory 4）

# 全量（本 worktree）
pnpm --filter @vivic/local-api test -- --maxWorkers=4
→ Test Files 5 failed | 119 passed | 2 skipped (126)
  Tests 8 failed | 2714 passed | 3 skipped (2725)
  失败集合与 HEAD 162ff12 基线逐条一致（差集 0）：
  command-matrix(todo)、deepseek 无 key、provider-main-transport ×3、stepfun-stream 超时、
  weekly-plan-grounding ×2

# 类型
pnpm --filter @vivic/local-api typecheck
→ 只剩既有 tests/helpers.ts(8,23)

# lint（改动文件）
pnpm exec oxlint apps/local-api/src/intent/toolCalls.ts \
  apps/local-api/src/decision/hostOperations.ts \
  apps/local-api/tests/tool-calls.test.ts apps/local-api/tests/find-cards.test.ts \
  apps/local-api/tests/capability-inventory.test.ts
→ 0 warnings / 0 errors
```

## 8. 未做 / 边界

- 没有部署、没有碰服务器、没有跑 60/48、没有推送。
- 没有改 `apps/web`：G18 的"整理与分区已暂时关闭"是既有产品开关，本轮只在后端撤下模型宣传。
- `weather.city` 的"城市不存在/同名城市"仍由适配器 clarify；宿主不猜城市。
- `arrange.target` 的 `"canvas"` 字面量与卡 id 空间重叠（卡 id 恰好叫 `canvas`）未处理；
  当前卡 id 由宿主生成（UUID / `card_*`），风险可忽略。
- 表 A 的"可执行"按当前 HEAD 的客户端代码判定；若客户端后续关闭某个执行器，需要同步把该能力
  从 `OPEN_*` 移到 `CLOSED_*`（测试会提醒）。
