# 查询工具只读：事实回灌，输出由模型决定（2026-11-05）

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `f31741a`。
- 范围：`apps/local-api/src/intent/toolCalls.ts`、`apps/local-api/src/intent/pipeline.ts`、
  `apps/local-api/src/intent/lookupFacts.ts`（新增）、测试
  `tests/query-tools-read-only.test.ts`（新增）、`tests/tool-composite-lookup.test.ts`、
  `tests/tool-read-url.test.ts`、`tests/weather-fallback.test.ts`、`tests/tool-calls.test.ts`、
  `tests/tool-surface-accept60.test.ts`、`tests/pipeline-rules-and-adapters.test.ts`、
  `tests/capability-inventory.test.ts`、本文档。
- 另同步主仓 `work/` 下**未跟踪**的验收脚手架：`work/scenarios/scenarios-20261031.json`
  （sc-19/20/21 改为 `card_optional` + 产品变化说明）、
  `work/real-browser/accept60-final/accept60-rules.mjs`（判分口径注释）。它们不在本 worktree 的提交范围。
- 边界：没有部署、没有碰服务器、没有跑线上 60/48；没有新增依赖；没有改卡片契约、前端或持久化。

## 1. 为什么拆

`weather` / `search` / `read_url` 被实现成了**写操作**：

```
模型选 weather → 宿主跑适配器 → 宿主建 WeatherCard + 固定口播「已显示南京明天天气」
模型选 search  → 宿主跑检索   → 宿主建 SearchResultCard + 固定口播「已整理 N 条结果」
模型选 read_url→ 宿主读网页   → 宿主建 SearchResultCard（正文卡）
```

再加「查询 + 建卡同批」时，宿主还要把查询 envelope 与模型卡片 envelope 合并。结果有三层问题：

1. **输出形态由宿主决定**：查询成功就必然出卡，模型没有机会只回答；
2. **模型拿不到事实**：口播是宿主写的模板，模型看不到城市、日期、最高/最低温、降水概率，
   所以「明天南京要穿外套吗」只能得到一张卡和一句界面说明，问题本身没被回答；
3. **隐式契约**：卡片不是模型的产物，模型只是按了一个按钮。

这不是提示词能修的：事实没有进入模型，说的内容又被宿主写死。要改的是**工具结果的去向**。

## 2. 新协议：查询只回灌事实

三个查询工具对外仍是同一组工具（不新增工具、不改参数），但语义改成只读：

| 工具 | 宿主做什么 | 宿主**不**做什么 |
| --- | --- | --- |
| `weather` | 跑已验证的 Open-Meteo 适配器（城市歧义仍回问），把城市/日期/天气/温度区间/降水概率作为事实回灌一次 | 不建 WeatherCard、不写口播、不返回 envelope |
| `search` | 跑已验证的检索链，把 1–5 条的标题/摘要/来源域名作为事实回灌一次 | 不建 SearchResultCard、不写「已整理 N 条」 |
| `read_url` | 读取公开 HTTPS 页面，把标题 + ≤1200 字正文摘录作为事实回灌一次 | 不建正文卡、不替模型总结 |

### 2.1 一次查询只回灌一次，且必须单独调用

查询工具在新协议里是**单发**的：不能和 `search`/`weather`/`read_url`/`create_card` 同批。
原因不是保守，而是协议正交：一条工具结果只能进入**下一轮**，和「消费它的建卡」同批时宿主就必须猜
「这张卡是不是已经用了查询结果」——那正是旧 `lookupEnvelope` 合并逻辑在做的事。

- 单独查询 → `kind: "lookup"`，宿主执行 → 回灌 → 下一轮模型返回回答/卡片；
- 回灌轮再次调用查询 → `invalid-param`（「不要重复查询」），走既有修复轮；适配器不会被第二次执行；
- 回灌轮仍无可用计划 → 修复一轮后如实说明，不自动补卡。

### 2.2 下一轮由模型决定输出

回灌轮的 prompt 只有事实和一句选择说明（`lookupFacts.ts:lookupFactsPrompt`）：

```
查询只回灌这一次，不要重复查询。请只返回下一步工具调用：
直接回答用户就用 chat(reply="一句回答")；要展示就用 create_card(kind=… )；
回答和建卡可以同批，只回答（零卡）也可以。
```

| 场景 | 模型返回 | 结果 |
| --- | --- | --- |
| 回答「明天南京要穿外套吗」 | `chat(reply="明天南京 8–15℃，有雨，早晚偏凉，建议穿外套。")` | `spokenText` 是模型的话，**零卡** |
| 回答 + 展示 | `chat(reply=…)` + `create_card(kind="weather")` | 一张 WeatherCard + 模型的话 |
| 只要资料卡 | `create_card(kind="search_results")` | 检索结果卡（每条带来源） |
| 只回答新闻 | `chat(reply=…)` | 零卡，不再有「已整理 N 条」 |
| 网页正文卡 | `read_url` 后 `create_card(kind="article")` | 正文卡（`sourceData.articleText` 仍可展开阅读） |

`chat` 因此新增可选参数 `reply`（1–180 字）。没有 `reply` 的 `chat` 行为不变（仍交给宿主 planner）；
回灌轮里没有 `reply` 的 `chat` 被视为缺参数并退回一次，因为 planner 从未见过这些事实。
`confirmationOf` 同时改成「模型说过的话优先」：模型回答 + 建卡时 `spokenText` 是回答，不再是
「已创建 N 张卡片」。

### 2.3 失败、澄清与天气兜底

失败仍然是事实，不是输出形态：

- 适配器失败（超时/不可用/5xx/空结果）→ 适配器自己的原因作为 `issues` 回给模型一次修复轮；
  修复不了就如实说明；
- 城市缺失/歧义（适配器 clarify）→ 仍是一次修复轮 + 追问，不被搜索掩盖；
- 天气适配器失败 → **保留**已验证的搜索兜底。兜底结果作为 `kind: "search"` 的证据回灌
  （prompt 明说「天气服务暂时不可用，宿主已改用联网检索」），模型可以据此回答或建检索卡；
  此时 `create_card(kind="weather")` 会被拒绝（本轮没有天气证据），避免把搜索结果伪装成天气；
- 两层都失败 → `kind: "error"`，一句话同时给出两层原因；
- `read_url` 读不到 → `vendor-unavailable` + 「网页没读成：…」，不建卡。

## 3. `create_card` 的三个新 kind 与证据校验

`create_card` 仍是唯一的建卡入口，模型仍然**不写 CardRecord**。新增：

| kind | 卡型 | 字段 | 证据要求 |
| --- | --- | --- | --- |
| `weather` | WeatherCard | `{}` | 本轮 `weather` 成功回灌的天气证据 |
| `search_results` | SearchResultCard（1–5 张） | `{limit?: 1–5}` | 本轮 `search` 成功回灌的检索证据 |
| `article` | SearchResultCard（正文卡） | `{}` | 本轮 `read_url` 成功读取的网页证据 |

校验规则（`toolCalls.ts` 的 `case "weather" / "search_results" / "article"`）：

1. `options.evidence.kind` 必须与 kind 匹配且 `cards` 非空；否则 `invalid-param` +
   hint（「先单独调用 weather/search/read_url…」）。这就是「没有查询证据却建卡」的拒绝路径；
2. 同一批只允许发布一次查询证据（`evidenceUsed`），不会重复创建同一批卡；
3. 卡本身是适配器已经构建并验证过的那张（sources、sourceData、grounding 不变），宿主只把它
   放进本批动作；`placeNewCards` 仍统一摆位；
4. 模型不能借 `kind=weather` 改写温度、借 `kind=search_results` 补来源——这些字段不在参数里。

`kind=answer/note` 的一刀切规则不变：实时事实仍禁止用它们凭记忆顶替，但 hint 从「换成 search」
改成「先查，再用 `chat(reply=…)` 或对应查询卡」。

## 4. 删掉的宿主自动路径

- `weather` / `search` 单独调用时**不再**返回适配器 envelope：`answerLookupResult`、`lookupEnvelope`、
  `mergeEnvelopes` 参与查询合并的部分、`lookupEvidenceText` / `lookupFollowUpPrompt` 的混批修复路径全部删除；
- `read_url` 的「模型没给动作就把正文卡塞给用户」删除；`articleRequest` 这条纯句式自动阅读只在
  **没有工具面**的降级路径保留（`!deps.toolCalls`），工具面下由模型决定 `kind="article"`；
- 工具路径不再产生「已显示…天气」「已整理 N 条结果」；模板仍留在适配器 envelope 里，但只服务于
  没有工具面的旧路径（见 §6）；
- 条件子句守卫（sc-60）改成**查询进行中不拦**：先让查询跑完，再在回灌轮判断模型有没有解释
  「如果下雨就提醒我带伞」；否则模型永远拿不到事实来解释。

## 5. 成本

- 每次成功查询**多一次模型工具轮**（查询轮 + 回灌轮）。回灌 prompt 上限 1200 字事实，
  没有新增摘要调用；失败查询仍是一次修复轮。
- 查询必须单发，复合句（「查新闻并记待办」）从「一轮两效果」变成「两轮」：第一轮查询，
  第二轮回答/建卡 + 待办。多一轮延迟，换掉宿主合并与「卡片是否已用结果」的猜谜。
- 卡片数量与内容不变；`search_results` 可 `limit` 1–5，避免把全部结果一次推上画布。

## 6. 兼容与边界

- 工具描述、系统提示同步为「查询工具返回事实；是否展示、如何回答由你决定」，并给 3 个示例
  （问句先回答可附卡 / 要资料建结果卡 / 只要答案零卡）；没有写死流程或新的分支规则。
- `VIVIC_TOOL_CALLS=on` 的工具面走新契约；**没有工具面的旧 planner `lookup` 路径保持原行为**
  （宿主建卡 + 模板口播）。那条路径没有 `create_card` 能力，把事实回灌给它只会得到纯文本；
  是否需要同样下沉，留作后续决策（见 §9）。
- sc-19/20/21 的数据集期望改为「回答和/或卡」（`card_optional: true` + 产品变化 notes）；
  `accept60-rules.mjs` 的口径注释同步。旧「查询必须落卡」的判分作废。
- 并发冲突留痕：本轮开始时同一 worktree 出现了另一套未提交的「保留自动建卡 + planner 回答轮」
  方案（`answer.ts` + `verified-answers.test.ts` + 决策文档）。它仍是宿主决定输出形态（且用
  `isAnswerQuestion` 写死何时回答），与本决策相反；其实现已从工作树移除，快照保存在
  `work/answer-from-verified-data/`（未跟踪、未合并），由维护者决定是否归档。

## 7. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  - 改动后：**8 failed / 2809 passed / 3 skipped（2820）**；
  - HEAD 基线：把本轮改动 stash 掉后重跑同一组失败文件（`command-matrix`、`deepseek`、
    `provider-main-transport`、`stepfun-stream`、`weekly-plan-grounding`）：**8 failed / 82 passed（90）**，
    失败用例名与改动后**逐条一致（差集 0）**；干净 HEAD 的全量支数未重跑，但失败集合来自同一批文件，
    且这 5 个文件不在本轮改动范围内；
  - 失败集合：`command-matrix`（todo）、`deepseek`（无 key 路径）、`provider-main-transport` ×3、
    `stepfun-stream`（timeout）、`weekly-plan-grounding` ×2，均为既有失败；
  - 日志：`work/verify/query-read-only-20261105/after-committed.log`、`baseline-failing-files.log`。
- 定向：`query-tools-read-only` 14、`tool-calls` 194、`tool-composite-lookup` 4、
  `tool-read-url` 4、`weather-fallback` 5、`pipeline-rules-and-adapters` 7、
  `tool-surface-accept60` 25、`capability-inventory`，全部通过。
- 类型：`pnpm --filter @vivic/local-api typecheck`（`tsc -b`）仅既有 `tests/helpers.ts:8`
  （`modelApiBaseUrl` 可选性），无新增。
- Lint：`pnpm exec oxlint` 改动/新增的 11 个源码与测试文件：**0 warnings / 0 errors**。

## 8. 行为差异（相对 HEAD）

| 输入 | HEAD | 现在 |
| --- | --- | --- |
| 明天南京要穿外套吗 | WeatherCard +「已显示南京明天天气」，不回答 | 模型回答「8–15℃，建议穿外套」（零卡）；想展示再建卡 |
| 最近有什么 AI 大新闻 | 1–5 张结果卡 +「已整理 N 条结果」 | 模型只回答（零卡）或 `kind=search_results` 建卡，或两者同批 |
| 读一下某个链接 | 正文卡 +「已读取网页正文」 | 模型回答或 `kind=article` 建卡 |
| 没有查询证据就 `create_card(kind=weather)` | （kind 不存在） | `invalid-param` + hint，不建卡 |
| 查询 + 建卡同批 | 宿主先查、合并两个 envelope | `invalid-param`：「查询必须单独调用」，下一轮再建卡 |
| 天气适配器失败 | 宿主直接出检索结果卡 + 兜底口播 | 搜索事实回灌，模型回答/建检索卡，并被告知是兜底 |
| 查询回灌后再查一次 | 由 `tried` 指纹拦截 | `invalid-param`「不要重复查询」+ 一次修复轮 |

## 9. 未验证 / 后续

- **真实模型行为**：单测锁定的是宿主契约（只读、单发、回灌一次、证据校验、零卡合法）。
  真实模型是否真的在回灌轮选择「只回答」而不是习惯性建卡，是否遵守「查询必须单独调用」，
  需要下一轮线上跑批观察；本轮按约束没有跑 60/48。
- **延迟**：多一轮工具调用的端到端耗时未测；90s 总预算没有调整。
- **旧 planner 路径**：`VIVIC_TOOL_CALLS=off` 仍是宿主建卡 + 模板口播。是否把同一契约下沉到
  那条路径（例如只允许文本回答）需要单独决策。
- **证据边界**：`search_results` 只发布适配器已构建的卡，不做二次摘要；`limit` 之外的结果
  本轮不可再取（查询不重复）。模型若需要「第 6 条」只能基于回灌的事实回答，不能再查。
- **回答的事实校验**：`chat(reply)` 目前没有像旧 `answer.ts` 那样的温度哨兵；宿主提供事实、
  prompt 要求只用事实，但没有机器校验。是否加轻量校验（只允许事实里出现的温度）留作后续。
