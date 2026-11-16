# 相对日期契约与 clarify 门控

日期：2026-11-03
分支 / 工作树：`codex/live-backend-20261103` / `work/backend-merge`（基线 HEAD `206ea17`）
范围：只改 `work/backend-merge` 下源码、测试与文档。未部署、未发布、未改服务器、未碰 `apps/web`、未推送。

## 问题

线上「习惯打卡：每天背单词，本周一到周三做到了」没有建卡，而是被反问「打卡要具体到日期：这周哪几天打了卡？」。这不是模型理解不了，而是链路只允许它这样回答。

## 根因

1. **契约表达不了**：`HabitHeatmapCard.checkins` 只收 ISO 日期（`packages/contracts/src/sceneCards.ts`），`BookCard.rating` 只收 1–5 整数。用户说的「本周一到周三」「评分 4.5」都进不了契约。
2. **宿主把表达不了直接变成反问**：`apps/local-api/src/scenes/build.ts` 的 habit 分支在没有 checkins 时给出 `issue`/`ask`「打卡要具体到日期：这周哪几天打了卡？」，这句就是用户看到的话。
3. **宿主还在改用户数据**：`apps/local-api/src/intent/toolCalls.ts` 的 `normalizeSceneData` 把 4.5 四舍五入成 5，并把「评分 4.5」塞进 `notes`。
4. **clarify 是零成本合法工具**：模型遇到契约装不下的输入，选它没有任何代价，也没有宿主侧的反向约束。
5. **提示词不是保证**：规则 14 早就写了「相对日期直接换算」，但只是提示，没有确定性兜底，实测没兜住。

## 改法

### A. 相对日期：宿主确定性换算

新增 `apps/local-api/src/intent/dateResolve.ts`：

- `resolveDates(text, { now, timeZone })` → `{ iso, weekday, text, kind }[]`；`resolveIsoDates` 只返回排序去重的 ISO；`resolveClockTimes` 返回原话里的 `HH:mm`；`isResolvableDateExpression` 供工具参数校验。
- 支持：`本周一到周三`、`这周一二三`、`周一、二、三`、`周一到周三`、`周一二三`、`上周五`、`下周一`、`本周末`、`工作日`、`今天/昨天/明天/前天/后天/大后天`、`最近三天/最近一周`、`10月15日`、`2026-10-15`。
- 周一律为第一天；**本周一 = 包含今天的那一周的第一天**；`上周/下周` 按 -7/+7 天平移；`周一`（无前缀）= 本周一。
- 刻意不解析：`每天/每周一`（授权重复，不是具体日期）、`本周三天`（可能是「三天」而不是周三）、`三天`（无锚点）。歧义就不猜。
- 同一套解析接到两条创建路径：`create_habit` 与 `create_scene_card(scene_id="habit_tracking")` 都经过 `normalizeSceneData`；`checkins` 可收 `["本周一到周三"]`、`["周一","周二"]`、`["周一二三"]`、`["周一、二、三"]`、字符串或数组。
- 其他日期字段（代价小，已接）：`weekly_schedule` 的 `weekStart`/`events[].date`（只换算带显式周锚或相对词的写法，裸「周一」仍交给 `day`，否则会把「下周」计划挪到本周）、`monthly_calendar.events[].date`、`historical_timeline.events[].date`。
- 同一套解析用于 grounding：`build.ts` 的 `habitDateGrounded` 与 `day()` 接受「值可由原话唯一推导」的日期。

### B. 评分支持小数（不改用户数据）

- `BookCardSchema.rating` → `z.number().finite().min(0).max(5).multipleOf(0.5)`，1–5 整数仍然合法。
- 删除 `normalizeSceneData` 里的四舍五入与「评分 X」notes 注入；4.5 原样保留。
- 同步 `apps/local-api/src/scenes/payload.ts`、`apps/local-api/src/cards/templates.ts`（阅读笔记模板）与 `apps/local-api/src/scenes/prompt.ts` 的字段说明；`pnpm contracts:generate` 重新生成 `Vivic_Kimi_Handoff_v0.6/contracts/card-record.schema.json`。
- **前端交接项**：`apps/web/src/cards/scene/views/BookCardView.tsx` 的星星只支持整星（`value <= rating` 才点亮），4.5 会显示 4 颗星；前端需要支持半星渲染与点击。本轮按要求不改 `apps/web`。

### C. grounding 放宽「可唯一推导」

- 只放宽日期/星期/相对时间：字面命中仍优先（`groundedDate`），否则接受 `resolveIsoDates` 从用户原话推导出的值。
- 数字、链接、作者、DOI 仍严格字面，不参与推导。
- `issue` 文案改成点名字段和值，例如 `habit_tracking.checkins 里的 2026-11-02 无法从原话唯一推导`、`countdown.targetDate 的日期 2026-12-01 无法从原话唯一推导`；habit 的追问文案从「打卡要具体到日期：这周哪几天打了卡？」改为「这次打卡是哪几天？说「本周一到周三」或具体日期就行。」

### D. clarify 从链路层面重做

- `clarify` 参数：`missing`（必填，枚举 `date|time|target|content|link|image|other`）+ `question`。必填是为了让宿主知道「缺什么」，否则无法判断这次追问是否多余；缺失时按参数不合法走既有修复循环。
- `planFromToolCalls` 的 gate（`clarifyRejection`）：
  - `missing=date` 且原话能解析出日期 → 拒绝，`invalid` + issue 列出推导出的 ISO 日期，让既有修复循环重试；
  - `missing=time` 且原话能解析出钟点 → 拒绝，同上；
  - `missing=target` 且画布摘要里能唯一匹配 → 拒绝，issue 直接给出该卡 id/type；
  - 其余（真缺失）才允许 clarify。
- 语义说明：`clarify` 调用本身不携带业务数据，宿主无法替它建卡，所以「拒绝」的实现是 `invalid` + 精确 issue，交给既有的一次修复轮（`VIVIC_TOOL_REPAIR`，默认 on）让模型用推导结果重建。不新增模型调用层，也不在宿主里替模型猜场景。
- `clarifyQuestion` 保证问题点明缺哪一项：模型的问题里没写「日期/时间/哪张卡/内容/链接/图片」时，前缀「还缺 X：」。
- 工具描述与系统提示同步：规则 3 改为「能推导就不要问……必须用 missing 说明缺哪一项」，规则 9/14 与示例同步；`create_habit`/`create_scene_card` 明确「星期/相对日期可原样填，宿主换算」。

## 开关与回滚

- 没有新增 env 开关，行为默认生效。
- `VIVIC_TOOL_REPAIR`（默认 `on`）决定被拒绝的 clarify 是否走一次修复轮；`off` 时退化为既有「没能形成可靠动作」的诚实澄清。
- `VIVIC_LEGACY_FALLBACK` 仍只控制失败后是否回退旧 planner，未改动。
- `habitFastPath` 确定性快通道保持不变（B12 原句在模型之前就命中）。
- 回滚：revert 本提交即可，无数据迁移、无配置变更。

## 验证

定向：

```text
pnpm --filter @vivic/local-api test tests/relative-dates.test.ts
Test Files  1 passed (1)
Tests       40 passed (40)

pnpm --filter @vivic/local-api test tests/clarification.test.ts tests/tool-calls.test.ts tests/tool-repair.test.ts tests/scenes.test.ts tests/habit-fast.test.ts tests/relative-dates.test.ts
Test Files  6 passed (6)
Tests       226 passed (226)
```

（按子串过滤时 `clarification` 也会匹配 `decision-target-clarification.test.ts`，它属于既有基线失败；上表改用完整路径，故为 6/6 全绿。）

全量（4 workers，与仓库既有口径一致）：

```text
pnpm --filter @vivic/local-api test -- --maxWorkers=4
Test Files  13 failed | 111 passed | 2 skipped (126)
Tests       32 failed | 2883 passed | 3 skipped (2918)
```

- 与 `work/verify/logs/baseline-failures.txt` 逐条比对：**current=32 / baseline=32，差集 0 条**（仅基线文件带 `FAIL ` 前缀）。失败集合仍是既有 32 个（decision/provider/accept60/weekly-plan 等）。
- 新增 40 个用例（2918 − 2878），通过 2883（2843 + 40）。
- `pnpm --filter @vivic/local-api typecheck`：仍只有 2 个既有错误（`tests/accept60-regressions.test.ts:196` 参数个数、`tests/helpers.ts:8` `modelApiBaseUrl` 类型），本次改动没有新增类型错误。
- 仓库级 `pnpm typecheck` 另外在 `apps/web` 报出 7 个既有错误（`SettingsExperience` props、缺失的 `CanvasManager` 模块、`stage.sleep` 不在 Action 联合内等），全部位于本轮未改动的文件，与契约/后端改动无关；未修，也未降低检查。
- `pnpm exec oxlint` 检查 11 个改动/新增文件：0 warnings / 0 errors（顺手删掉了 `toolCalls.ts` 里本来就未使用的 `HOST_OPERATION_TOOLS`，它会让改动文件带 1 条 warning）。

## 端到端结果

- B12 原句「习惯打卡：每天背单词，本周一到周三做到了」：`runIntent` 直接返回 `HabitHeatmapCard`，`checkins = ["2026-11-02","2026-11-03","2026-11-04"]`（2026-11-03 为周二），模型 0 次调用，不走 clarify。
- 同形状但不含「本周/这周」的句子（`打卡记录：每天背单词，周一、二、三都做到了`）走工具层：模型先 `clarify(missing="date")` → 宿主拒绝并给出推导日期 → 修复轮 `create_habit` → `HabitHeatmapCard`。
- 真正缺信息的「这个帮我记一下」仍然 clarify（`missing="content"`），「习惯打卡：每天背单词」仍然 clarify 日期。

## 未做项 / 边界

- **前端半星**：`BookCardView` 只渲染整星，4.5 显示 4 颗星；半星渲染与点击属于前端交接项，本轮不改 `apps/web`。
- `weekly_schedule` 的裸「周一」仍由模型填 `day`，不按本周一强行换算（避免把下周计划挪到本周）；只有显式周锚/相对词才换算。
- 只放宽日期类推导；数字、链接、作者、DOI 保持严格。
- 未做真实模型回归（无线上 key 的受控环境）；`work/verify` 下的日志是本机运行产物，未纳入提交。
- 未部署、未发布、未改服务器、未推送。
