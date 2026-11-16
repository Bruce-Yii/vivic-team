# 模型是唯一决策者，宿主只做确定性推导/校验/报错（2026-11-03 第 5 轮）

依据：`work/verify/findings/accept60-failures-20261103.md`（10 条失败逐条根因）、
`work/verify/findings/probe-60fail.json`、`work/verify/findings/accept60-fail-raw/`、
`work/real-browser/accept60-final/accept60-2240b.log`（`2240e34` 之后的跑批：54/60，6 条失败：
sc-15 / sc-16 / sc-18 / sc-19 / sc-21 / sc-47）。

本轮修的是同一个病根：**链路上每一层都在替模型做决定**——规则层（含直接澄清）、工具面重叠、
宿主目标解析否决、数据适配器关键词抢跑。原则落成三条可检查的规则：

1. 规则层只有在**能完整、无歧义地产出动作**时才接管；"规则觉得信息不全"不是接管理由。
2. 宿主对模型的产出只做三件事：**推导**（用户原话能算出来的事实）、**校验**（值是否来自原话/契约）、
   **报错**（把问题连同候选回给模型，让它重试或自己澄清）。不许静默替换、不许直接吞掉。
3. 一个能力只有一个出口；能力的描述必须写清"什么时候绝对不能用我"。

不部署、不发布、不碰服务器、不改 `apps/web`、不跑线上验收。契约层（`packages/contracts`）未改。

本文件**取代** `2026-11-03-tool-surface-and-targets.md` 的三处结论：该文 §7「保留 `create_weekly_plan`
的哪几天判断」、§6「候选澄清是决策、不触发修复轮」、以及"未修"里的 sc-18 判分口径与 sc-21 择优。

---

## A. 规则层只留"精确格式直出"

### A1 `create_weekly_plan` 不再问"下周想练哪几天、每次多久"（sc-16）

- 失败：`帮我做一个下周的健身计划` 在 2240b 里 890ms 得到 `kind:"clarify"`、0 卡——句子已经到达工具层、
  模型已经选了 `create_weekly_plan`，是宿主的工具分支又把它换成了一句问题（`toolCalls.ts` 里的
  `健身|减肥|… && 没有星期/时长 → needle("下周想练哪几天…")`）。
- 改动：删除该分支（`apps/local-api/src/intent/toolCalls.ts`，`create_weekly_plan`）。
- 依据：练哪几天、练什么是**计划自己的内容**（`scenes/build.ts` 的 `weekly_schedule`：`plannedWeek =
  corpus.weekdays.size === 0` 时只约束钟点）；只有钟点必须来自原话。模型选了工具，宿主就按它自己的
  场景契约把卡建出来，建议日 1/3/5 与动作名来自 `planEventTitles`，不编钟点。
- 边界：`topic` 为空/超长仍走 `askOrFail`（参数校验，不是"信息不全"）；`create_weekly_plan` 只建
  `weekly_schedule`，不会替模型改选别的卡。
- 覆盖：`tests/tool-calls.test.ts`「builds a bare fitness plan instead of asking 哪几天」、
  `tests/tool-surface-accept60.test.ts`「sc-16 builds the plan in the tool path too」（复刻 2240b 的
  画布形状：画布里有卡片正文提到周三，确定性周计划构建器会放弃，句子落到工具层）。

### A2 数值适配器不再抢 `option_comparison` 的句子，也不再拿"缺数据"当终局（sc-18）

- 失败：`做一个表格对比 iPhone 和华为的参数` 曾以 66–81ms 被 `parseNumericIntent` 的 `clarify(example)`
  变成终局（"表格需要你提供数据"）。2240b 里它已经能建 `ComparisonCard`，但只是靠
  `needsNumericSlotExtraction` 里那个 `/\d/` 兜住的——句子没有数字时仍会被拦。
- 改动（`src/data/numeric.ts`）：
  - `parseNumericIntent` 遇到 **对比/比较/参数/规格/配置/尺寸/优缺点/价位** 直接返回 `null`：
    这不是"名称 数值"序列，是 `option_comparison` 的活，适配器不认领。
  - `needsNumericSlotExtraction` → 更名语义化的 **`adapterClarifyIsNotFinal`**：句子带表格/图表词但
    不符合紧凑语法时，适配器的澄清**不许成为答复**（不再要求句子里有数字）。混合/破坏性句子
    （"柱状图：A1，然后删除所有卡片"）仍然保留适配器的拒绝——那不是语法不匹配，是部分执行风险。
- 保留的精确直出：`用表格记录：周一3，周二5`、`做个表格`（空白表）、`柱状图：A1，B2`、
  标签重复/超限这类**语法内**的校验报错。
- 覆盖：`tests/numeric-slot-fallback.test.ts`（11 条：对比句不被认领、表格句交给模型、
  已解析/混合边界、精确形状仍直出）、`tests/tool-surface-accept60.test.ts`「sc-18 …」。

### A3 删掉 pipeline 的两道倒计时门（审计结论）

- `pipeline.ts` 原有两处「`倒计时` + `设/做/建/来` 但原话没有时长 → `clarify("倒计时设多长时间？")`」，
  在任何模型之前就截断句子。按 A 的原则删除：句子里没有时长时，模型仍会被调用，而**时长必须来自
  用户原话**这条约束留在真正提出值的地方——`create_countdown` 用 `utterance` 复核，模型编的时长
  同样被拒（`tests/tool-calls.test.ts`「asks for a duration the user never said」）。
- 边界：这句 `倒计时设多长时间？` 现在来自工具层的**值校验**（模型已选工具、给出了时长、但与原话不符），
  不再是规则层的**意图裁决**。

### A. 审计后**有意保留**的规则层澄清（都在"能完整产出动作"或"宿主/供应商硬约束"一侧）

| 位置 | 保留理由 |
|---|---|
| `pipeline.ts` `incompleteCanvasIssue` | 画布被截断（>64 张）时宿主无法按顺序/批量操作，是宿主能力边界，必须告诉用户，不是替模型判断信息够不够 |
| `scheduledReminders.ts` 的 9 条 `message` | 只有句子**精确命中**提醒语法（每天/每隔/如果/明确日期时间）后才进入，缺的是语法内必填字段或值非法 |
| `pipeline.ts` 删除确认、无模型离线、HTTP 链接策略、旅游 ask、`adapterOnly` | 安全策略/宿主确认/供应商追问，与本轮"信息是否充分"无关 |
| `data/weather.ts` 的 `CitySchema` / "只支持当前天气" | 供应商能力边界（当前天气），且 sc-21 走的是 A/B/D 那三条 |

## B. 工具面互斥：`answer` 不再抢 `search`/天气

- 失败：sc-19 `最近有什么 AI 方面的大新闻` → 模型选 `answer`，落了一张 `NewsCard`
  （"AI 新闻：我没法联网…"），没有来源、内容是编的；sc-21 `明天南京要穿外套吗` → 模型选 `chat`，
  回"我查不到南京明天的实时天气"。两句都该走宿主已有的联网/天气链路。
- 根因：工具面只有"建卡"和"不建卡"两种出口，`answer` 的描述只写"什么时候用我"，没写
  "什么时候绝对不能用我"；而且**宿主明明有 search/weather 能力，工具面却没有出口**，模型只能二选一。
- 改动（`src/intent/toolCalls.ts` + `src/intent/pipeline.ts`）：
  1. 新增 **`search(query)`**：模型选它，宿主跑既有已验证检索链（`deps.search.webSearch` →
     `buildSearchEnvelope`），产出带 `sources` 的 `SearchResultCard`。映射器仍然零 I/O：
     只产出 `ToolCallPlan.kind = "lookup"`，由 `pipeline.ts` 用 `adapterOnly` 重入数据/检索分支。
  2. 新增 **`weather(city?)`**：同上，重入 `handleDataIntent("南京天气")` → `WeatherCard`；
     `city` 缺省＝按当前位置。
  3. `answer` / `chat` 的描述写死否定清单：新闻/大新闻/最近/最新/实时行情/比分/榜单/票价 → `search`；
     天气/气温/冷不冷/要不要带伞或穿外套 → `weather`；`chat` 连"我查不到"都不许用它说。
  4. 系统提示词新增 2b/2c 两条优先级 + 两个例子（`最近有什么 AI 方面的大新闻`→`search`，
     `明天南京要穿外套吗`→`weather(city="南京")`），并说明天气只支持当前天气、不要说自己查不到。
  5. **宿主校验兜底**：句子含"实时事实"（新闻/行情/比分/天气… × 最近/今天/明天/有什么…）时，
     `answer` 与"独占的 `chat`"都返回 `invalid` + issues（明确点名该用 `search`/`weather`），
     走既有修复轮让模型改选——这是"报错回给模型"，不是替它决定。
  6. **确定性下限**：若修复轮之后仍是这个局面，`pipeline.ts` 直接用原话走检索链。实时资讯不允许
     "凭记忆回答"或"换一种说法"式死路，而检索是能完整产出动作的确定性能力（符合 A 的接管条件）。
  7. `search` / `weather` **每次只调一个、且必须单独一批**：适配器自带整包卡与来源，不能与
     create/update 合并；同批出现即 `invalid`（`一次只能查一件事`）。这是本轮明确的边界，
     复合句子里的"查 + 建卡"暂不支持。
- 为什么**不删** `answer`：`answer` 与 `search` 的重叠已由"否定清单 + 宿主校验 + 确定性下限"消掉，
  两者语义不再交叉（`answer` = 稳定知识；`search` = 会变的事实）。删掉它就得让 sc-13/sc-45 走
  `chat` + `create_note`，那会重新引入"知识问答该不该建卡"的二义性，比现状更含糊。**保留 `answer`，
  但把"什么不能用它"写进契约描述和宿主校验里**，是最小且不重叠的方案。
- 覆盖：`tests/tool-surface-accept60.test.ts` 新增 4 条 pipeline 级用例（sc-19 拒绝 answer 后改选
  search 落 `SearchResultCard`；sc-19 模型始终不改选时确定性下限仍落 `SearchResultCard`；
  sc-21 拒绝 chat 后改选 weather 落 `WeatherCard`；sc-13 稳定知识仍走 `answer`/`NewsCard`）。

## C. 宿主目标解析：加别名，失败回给模型重试

- 失败：sc-15 `这张谷歌的卡片讲了什么`，画布上的卡是「Google 公司介绍」。旧 `resolveTarget`
  只做字面标题/别名包含，`谷歌` 匹配不到任何卡，于是落到"这张→最近聚焦"的捷径，把模型（或用户）
  指向 `note_meeting`，整轮 5359ms、0 卡、目标错。
- 改动：
  1. 新增 **`src/decision/aliases.ts`**：39 组中英/俗称对照（谷歌↔Google、苹果↔Apple、宁德时代↔CATL…），
     `squash()` 统一大小写/空白/中英标点，`matchKeysOf()` 给一张卡算出它"应答的所有名字"
     （标题/别名 + 标题里出现实体的所有等价写法），键长 < 2 丢弃（避免 `X` 这种单字符）。
  2. `src/decision/target.ts` 的 `resolveTarget` / `hasExplicitCardReference` 改用这套键：
     名字命中优先于"这张/它"的聚焦捷径（用户点了名，就不能被焦点覆盖）。
  3. **新增：`names.length > 1` 直接 `ambiguous`**（候选列出这些卡）。此前"两个名字都对上"会继续
     往下走，被"这张"分支悄悄收成聚焦卡——这是"静默替换模型决定"的另一种形态。
  4. 目标解析失败（找不到 / 歧义）不再只是给用户一句问题：`toolCalls.ts` 统一走
     `resolveHostTarget()`，返回 **`invalid` + issues**（歧义时 issues 里带编号候选和"用摘要里的 id
     或 clarify(missing=\"target\")"的指令），让**既有修复轮**把候选交回模型；修复轮仍失败时才用
     宿主那句带编号候选的话术兜底（`pipeline.ts` 用 `plan.message`）。**不再返回空 envelope**，
     也不会静默任选一张。
- 边界：别名表只收专有名词，故意不收"理想/大众"这类日常词（假阳性比漏别名更糟，模型还能自己填 id）；
  候选最多 4 个、只显示卡名不显示内部 id。歧义多花一次模型轮（sc-56 从 1033ms 变约 2s）：
  换来的是"模型有机会自己认定，或自己问出来"，而不是宿主替它挑。
- 覆盖：`tests/alias-targets.test.ts`（7 条：squash、等价写法、键长过滤、正负匹配、
  `resolveTarget` 的 alias/title/双命中）、`tests/tool-surface-accept60.test.ts`
  「sc-15 focuses answer_google for 这张谷歌的卡片」「still refuses to guess when the translated name
  matches two cards」、`tests/tool-surface-accept60.test.ts` 的 sc-56 用例改为断言
  "先生成 invalid 让其修复轮重试，最终澄清仍带编号候选"、`tests/tool-calls.test.ts`
  「hands an ambiguous target back to the model…」。

## D. 天气地名规范化：按地点去重 + 择优

- 失败：sc-21 曾回「找到多个同名或近似地点：南京 / 江苏 / 中国；南京 / 云南 / 中国；南京 / 云南 / 中国…」，
  同一条地点（PPL 与 ADM 两行）出现两次，且南京对人是无歧义的。
- 改动（`src/data/weather.ts`）：
  1. `LocationSchema` 增加 `population`（GeoNames 本来就有，之前被 zod 丢掉，无法择优）。
  2. 去重键从 `id` 改为 **规范化 name + admin1 + admin2 + country_code**：同一地点只算一次。
  3. 择优：`featureTier(PPLC>PPLA/ADM1>PPLA2/ADM2>PPLA3/ADM3>PPLA4/5/PPL>ADM4)` → `population` →
     名称；**领先判据**：只有 1 个；或等级严格更高；或同等级但人口 ≥ 2 倍且 ≥ 2 万。
     都不满足＝真并列，才给候选澄清。
  4. 候选话术最多列 3 个**互不相同**的地点；`geo.results.length === 10` 的"整页可能还有同名地点"
     保护保留（线上 `name=南京` 只返回 3 行，不会把 sc-21 变回问题）。
- 边界：不做 GPS 推断、不按"第一行"选；`上海/北京/天津/重庆` 的直辖市特例保留；人口缺失的候选
  永远不能靠"2 倍人口"赢。
- 覆盖：`tests/accept60-regressions.test.ts` 重写该 describe（2 条）：南京 fixture（含一行重复的
  ADM2）→ 直接出 `WeatherCard`（admin1=江苏、带 geocoding 来源）；`新城` 真并列 → 澄清且
  「新城 / 陕西 / 中国」只出现一次。

## E. 判分口径（不是产品代码）

- 文件：`work/real-browser/accept60-final/`（主仓 `work/` 下的评测脚手架，不在本 worktree 的源码范围；
  这里记录改动，便于复跑）。
- 口径改了三处，落到**唯一实现** `accept60-rules.mjs`：
  1. `expected_card_types` 是"**任一合格**"（dataset 里 sc-18 的 notes 明写"TableCard 与 ComparisonCard
     任一合格"），判分改为"实际卡型是期望集合的**非空子集**"；`card_optional` 允许零卡；
     期望为空则不许建卡。旧口径是集合全等，把正确产物连续两天各判一次 fail。
  2. notes 里写"若已支持一次提交，记录为产品变化而非失败"的用例（sc-47），当响应确实在一次提交里
     完成两个子动作（有画布动作 + 有宿主操作）时，clarify 层判过并单独记 `pass-product-change`，
     报告里列进 `productChanges`，不混进 fail。
  3. 报告/摘要新增 `cardRule` / `clarifyRule` / `productChanges` 字段；每条结果带 `notes`，
     首句缺失仍单独统计（不与能力失败混在一起）。
- `judge.mjs`（落盘行复判）与 `build-report.mjs` 同步这套语义（并从 dataset 补 notes）；
  顺带把"无 trace 时路由层不可观测 → N/A"写进 `judge.mjs`，与 `accept60-rules.mjs` 一致。
- **离线重算**（不重跑线上）：`node recompute-2240b.mjs`（只读 `accept60-raw/*.json` + 旧日志对照）：
  - 旧口径（`accept60-2240b.log`）：**54/60**；
  - 新口径重算：**56/60**，翻转 2 条 —— sc-18 `fail-cards → pass`（任一合格）、
    sc-47 `fail-clarify → pass-product-change`（notes 允许一次提交）；
  - 新口径下仍失败 4 条：sc-15（fail-target）、sc-16（fail-cards）、sc-19（fail-cards）、
    sc-21（fail-cards）——正是本轮 A/B/C/D 修的四条，**它们要在下一轮线上跑批里验证**。
  - 产物：`accept60-2240b-recomputed.json`。

---

## 验证

- 全量：`pnpm --filter @vivic/local-api test -- --maxWorkers=4`
  - 改动前 HEAD（`5fcebd5`）：**32 failed / 2925 passed / 3 skipped（2960）**，13 个文件失败；
  - 改动后：**32 failed / 2942 passed / 3 skipped（2977）**，同样的 13 个文件；
  - `Compare-Object` 逐条比对失败集合：**差集 0**（清单：`work/verify/round5/baseline-failures.txt`
    与 `after-failures.txt`，全量日志 `baseline-full.log` / `after-full.log`）。
- `pnpm --filter @vivic/local-api typecheck`（`tsc -b`）：仅既有 2 个错误
  （`tests/accept60-regressions.test.ts:196`、`tests/helpers.ts:8`），无新增。
- `pnpm exec oxlint` 改动文件（11 个）：**0 warnings / 0 errors**（顺手修掉 `numeric.ts` 两处既有的
  `no-useless-escape`）。
- 新增/改写单测：`tests/alias-targets.test.ts`（7）、`tests/numeric-slot-fallback.test.ts`（11，重写）、
  `tests/tool-surface-accept60.test.ts`（18 = 原有 11 + 新增 7，另改写 1 条 sc-56 断言）、
  `tests/tool-calls.test.ts`（改写 3：周计划、目标歧义、工具清单 24→26）、
  `tests/accept60-regressions.test.ts`（南京 describe 由 1 条改为 2 条）。

## 未做 / 只能线上验证的

- **模型是否真的选对工具**：`answer` vs `search` vs `weather` 的最终效果取决于真实模型的服从度。
  本轮把"描述、优先级、例子、宿主校验、确定性下限"五层都做了，但只有线上跑批能证明 sc-19/sc-21 变绿。
  本地能证明的是：模型选错时宿主不会让它成为答复（单测锁了三条路径）。
- **复合句 "查 + 建卡"**：`search`/`weather` 必须单独一批；"最近AI新闻，顺便加个待办" 会被要求二选一。
  合并两套 envelope（适配器卡 + 建卡动作）需要新的顺序语义，未做。
- **天气仍只支持当前天气**：sc-21 问"明天"，产物是当前天气卡 + 话术；提示词已要求"说明这是当前天气"，
  真正的明日预报需要供应商侧的多日端点，未做。
- **`judge.mjs` 的 target 层**与 `accept60-rules.mjs` 仍有差异（前者只在澄清点名了目标卡时算对，
  对 sc-32/35/36/46/55 更严）：两者对同一批 2240b 原始响应给出 51/60 vs 56/60。卡型/clarify 已统一，
  target 层口径未统一，以 `recompute-2240b.mjs` 的 56/60 为准（报告里注明）。
- **sc-47 的首句**：两件事都做了但 `spokenText` 为空（产品变化里仍缺一句确认话术），本轮未改。
- **`weekly-plan-grounding.test.ts` 的 2 条**在 HEAD 就已失败（`planDeterministic` 在带星期正文的画布上
  放弃该句），与本轮无关，未动。
- 线上验收（真机/浏览器/部署）按约束未跑。
