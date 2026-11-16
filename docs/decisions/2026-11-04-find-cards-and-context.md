# find_cards、截断提示与"缺参回传模型"（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `8f86d5c`。
- 范围：只改 `apps/local-api/src/intent/toolCalls.ts`、`apps/local-api/src/intent/pipeline.ts`、
  对应测试和本文档。不部署、不碰服务器、不跑线上验收（60/48 一条都没跑）。
- 前情：工具面开启后，模型只看到 `buildToolSystemPrompt` 里的摘要（最多 24 张，外加最多 3 张
  "最近聚焦"补位）；画布上下文本身由宿主按 聚焦/固定/最近更新 取前 64 张（`apps/web` 与
  `hostedCanvasContext` 都是 64），`totalCardCount` 才表示画布真实总数。目标一旦落在摘要之外，
  模型只能靠名字/别名/焦点"猜"，而宿主又会在失败后替它问用户——这是"宿主替模型做决定"的一大来源。

## 1. `find_cards`：把检索权交给模型

### 1.1 工具契约

```jsonc
{
  "name": "find_cards",
  "parameters": {
    "query": "可选，标题/正文/条目的字面包含匹配，忽略大小写与全半角",
    "type":  "可选，卡型（TodoCard/NoteCard/ChartCard…）",
    "limit": "可选，1–20，默认 20"
  }
}
```

描述按五段式写（做什么 / 输入 / 何时用 / 何时绝对不用我 / 返回），显式要求：

- 摘要写了"画布共 N 张卡，这里只列出最近的 M 张"、目标不在列表里时，**先单独**调用它；
- 它只返回结果，不建卡、不改卡；
- 不能和其他工具同批（结果下一轮才到），也不能在同一批里重复查同样条件；
- 无匹配时返回"没找到 + 画布卡型统计"，由模型决定换词、换类型还是 `clarify(missing=target)`。

`TOOL_CATALOG` 同步新增 `find_cards`（`capability: "overview"`，非直接执行、非破坏性），
`TOOL_FEEDBACK_PHRASES` 增加"我来找一下那张卡"，进度线不再落到"我正在处理"。

### 1.2 检索规则（`findCardsOnCanvas`，纯函数，无 I/O）

- 只读 `ctx.cards`，不碰 `sourceData`（摘要字段不能变成检索侧信道）；
- 匹配面：`title/headline/text/summary/body/note/caption/description`、`items/keyPoints/points`
  里的文字、以及 `aliases`；`query` 与文本都做 `NFKC + lowercase + 去空白`，全半角/大小写不敏感；
- `type` 只做卡型过滤，**不当作 id**；
- 单次最多 20 条（参数 `limit` 越界时按 1–20 夹取），超出的部分在结果里报告"匹配 M 张，只返回前 K 张"；
- 命中的条目前置：返回每条卡的 `entries`（带 `item-*` id）与 `matchedEntries`，标题按摘要同样规则截断；
- 无命中时返回 `scanned`（实际检索了多少张）、`total`（`totalCardCount ?? cards.length`，且不小于
  `scanned`）与按数量排序的 `byType` 卡型统计。

### 1.3 执行与回灌（`pipeline.ts`）

- `planFromToolCalls` 只把 `find_cards` 解释成 `lookup: { kind: "cards", … }`，不产生任何 action；
  和其它工具同批直接 `invalid`，让它单独走一轮。
- `pipeline` 直接对 `req.canvasContext` 调用 `findCardsOnCanvas`，把结果格式化成**工具结果**：
  `id / type / 标题 / 位置(@x,y WxH [固定]) / 条目(text(item-id))`；命中条目前置，最多 6 条，
  其余写"…还有 N 条"。
- 结果通过一次 follow-up 模型轮回灌（复用 `tool-lookup` 路径与 `intentLog.repairs = 1`）：
  提示词明确"结果来自画布，不是用户新说的话；用上面的 id 完成请求；不要再调用 `find_cards`
  （检索只回灌这一次）；找不到就 clarify 或如实说明"。
- **最多回灌 1 次**：回灌后如果模型又给 `find_cards`，宿主不再执行，直接以
  `vendor-unavailable` 诚实结束（同一语料重复读不会产生不同答案）。
- 这个 follow-up 是工具的"执行协议"，不是校验修复，所以 `VIVIC_TOOL_REPAIR=off` 也不影响检索回灌。

## 2. 把"截断"告诉模型

`buildToolSystemPrompt` 在 `totalCards > cards.length` 时明确写一行：

> 画布共 N 张卡，这里只列出最近的 M 张；要操作不在列表里的卡，先用 find_cards 查，不要猜 id。

同时新增规则 4c 与一条 few-shot（"不记得目标在哪张卡 → 先 find_cards 再执行"），
把"先查再执行、不要猜 id、不能同批"写成模型可执行的顺序。所有卡都在摘要里时不出现这行。

## 3. R08 的截断硬澄清：降级，但保留真正的 safety

原来 `incompleteCanvasIssue`（`contextSafety.ts`）在任何模型调用之前就可能以
"当前只读取了部分画布……"终局澄清。现在：

- **工具面开启**：`pipeline.ts` 不再用截断作为终局依据。画布截断是模型可以自己消除的不确定性
  （`find_cards` 检索同一份 `canvasContext`），目标是否可信由模型决定；
- **真正的 safety 保留在工具层**：模型给了一个画布上不存在的 id 且检索也找不到时，
  `cardFor`/`unknown-card` 会带着真实候选回传（修复轮），仍无法决定才由宿主说明；
- **工具面关闭（降级路径）**：旧的 `incompleteCanvasIssue` 行为不变，已有
  `tests/context-truncation.test.ts` 继续锁住。

注意：本轮没有放宽"可检索范围"——`ctx.cards` 仍是宿主按相关度取的前 64 张，
`find_cards` 只能检索这 64 张；`totalCardCount > 64` 时结果会如实写"已检索 64 张，画布共 100 张"。
要让模型检索整张画布需要改前端的上下文选择（`apps/web` / `hosted/tasks.ts`），不在本轮授权范围。

## 4. `need()`：缺参不再由宿主问用户

`toolCalls.ts` 里的 `need(message)` 过去返回 `kind: "clarify"`（宿主替模型问）。现在返回
`kind: "invalid"` + `issues`：

- `missing-param`：缺必填参数（`create_todo` 无 items、`edit_card` 无 title、`update_todo_item`
  缺条目、`find_cards` 之外的检索参数缺失等）；
- `invalid-param`：参数形状对但事实/取值不成立（场景 grounding 失败等）；
- 每条 issue 的 `hint` 统一为"补齐参数后重试；确实缺信息用 clarify(missing=...) 明确问"；
- 走既有修复轮（`repairable` 已包含 `kind === "invalid"`）：模型补齐后重试，或自己决定
  `clarify(missing=…)`；修复轮也用尽才由宿主给出工具自己的原因或通用说明。
- 同一轮把 `search` / `weather` 的参数解析失败也从"宿主直接追问"改成 `invalid` + issue
  （行为一致：宿主不代问）。`travel_offers` 的场景卡请求改为 `unsupported` issue（能力边界，不建假卡）。

## 5. 验证

- 新增 `apps/local-api/tests/find-cards.test.ts`（17 条）：文字/标题/条目、全半角与大小写、
  `type` 过滤、`limit` 与截断、无结果 + 卡型统计、只读不建卡、禁止同批、端到端
  "检索 → 改卡 / 追加 / 再建一张卡 / 模型自己 clarify"、重复 `find_cards` 只回灌一次、
  摘要外 id 不再触发 R08、降级路径仍保留 R08。
- `tool-calls.test.ts`：工具面 27 个（`find_cards` 在 `weather` 之后）、五段式描述、
  缺参断言改为 `invalid` + `missing-param` + hint；`relative-dates.test.ts` 的 grounding 断言同步。
- `tool-repair.test.ts`：新增"缺必填参数回传模型、不出现宿主 clarify、恰好一次修复轮"。
- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  `13 failed | 117 passed | 2 skipped`（132 个文件）、`32 failed | 3026 passed | 3 skipped`
  （3061 条）。与基线 `8f86d5c` 的失败集合逐条比对，**差集为空**（基线 32 failed / 3008 passed，
  本轮新增 18 条测试全部通过）。首轮重跑时 `intent-progress.test.ts` 有一条 5 秒超时：
  该用例在基线里已是 4209ms 的临界值、单跑 2624ms 通过，且完全不经过工具面（默认
  `toolCalls` off），属并行负载抖动，复跑即回到基线集合。
  `typecheck` 仍只有既有的 2 个错误（`tests/helpers.ts`、`tests/accept60-regressions.test.ts`），
  `oxlint` 改动文件 0。

## 6. 没做 / 下一步

- 不部署、不推送、不跑线上 60/48 验收。
- 检索范围仍受 64 张上下文窗口限制（见 §3）；要覆盖"整张画布"需前端/宿主层改动。
- `find_cards` 是只读检索，不提供"批量/按序号"语义；真正的批量操作与在画布上直接编辑仍是边界外。
- `VIVIC_TOOL_REPAIR=off` 时缺参仍会退化为通用说明（不回到旧的宿主追问），这是有意的取舍。
