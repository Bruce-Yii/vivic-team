# 搜索查询词改写 + 只读金属价格（2026-11-05）

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `789a11e`。
- 范围：`apps/local-api/src/intent/toolCalls.ts`、`intent/lookupFacts.ts`、`intent/pipeline.ts`、
  `src/data/metalPrice.ts`（新增）、`observability/intentLog.ts`、`src/app.ts`，以及测试
  `tests/search-query-rewrite.test.ts`（新增）、`tests/metal-price.test.ts`（新增）和 5 个已有测试文件里
  过时的口语查询样例。
- 边界：没有部署、没有碰服务器、没有跑线上 60/48；没有新增依赖（用的是全局 `fetch`）；没有改卡片契约、
  前端、持久化或数据库。

## 1. 两个根因（本地 60 条实测）

### 1.1 sc-19「最近有什么 AI 方面的大新闻」：查询词不是关键词

模型把整句口语当成搜索词（`最近 AI 大新闻`）传给 Bing。中文分词把「最近」当成主词，返回了歌曲《最近》
和词典释义，一条 AI 新闻都没有；同一时间用 `AI 最新进展 2026` 能返回 AI 相关内容。**搜索工具本身没坏，
坏的是输入**：宿主从未要求 query 是关键词，也没有拒绝整句原话。

因此修复分两层，缺一不可：

1. 提示词与工具描述把「关键词」写成硬契约，并给正反例；
2. 宿主做**确定性校验**（只拒绝、不改写），拒绝后走既有的 tool repair 轮，由模型自己改写。

### 1.2 sc-20「查一下现在黄金多少钱一克」：没有能返回数值的数据源

`search` 只返回标题/摘要，摘要里没有价格；模型随后 `read_url` 读了 `huilvbiao.com/gold`，但该页价格由
JavaScript 渲染，静态 HTML 里没有任何 `xxx.xx 元` 数字，所以它只能如实说「没有报价、不编」。**根因不是
模型不努力，而是现有工具链拿不到一个可验证的数值**。修复是新增一个固定数据源、只读的 `metal_price`，
而不是继续让模型从网页里「找数字」。

## 2. 查询词契约（sc-19）

### 2.1 提示词与工具描述

- `TOOL_DEFINITIONS.search` 的「输入」段改成：query 必须是关键词，不是用户原话；去掉
  「最近/有什么/帮我/听说/那个/我想知道」这类口语词，用「主题 + 时间」；并直接给两个正例
  「AI 行业新闻 2026年11月」「黄金价格 今日」和两个反例「最近有什么 AI 大新闻」
  「查一下现在黄金多少钱一克」。
- 系统提示新增 `2b1` 条：整句原样查询、或以口语词开头的长查询会被宿主以 `invalid-param` 退回，模型要
  自己改写后重试；宿主不会替它改写。原来的多动作/查询示例也同步改成关键词查询。

### 2.2 宿主确定性校验（不改写，只拒绝）

`keywordQueryIssue(query, utterance)`（`toolCalls.ts`）：

- 归一化：`toLowerCase()` 后去掉所有非字母/数字字符（`\p{L}` 保留中文），因此标点、空白、大小写不影响
  比较；
- 原始 query 去首尾空白后 **≤ 8 个字符**：直接放行。「天气」「金价」这类短词本来就是关键词，拒绝它们
  会误伤最普通的问法；
- 否则满足任一条件即 `invalid` + `invalid-param` issue：
  1. 归一化后与用户原话完全相同；
  2. 归一化后以 `最近 / 有什么 / 帮我 / 听说 / 那个 / 我想知道` 开头。
- hint 固定要求改写成「主题 + 时间」，并给「AI 行业新闻 2026年11月」「黄金价格 今日」两个正例；
- 返回 `kind: "invalid"`，pipeline 走既有的 `repairOnce`（一次模型修复轮），不是宿主重写后静默重查。

举例（单测锁定）：

| 用户原话 | query | 结果 |
| --- | --- | --- |
| 最近有什么 AI 大新闻？ | 最近有什么 AI 大新闻？ | 拒绝（整句原话） |
| 最近有什么 AI 大新闻 | 最近 AI 大新闻 | 拒绝（以「最近」开头的长查询） |
| 最近有什么 AI 大新闻 | AI 行业新闻 2026年11月 | 通过，原样执行 |
| 天气 | 天气 | 通过（≤8 字不误伤） |
| 最近有什么 AI 大新闻！ | 最近有什么AI大新闻 | 拒绝（去标点/空白/大小写后相同） |

## 3. `metal_price`：只读、可验证的金属价格（sc-20）

### 3.1 工具契约

```
metal_price(metal?: "gold" | "silver", unit?: "gram")
```

- 默认 `gold` + `gram`；`unit` 只接受 `gram`，`metal` 只接受 gold/silver，其余是 `invalid-param`；
- **只读**：不建卡、不写口播、不改画布；与 `weather/search/read_url` 一样必须单独调用，结果作为事实
  回灌**一次**，下一轮由模型用 `chat(reply=…)` 回答；
- **没有对应卡型**：价格不能用 `create_card(kind=weather/search_results/article)` 发布（没有价格卡），
  回灌轮里 `create_card(kind=answer)` 也会被拒绝——实时报价不能落成「稳定知识」卡。用户可以只回答，
  也可以在回灌轮里做同一句话里的其他事（例如记待办），但价格本身只回答；
- 工具描述写清何时用（金价/银价/多少钱一克/现在什么价）和何时不用（股票、基金、期货、纸黄金、汇率换算、
  国内金店饰品报价）；目录 `TOOL_CATALOG` 同步为 14 个工具，进度口播新增 `metal_price`。

### 3.2 数据源与折算公式

固定两个免 key 的 HTTPS JSON 源（模块内是常量，调用方不能传 URL）：

- `https://api.gold-api.com/price/XAU`（黄金）/ `.../XAG`（白银）→ 美元/盎司；
- `https://open.er-api.com/v6/latest/USD` → `rates.CNY`（美元兑人民币）。

```
人民币/克 = 美元/盎司 ÷ 31.1035 × 美元兑人民币
```

例：`4129.10 / 31.1035 × 7.1 ≈ 942.55 元/克`（实测源在 2026-11-05 附近返回
`4129.299805 USD/oz`、`USD/CNY 6.685421`，折算约 887 元/克）。

**这是国际金价折算，不是国内零售价**：国内金店/品牌有加工费、品牌溢价和税费，通常明显高于该折算值。
该说明是回灌事实的一部分（`metalPriceFactsText`），提示词也要求模型在回答里说出来，避免把折算价说成
「金店今天卖多少钱」。

### 3.3 降级与失败

两个源都成功才产生完整报价；任一失败逐级降级：

| 情况 | 结果 |
| --- | --- |
| 金价源 + 汇率源都成功 | 美元/盎司 + 人民币/克 + 汇率 + 更新时间 + 两个来源 |
| 金价源成功、汇率源失败 | 只给美元/盎司，明确写「汇率：不可用（美元兑人民币暂时取不到），无法折算人民币/克」，来源只列金价源 |
| 金价源失败（无论汇率） | `kind: "error"`，一句诚实说明「实时金价/银价和汇率都取不到…」，不建卡、不编价格 |
| 请求被取消 | 向上抛 abort，不伪装成数据源故障 |

### 3.4 缓存

- 内存 TTL + LRU（复用 `search/cache.ts` 的 `TtlLruCache`），每个金属一个键，**60 秒**有效期；
- 只缓存**完整**报价（两源都成功）；降级报价和失败都不缓存，下一次请求会重新尝试汇率/数据源；
- 缓存命中不重复请求上游；命中返回同一份 `updatedAt`/来源，不伪造刷新时间。

### 3.5 安全

- 只允许模块内的固定 `https://` 域名，调用方无法注入 URL；`redirect: "error"`，拒绝跨站跳转；
- 5 秒超时（与外部 signal 合并），响应体上限 64 KiB，按流读取并在超限时中止；
- `content-type` 必须是 `application/json`，JSON 字段用 zod 校验：价格是正数且 ≤ 1,000,000，
  汇率是正数且 ≤ 1,000，`result` 必须是 `"success"`；
- 上游原始 JSON 不进入提示词、不进入日志、不进入卡片；回灌给模型的是格式化后的数字、时间、来源 URL
  和溢价说明；
- 错误信息不透露上游 body、URL 细节或堆栈。

## 4. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  - 改动后：**8 failed / 2830 passed / 3 skipped（2841）**，5 个失败文件；
  - HEAD 基线（同一 worktree，改动前）：**8 failed / 2809 passed / 3 skipped（2820）**，5 个失败文件；
  - 失败用例名逐条比对：**差集 0**（`command-matrix` 的 todo、`deepseek` 无 key、
    `provider-main-transport` ×3、`stepfun-stream` timeout、`weekly-plan-grounding` ×2，均为既有失败）；
  - 新增的 21 个用例全部通过（`search-query-rewrite` 9、`metal-price` 12）；
  - 日志：`work/verify/search-rewrite-metal-20261105/baseline-head.log`、`after-final2.log`（未跟踪）。
- 定向：`search-query-rewrite` 9、`metal-price` 12、`query-tools-read-only` 14、`tool-calls` 194、
  `capability-inventory` 4、`prompt-prefix` 4、`tool-composite-lookup` 4、`tool-surface-accept60` 25、
  `pipeline-rules-and-adapters` 7、`tool-repair` 8，全部通过。
- 类型：`pnpm --filter @vivic/local-api typecheck`（`tsc -b`）只有既有 `tests/helpers.ts:8`
  （`modelApiBaseUrl` 可选性），无新增。
- Lint：`pnpm exec oxlint` 改动/新增的 13 个源码与测试文件，**0 warnings / 0 errors**。

## 5. 未验证 / 边界

- **真实模型行为**：单测锁定的是宿主契约（关键词拒绝、一次回灌、降级、缓存、不自动建卡）。真实模型在
  被退回后是否总能改写成合格关键词、是否真的用 `chat` 而不是硬建卡，需要下一轮线上跑批观察；本轮按约束
  没有跑 60/48。
- **Bing 分词效果**：本决策只保证「送进去的是关键词」，不保证 Bing/DDG 对任何关键词都返回预期结果；
  如果某个关键词仍被分词带偏，属于搜索路由的下一层问题。
- **国内金价**：`metal_price` 只给国际金价折算，不接国内金店/上金所报价，也没有溢价系数；回答里的
  「国内溢价」是定性说明，不是数字。
- **汇率源时效**：`open.er-api.com` 的更新频率由上游决定；60 秒缓存按本地取得时间计，不按上游
  `time_last_update_utc`，因此缓存内价格/汇率可能比现实滞后最多约一分钟。
- **白银**：`XAG` 走同一套契约，单测覆盖了降级路径，但没有对真实 `XAG` 端点做线上验证。
- **旧 planner 路径**：`VIVIC_TOOL_CALLS=off` 时没有 `metal_price` 工具面，仍是旧的文本/规则路径；
  本决策只覆盖工具面。
