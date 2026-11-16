# 评分任意数值与日期 grounding 统一（2026-11-04）

- worktree：`work/backend-merge`（`codex/live-backend-20261103`），基线 `9208f30`。
- 依据（用户原话）：
  - 「为什么 0~5？万一想打 100 分呢？任何数字、任意小数、任意整数都可以。如果 80、60、70 肯定是 100 分制；4.5 大概率 5 分制。」
  - 「从原话推导的日期，为什么还缝缝补补？今天允许推导，下次同类又恶心人。」
- 本轮边界：只改 `packages/contracts/src/*`、`apps/local-api/src/scenes/*`、
  `apps/local-api/src/cards/templates.ts` 及其测试，加上重新生成的契约 JSON；
  **不碰** `intent/toolCalls.ts`、`intent/pipeline.ts`、`decision/*`、`data/*`
  （另一路并行修改），不部署、不跑线上验收。
- 本轮提交（本分支，未推送）：
  - `0d163f6` feat(contracts): a rating is any positive number, scale kept in sourceData
  - `57774c2` feat(scenes): every date field accepts a derived date, and ratings keep their scale
  - `2b51594` test(scenes): pin rating scales, the legacy downgrade and the five derivable date fields

## 1. 评分：任何数字，宿主推断满分制

### 1.1 契约

`BookCard.rating` 从 `z.number().min(0).max(5)` 改为 `RatingValueSchema`
（`packages/contracts/src/rating.ts`）：有限数、**任意正数**、上限 `1000` 仅作防呆
（防的是把 id/字符串误当分数，不是评分体系的上限）。

- `displayProps` 的结构**不变**（线上前端用严格 schema 校验，新增字段会被整条拒绝）。
- `apps/local-api/src/scenes/payload.ts`、`apps/local-api/src/cards/templates.ts`
  （`ReadingNoteFields`）、`apps/local-api/src/scenes/prompt.ts` 的 DATA/INTENT 同步放宽。
- `pnpm contracts:generate` 重新生成 `Vivic_Kimi_Handoff_v0.6/contracts/card-record.schema.json`，
  只有 `BookCard.rating` 两行变化：`exclusiveMinimum: 0`、`maximum: 1000`。

### 1.2 满分制推断（宿主，纯函数 `inferRatingScale`）

| 用户说的分 | `displayProps.rating` | `sourceData.ratingScale` |
|---|---|---|
| 4.5、4.7、5 | 原值 | 5（≤5 → 5 分制） |
| 6、8.5、10 | 原值 | 10（≤10 → 10 分制） |
| 60、85、100 | 原值 | 100（≤100 → 100 分制） |
| 850 | 原值 850 | 100（>100 默认 100 分制，**不压缩、不换算**） |

`sourceData` 同时写入 `ratingRaw`（用户原值）。放在 `sourceData` 而不是
`displayProps` 的理由只有一个：线上前端按严格 schema 校验 `displayProps`，
加 `ratingScale` 会让整张卡被拒；`sourceData` 是开放对象，前端忽略未知键不会崩。

### 1.3 旧前端降级（保留 `VIVIC_DECIMAL_RATING`）

线上 bundle 只认 1–5 的整数星，因此 `VIVIC_DECIMAL_RATING=off` 时：

- **阈值从「非整数」扩展为「非整数或 >5」**（旧前端同样渲染不了 6 或 85）；
- 不下发 `displayProps.rating`；把用户原话 `评分 X` 放进 `notes` 头部
  （去重，仍受 8 条上限约束）；
- `sourceData.ratingRaw` / `ratingScale` 照常保留，后续前端支持多分制时不用重算。

实现位置：`apps/local-api/src/scenes/build.ts` 的 `book_record` 构建器，
所以 `create_scene_card` 与 `create_from_template(reading_note)` 两条通道行为一致。

**已知残留**：`intent/toolCalls.ts` 里旧的降级块（`normalizeSceneData` 内，当前约
662–682 行；位置随并行改动移动）仍是「仅非整数」判断，本轮按边界未动。其后果有限：
`env=off` 且评分是小数时，toolCalls 会在进入 build 之前删除 `rating` 并写 notes，
那张卡的 `sourceData` 因此没有 `ratingRaw`（>5 的整数会完整保留
`ratingRaw/ratingScale`）。后续应把该块改为调用 `contracts/rating` 的
`needsLegacyRatingDowngrade` + `legacyRatingNote`。

## 2. 日期：一个判据，所有字段

### 2.1 判据

一个日期值合格 ⇔ 满足其一：

1. `groundedDate` / `groundedPartialDate` —— 字面证据（原话里的月日/年份，
   以及「还有 30 天」「三周后」这类算术结果）；
2. `resolveDates()`（`intent/dateResolve`，**import 复用，不重写正则**）——
   原话唯一推导：星期词、`本周一到周三`、`本周一二三`、`最近三天`、`工作日`、
   今天/明天/昨天、`10月15日`。

两路都只作用于**日期型值**：数字、链接、DOI、作者仍严格字面，不能靠推导混进来。
两个来源合并在 `scenes/build.ts` 的 `dayGrounded` / `partialDateGrounded` 一处，
`habit` 原先那份私有 `habitDateGrounded` 已删除。

为什么是并集而不是只走 `dateResolve`：实测 `resolveIsoDates("还有 30 天")`、
`("三周后")`、`("月底")`、`("今年")` 都返回空——这些只在 corpus 的日历抽取里，
而 corpus 也不认识 `本周一二三`（紧凑连写）、`最近三天`、`工作日`。任何单一来源
都会让某一类说法继续「缝缝补补」，所以判据是两者的并集，且各自保留其确定性。

### 2.2 覆盖字段

| 场景 / 字段 | 判据 | 推导示例 |
|---|---|---|
| `countdown.targetDate` | `dayGrounded` | 「还有三周」→ +21 天 |
| `goal_progress.deadline` | `dayGrounded` | 「这三天内完成」→ 最后一天 |
| `weekly_schedule.events.date` | `dayGrounded` | 「本周一二三」→ 本周一/二/三 |
| `weekly_schedule.events.day` | `groundedWeekday` ∪ 推导出的星期 | 「本周一二三」→ day 1/2/3 |
| `monthly_calendar.events.date` | `dayGrounded` | 「本周一二三」 |
| `historical_timeline.events.date` | `partialDateGrounded`（保留 YYYY / YYYY-MM 精度） | 「最近三天」 |
| `habit_tracking.checkins`、`startDate` | `dayGrounded` | 「最近三天」「本周一到周三」 |
| `photo_memory.date` | `dayGrounded` | 「昨天」 |

显式不纳入（并写明原因，避免下一轮再来一次）：

- `news_summary.publishedAt`：它是**原文明示的发布日期**，不是可推导的事实；
  「今天/事件发生日」不能被当成发布日期（原有规则保留）。
- `travel_offers.startDate`：只说「下周/下个月」时应留空并只填 `dateText`，
  从模糊范围里自选一天仍然是造事实。

### 2.3 issue 文案

所有日期字段同一句（`DATE_HINT` 常量）：

```
<scene>.<field> 的日期 <X> 无法从原话推导；只填用户说过的日期或能从原话唯一推导的日期
（本周一到周三、周一、二、三、本周一二三、今天明天、昨天、最近三天、N 天后、具体月日），
宿主会换算；完全推不出时才 clarify，且只问缺的那一项
```

历史时间线、habit checkins、weekly day 都改成这一句（原来分别是
「不在用户提供的信息里」「无法从原话唯一推导」「不在用户的话里」）。

### 2.4 prompt

`scenes/prompt.ts` 抽出 `DATE_RULE` 常量，`buildSceneSlotGuide()` 与
`buildScenePrompt()` 共用同一句规则（列出全部日期字段与可推导写法）；
`book_record` 的 rating 说明改成「任意正数、原样保留、宿主记录满分制」。

## 3. 测试

| 文件 | 新增 | 内容 |
|---|---|---|
| `tests/scenes.test.ts` | +13 | 4.7/6/85/100 各自保留原值并推断 5/10/100/100；`env=off` 时小数与 >5 被降级、原话进 notes、`sourceData` 保留原值；五个日期字段各一条「推导日期可接受」（weekly、monthly、historical、goal、countdown）；「凭空日期仍拒绝」；tool 路径（`create_scene_card`）下 85 保留与降级各一条 |
| `tests/card-templates.test.ts` | +1 | 阅读笔记模板 85 → 100 分制 |
| `tests/relative-dates.test.ts` | 0（改断言） | issue 文案改为「无法从原话推导」 |

## 4. 验证（实际执行）

- 定向：`vitest run tests/scenes.test.ts tests/relative-dates.test.ts tests/card-templates.test.ts tests/wire-json-schema.test.ts` 全绿
  （scenes 90、relative-dates 40、card-templates 37、wire-json-schema 21）。
- **全量对照（三棵 `git archive` 隔离树 + 同一 `node_modules`，避免共享工作树里
  另一路未提交改动污染结论；命令同 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`）**：

  | 树 | 提交 | 结果 | 说明 |
  |---|---|---|---|
  | A 我开始时的 HEAD | `9208f30` | `32 failed / 2980 passed / 3 skipped (3015)` | 基线 |
  | B 并行任务提交后的 HEAD（= 我的提交的父提交） | `4dd92a7` | `38 failed / 2985 passed / 3 skipped (3026)` | 相对 A 多出 6 条：4 条 `tool-surface-accept60`（并行提交新增用例自身失败）、`intent-progress` 5000ms 超时、`wire-json-schema`（契约 JSON 陈旧） |
  | C 本轮三笔提交 | `2b51594` | `37 failed / 3000 passed / 3 skipped (3040)` | 相对 B **新增 0**、**修复 1**（`wire-json-schema`，重新生成契约 JSON）；相对 B 的其余失败逐条同名 |

  → 结论：**失败集合相对当时的 HEAD 差集为 0 新增**；唯一差异是本轮按要求
  重新生成契约 JSON 后少了一条既有失败。新增 14 个用例全部通过
  （scenes 77→90、card-templates 36→37，总用例 3026→3040）。
- 更早一轮的隔离验证（`9208f30` + 本轮改动、不带并行改动）也得到 `32 vs 32`、
  差集 0；其中 `intent-progress > publishes a safe scene hint…` 偶发 5000ms 超时
  （无断言失败），在**未改动的 HEAD 隔离树**上同样复现 5016ms 超时
  → 环境相关的计时抖动，与本轮无关。
- 共享工作树（含另一路未提交的 `toolCalls.ts` 改动）不再用于对照：那批改动会让
  `tool-calls.test.ts` 的 target-resolution 用例抖动，归属不在本轮。
- `pnpm --filter @vivic/local-api typecheck`：仅既有 2 个错误
  （`tests/accept60-regressions.test.ts:196`、`tests/helpers.ts:8`）；
  `pnpm -r typecheck` 另有 7 个 `apps/web` 既有错误（未改动文件；HEAD 隔离树同样 7 条）。
- `pnpm lint`（oxlint，881 文件）：**0 errors**，156 个既有 warning。
- `pnpm contracts:generate` 已执行；`card-record.schema.json` 已随本轮提交。

## 5. 未做 / 后续

1. 把 `toolCalls.ts` 的 rating 降级块换成 `contracts/rating` 的纯函数（需该文件 owner），
   这样 `env=off` 时小数也能在 `sourceData` 留下 `ratingRaw`。
2. 若把「N 天后 / 月底 / 今年」补进 `intent/dateResolve`，可把 corpus 里的算术分支
   也收敛到同一个解析器（本轮未动该文件）。
3. `scenes/payload.ts` 仍要求 `YYYY-MM-DD`；中文日期表达式由 toolCalls 的归一化
   （habit/weekly/monthly/historical）先行转换，countdown/goal/photo 依赖模型输出 ISO。
   本轮的改法是「宿主不再拒绝已经推导出的 ISO」，不是「payload 接受中文表达式」。
4. 评分下界是 `positive()`：0 分暂不接受。若要允许，把 `RatingValueSchema`
   改成 `min(0)` 即可（一处），其余逻辑不变。
