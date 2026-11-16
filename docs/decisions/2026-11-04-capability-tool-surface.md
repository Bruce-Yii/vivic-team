# 能力型工具面：27 个按卡型的工具 → 12 个按能力的入口

- 日期：2026-11-04
- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`）
- 起点：`ca0c494`（`docs(decisions): record the final full-suite comparison for find_cards`）
- 范围：`apps/local-api/src/intent/toolCalls.ts` + 工具层测试 + 本文档。
  没有改 `pipeline.ts`、`decision/*`、`data/*`；没有部署、没有跑线上验收。

## 为什么

旧工具面是「按卡型建」的：11 个 `create_*` 各占一个工具名，`edit_card` 与
`update_todo_item` 都写同一张卡的 `displayProps`，`focus_card / highlight_card /
canvas_fit / restore_view` 都是「改视图」，`arrange_card / arrange_canvas` 都是「排布局」。
重叠来自结构：每加一种卡就多一个工具，模型要在 27 个名字里挑，描述里只能靠
「绝对不用我」互相指路。这一轮把重叠从结构上去掉：**一个能力一个入口，卡型是
`create_card` 的 `kind`，动作是 `update_card` / `view` / `arrange` / `history` 的参数。**

工具总数：**27 → 12**。

## 新工具面

| # | 工具 | 吸收的旧工具 | 变量 |
| --- | --- | --- | --- |
| 1 | `create_card(kind, fields)` | 11 个建卡入口 | `kind`: countdown/todo/note/weekly_plan/schedule/template/scene/chart/notification/habit/answer |
| 2 | `update_card(card_id, action, …)` | `edit_card` + `update_todo_item` | `action`: set_title/pause_countdown/resume_countdown/done/undone/rename/remove |
| 3 | `delete_card(card_id)` | `delete_card` | — |
| 4 | `view(card_id?, mode)` | `focus_card` + `highlight_card` + `canvas_fit` + `restore_view` | `mode`: focus/highlight/fit/restore |
| 5 | `arrange(target, position?)` | `arrange_card` + `arrange_canvas` | `target`: 卡 id 或 `"canvas"`；`position`: pin/unpin/left/right/up/down |
| 6 | `history(action)` | `undo_last` | `action`: undo/redo |
| 7 | `search(query)` | `search` | — |
| 8 | `weather(city?, day?)` | `weather` | — |
| 9 | `find_cards(query?, type?, limit?)` | `find_cards` | — |
| 10 | `chat` | `chat` | 无参数 |
| 11 | `clarify(missing, question)` | `clarify` | — |
| 12 | `unsupported(reply?)` | `unsupported` | — |

### 逐条新旧映射

| 旧工具名 | 新入口 |
| --- | --- |
| `create_countdown(minutes, text?)` | `create_card(kind="countdown", fields={minutes, text?})` |
| `create_todo(items, card_id?)` | `create_card(kind="todo", fields={items, card_id?})` |
| `create_note(text)` | `create_card(kind="note", fields={text})` |
| `create_weekly_plan(topic)` | `create_card(kind="weekly_plan", fields={topic})` |
| `create_schedule(title, day?, time?)` | `create_card(kind="schedule", fields={title, day?, time?})` |
| `create_from_template(template_id, fields)` | `create_card(kind="template", fields={template_id, fields})` |
| `create_scene_card(scene_id, data)` | `create_card(kind="scene", fields={scene_id, data})` |
| `create_chart(chartKind, points, title?)` | `create_card(kind="chart", fields={chartKind, points, title?})` |
| `create_notification(title, body?, level?)` | `create_card(kind="notification", fields={title, body?, level?})` |
| `create_habit(habit, checkins?, weeklyGoal?)` | `create_card(kind="habit", fields={habit, checkins?, weeklyGoal?})` |
| `answer(title?, text, points?)` | `create_card(kind="answer", fields={title?, text, points?})` |
| `edit_card(card_id, action, title?)` | `update_card(card_id=…, action=set_title\|pause_countdown\|resume_countdown, title?)` |
| `update_todo_item(item_id, action, text?, card_id?)` | `update_card(action=done\|undone\|rename\|remove, item_id, text?, card_id?)` |
| `delete_card(card_id)` | `delete_card(card_id)`（不变） |
| `focus_card(card_id)` | `view(mode="focus", card_id=…)` |
| `highlight_card(card_id, item_id?)` | `view(mode="highlight", card_id=…, item_id?)` |
| `canvas_fit()` | `view(mode="fit")` |
| `restore_view()` | `view(mode="restore")` |
| `arrange_card(card_id, action)` | `arrange(target=card_id, position=pin\|unpin\|left\|right\|up\|down)` |
| `arrange_canvas()` | `arrange(target="canvas")` |
| `undo_last(redo?)` | `history(action="undo"\|"redo")` |
| `search / weather / find_cards / chat / clarify / unsupported` | 同名不变 |

`created[].tool`（遥测/日志）现在写实际调用的工具名（`create_card`），卡型由
`cardType` 字段表达；issue 文本里带变体（`#1 create_card(todo): …`），所以失败回灌
仍然能看出是哪一种 kind。`TOOL_CATALOG` 用 `kinds / modes / actions` 记录每个入口
暴露的变体。

## 每个能力的边界

### `create_card(kind, fields)`

`fields` 就是**旧工具的参数对象**（字段名一个没改），宿主用该 kind 原来那份 zod
schema 逐类校验，再用该卡型原来的 builder 构建；`kind=template` 因此是
`fields={template_id, fields}`（内层 `fields` 是模板字段）。

| kind | 必填 | 可选 | 产出的卡 |
| --- | --- | --- | --- |
| `countdown` | `minutes` 0.1–1440 | `text` ≤160 | CountdownCard |
| `todo` | `items` 1–30 条、每条 1–160 | `card_id`（追加到已有 TodoCard） | TodoCard |
| `note` | `text` 1–500 | — | NoteCard |
| `weekly_plan` | `topic` 1–40 | — | WeeklyScheduleCard |
| `schedule` | `title` 1–80 | `day`, `time` | WeeklyScheduleCard |
| `template` | `template_id`（四选一）、`fields` | — | 模板契约决定的卡 |
| `scene` | `scene_id`、`data` | — | 对应场景卡 |
| `chart` | `chartKind` bar/line/pie、`points` 1–100 | `title` ≤80 | ChartCard |
| `notification` | `title` 1–80 | `body` ≤300、`level` | NotificationCard |
| `habit` | `habit` 1–60 | `checkins`、`weeklyGoal` 1–7 | HabitHeatmapCard |
| `answer` | `text` 1–240 | `title` ≤40、`points` ≤5×60 | NewsCard |

保留的边界：日期倒计时（生日/考试）走 `kind=scene(scene_id=countdown)`，`kind=countdown`
只做从此刻起算的计时；`travel_offers` 仍然拒绝并指向旅行查询；退休模板
（`project_plan/reading_note/comparison_table/todo_checklist`）仍然拒绝并给出新入口。

### `update_card(card_id, action, …)`

| action | 需要 | 行为 |
| --- | --- | --- |
| `set_title` | `card_id` + `title` | 只改该卡契约里的标题字段（TodoCard=`title`，NewsCard=`headline`…）；没有标题字段的卡（便笺/金句/计时器）拒绝 |
| `pause_countdown` / `resume_countdown` | `card_id` | 只对 CountdownCard 生效，产出宿主操作 |
| `done` / `undone` | `item_id` | 只改这一条的 `done`，其它条目和状态原样保留 |
| `rename` | `item_id` + `text` | 走 TodoCard 契约重校验整卡 |
| `remove` | `item_id` | 最后一条不能删（要清空就整卡删除） |

`card_id` 在条目动作上可省略：宿主只在原话能唯一对上某张卡的该条目时才用它
（`resolveEntryTarget`），否则回传候选；模型给了合法 id 就按模型的选择执行，宿主
不会用原话覆盖。

### `view(card_id?, mode)`

| mode | 需要 | 产出 |
| --- | --- | --- |
| `focus` | `card_id` | `card.focus` |
| `highlight` | `card_id`，可选 `item_id` | `card.highlight`（条目级需 TodoCard） |
| `fit` | 无 | `canvas.fit` |
| `restore` | 无 | `canvas.restore` |

`fit/restore` 拒绝 `card_id`/`item_id`；`focus` 拒绝 `item_id`（与旧 `focus_card` 的严格参数一致）。

### `arrange(target, position?)`

`target="canvas"` → `canvas.arrange`，且不接受 `position`；`target=<卡 id>` 时
`position` 必填（`pin/unpin/left/right/up/down`）→ `card.pin` / `card.move`。
一次只操作一张卡；一批里只能有一个宿主操作。

### `history(action)`

`undo` / `redo` → `history.undo` / `history.redo`，不建卡。

## 「何时绝对不用我」清单（工具描述 + 系统提示都写了）

- 实时资讯 / 新闻 / 最新消息 / 实时行情 / 比分 / 榜单 / 票价 / 上映 → **`search`**，
  绝不用 `create_card(kind=answer/note)` 或 `chat` 顶替。
- 天气 / 气温 / 带伞 / 穿外套 → **`weather`**；`search` 与 `weather` 不同批。
- 稳定知识解释（讲讲某公司、什么是光合作用）→ **`create_card(kind=answer)`**；纯寒暄才 `chat`。
- 系统做不到的事（打电话、下单、转账、控制家电、发消息）→ **`unsupported`**，不建卡、不说已完成。
- 改已有卡 → **`update_card`**；追加待办条目仍用 `create_card(kind=todo, card_id=…)`，
  打勾/删除/改文字用 `update_card`，绝不再追加一条来「覆盖」。
- 删除整张卡 → **`delete_card`**；只移开/固定 → **`arrange`**；撤销删除 → **`history(action=undo)`**。
- 聚焦/高亮/看全部/退出聚焦 → **`view`**；刚创建的卡不需要 focus（宿主自动聚焦）。
- 图表/通知/习惯/待办/周计划/日程各有唯一 kind，不得用 `kind=scene` 的
  `data_visualization / single_notification / habit_tracking / todo_list` 顶替。
- 用户没给的钟点/日期/数值不编；推不出来才 `clarify`。

## 校验没有被放宽

- `create_card` 外层只校验 `kind` 枚举与 `fields` 是对象；**每一种 kind 仍在宿主里用
  原来那份 `z.strictObject` 解析**（多余字段照样拒绝），再走原来的 builder 与
  grounding 规则（倒计时时长必须来自原话、场景日期/数值必须来自原话、模板字段、
  `wantsLiveFacts` 拒绝 answer 等）。
- `update_card` 用一张联合 schema，但**按 action 逐个还原旧 strict schema 的字段集合**：
  `set_title` 不收 `item_id/text`，条目动作不收 `title`；缺 `card_id`（卡级动作）、
  缺 `item_id`、缺 `rename.text` 分别报 `missing-param`。
- `view` / `arrange` 按 mode/target 拒绝不属于该变体的参数。
- 结构化的 issue（`code/message/hint`）、`targetCandidates`（≤5）、条目级操作、
  `find_cards` 的单独调用与一次性回灌、同批多工具、`created` 顺序、envelope 全量
  重校验都保持原语义。

## 两处有意保留的旧行为（避免收紧）

- `chat` 仍然无参数：`pipeline.ts` 的 chat 分支本来就由 planner 出话，工具里加
  `reply` 只会被静默丢弃，所以没有加。
- `pause_countdown` / `resume_countdown` 仍容忍一个 `title` 字段（旧的 `edit_card`
  接受并忽略它）；这不影响行为，也不放宽任何校验。

## 测试证据

命令（在 `work/backend-merge/apps/local-api`）：

```
pnpm exec vitest run tests/tool-calls.test.ts tests/find-cards.test.ts \
  tests/tool-composite-lookup.test.ts tests/tool-repair.test.ts \
  tests/tool-surface-accept60.test.ts tests/tool-layer-online.test.ts \
  tests/relative-dates.test.ts tests/scenes.test.ts \
  tests/pipeline-rules-and-adapters.test.ts tests/intent-log.test.ts --maxWorkers=2
→ Test Files 10 passed (10) | Tests 368 passed (368)
```

`tests/tool-calls.test.ts` 从 127 条增到 **159 条**，新增
`capability coverage: one entry per capability`：

- 每个 `kind` 一条 `create_card`（11 条，断言卡型、route、created.tool）；
- `update_card` 的 `set_title / pause_countdown / resume_countdown / done / undone /
  rename / remove` 各一条，外加「只改目标条目」「拒绝别 action 的字段」；
- `view` 的 `focus / highlight / highlight+item_id / fit / restore`，外加 fit 拒绝 card_id；
- `history` 的 undo/redo；`arrange` 的单卡与整画布、缺 position；三个外部工具
  （`search` / `weather` / `find_cards`）的 lookup 形状；
- 同批多能力（view + create + arrange，一个宿主操作、顺序不丢）；
- 失败回灌（空条目、未知 kind、非法 action、缺 card_id 的 `missing-param`）。

旧的按工具名写的断言全部改到新入口，断言的行为不变（例如
`created[0].tool` 由 `create_countdown` 改为 `create_card`，卡型仍断言 `CountdownCard`）。

全量（`pnpm --filter @vivic/local-api test -- --maxWorkers=4`）：

- 起点 `ca0c494`：132 个文件 / 32 条失败（全部在随后被另一子代理删除的备用决策路径上）。
- 本轮改动完成时（15:29 快照）：19 个文件 / 106 条失败；同一工作树再测一次
  （15:44 快照，此时另一子代理仍在删 `decision/*` 并改 `pipeline.ts` 的接线）：
  28 个文件 / 226 条失败。
- **两次快照里新增的失败全部落在工具层以外的文件**：`decision-*`、`hosted-*`、
  `multi-card-hybrid`、`intent-progress`、`online-app`、`routing-rules-first`、
  `accept60-regressions`、`command-matrix`、`numbered-multicard`、`delete-*`、
  `provider-*` 等；这些文件都不接工具层（没有 `toolCalls` / `toolCredential` /
  脚本化 tool reply），失败原因集中在被删除的路由、分类器与规则路径上。
- 工具层这 10 个文件、368 条测试在两次快照里都是全绿；基线 32 条失败**一条未新增、
  一条未消失（差集 0）**，本轮没有引入新的失败类别。
- 说明：由于同一工作树里另一个子代理正在改 `pipeline.ts`/`decision/*`，全量失败
  集合与 typecheck 会被其进行中的状态污染；上表按「工具层相关文件」和
  「其余文件」分开核对。要得到干净的全量对比，需要等该子代理收尾后重跑。

`pnpm exec tsc -b`：`toolCalls.ts` 及本轮新增/修改的测试代码 **0 个错误**。工作树一致
时全树只剩既有的 2 个错误（`tests/helpers.ts:8`、
`tests/accept60-regressions.test.ts:196`）。`find-cards / tool-composite-lookup /
tool-layer-online / pipeline-rules-and-adapters` 等测试文件里指向
`decision/router.js` 的既有 import 现在会报错，是因为另一子代理删除了该模块，不是
本轮引入；等其收尾后会随之消失。

`pnpm exec oxlint apps/local-api/src/intent/toolCalls.ts apps/local-api/tests/tool-calls.test.ts`
→ 0 warnings / 0 errors。

## 未做 / 交给下一轮

- 没有部署、没有线上验收（按要求）。
- 没有把 `TOOL_CATALOG` 接成运行时路由表：它仍是元数据，行为继续走既有 route 表。
- 没有动 `pipeline.ts` 的错误文案（其中仍有 `focus_card` 等历史注释，属另一子代理
  的文件范围）。
