# 标题型待办清单 + 复合句子句覆盖（2026-11-05）

> 后续（同日）：本文关于 sc-52 的期望「整句澄清、零卡」已被
> [动作 + 追问同批、事实/建议分域、天气兜底](2026-11-05-action-plus-clarify-grounding-scope-weather-fallback.md)
> 取代为产品变化（允许「便签 + 追问」）。本文其余结论（标题型待办、子句覆盖校验）仍然有效。

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `87c9439`。
- 范围：`apps/local-api/src/intent/toolCalls.ts`、新增 `apps/local-api/src/intent/clauseCoverage.ts`、
  `apps/local-api/src/intent/pipeline.ts`（只加一个"查询已执行"标记）、`apps/local-api/src/cards/todo.ts`、
  `packages/contracts/src/cardRecord.ts`（`TodoCard` 契约）、再生成的
  `Vivic_Kimi_Handoff_v0.6/contracts/card-record.schema.json`、
  新测试 `tests/todo-empty-list.test.ts`、`tests/clause-coverage.test.ts`、
  `tests/tool-repair.test.ts`（一条既有断言的例子换成 `countdown`）、本文档。
- 边界：没有部署、没有碰服务器、没有跑线上 60/48 验收；没有新增卡型、没有改前端。

## 1. 两个断点（本地 60 条验收）

| 场景 | 原话 | 期望 | 实际 |
| --- | --- | --- | --- |
| sc-07 | 新建一个任务清单，准备搬家 | 一张标题型 TodoCard（可空条目） | 模型反问"想先记哪几件事"，零卡 |
| sc-52 | 帮我记个便签明天交周报，然后设一个倒计时 | 整句澄清（问时长），零卡 | 只建了 NoteCard，倒计时子句静默丢弃 |

根因都是同一个方向的错误——**工具面/校验把"用户说了什么"读成了"模型缺什么"**：

- `create_card(kind="todo")` 的 `items` 是必填非空（`min(1)`，两层：工具参数 `TodoArgs` 与卡契约
  `TodoCardSchema.displayProps.items`）。"建清单"没有条目就无卡可建，模型只能问。
- "复合句丢子句"校验只覆盖条件句（`如果/要是…就…`）。普通复合句里某个子句因为缺参数做不出来时，
  宿主既没有校验也没有回传，模型就安安静静地只做另一半。

## 2. 契约一：待办清单可以只有标题

`create_card(kind="todo", fields)` 的字段：

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `title?` | string 1–80 | 清单标题 |
| `items?` | 1–30 条 × 1–160 字 | 条目 |
| `card_id?` | string 1–128 | 追加到已有 TodoCard（此时 `items` 必填） |

- `title` 与 `items` **至少给一个**：都没有 → `invalid-param`（`待办清单缺内容：title（清单标题）与 items
  （条目）至少给一个`），不建卡。这是**参数错误**，不是追问用户的理由。
- 有 `title` 无 `items` → 建一张 `items: []` 的标题型 TodoCard。仍然只经过 `cards/todo.ts` 的
  `todoContract.build`：工具层不手写 `CardRecord`，`TodoSlotsSchema` 在 builder 里再校验一次，
  `createCardActions` 负责 id/布局/时间戳。
- `items: []` 仍然被拒（`待办条目不能为空…`），避免"空数组"变成"静默空卡"的旁门。
- 追加路径不变：`card_id` + `items` 还是 `card.update`，保留原条目与原标题；`card_id` + 只有 title
  没有条目 → `invalid-param`（没有东西可加）。
- 条目路径不变：`items` 只有条目时行为、id 生成、31 条上限、逐条 160 字上限都没动。

契约层同步（`packages/contracts/src/cardRecord.ts`）：

```ts
displayProps: z.strictObject({ title?, items: z.array(TodoItemSchema).max(30) })
  .refine(v => v.title !== undefined || v.items.length > 0, "TodoCard needs a title or at least one item")
```

- `minItems: 1` 从 JSON Schema 里消失，标题/条目二选一由 refine 表达（与 `NoteCardSchema` 的
  `text`/`sections` 同一套写法）。`Vivic_Kimi_Handoff_v0.6/contracts/*.json` 用 `pnpm contracts:generate`
  重新生成，`tests/wire-json-schema.test.ts` 因此仍然绿。
- 前端不需要改：`TodoCardView` 对 `items: []` 本就渲染"标题 + 空列表 + 加条目输入"。

工具描述与系统提示同步（`CREATE_KIND_LINES` 的 `kind=todo` 行、`CREATE_CARD_DESCRIPTION` 的"返回"、
系统提示"回答、追加与条目"新增一条）：

- 用户说"新建清单/建个待办"而没给条目 → 直接用 `title` 建标题型清单，**不要追问条目**；
- 用户明确在加条目（"加个待办：买牛奶"）→ 走 `items`；
- 系统提示里的反例是 sc-07 原文，正例是 `create_card(kind="todo", fields={"title":"搬家清单"})`。

## 3. 契约二：复合句每个子句都要有结果

新增 `apps/local-api/src/intent/clauseCoverage.ts`（纯函数，无 I/O），在 `planFromToolCallsDraft`
的批量校验阶段接进既有的一次修复轮：

```
子句有动作词但没有结果 → issues: [{ code: "dropped-clause", hint: "这个子句没有执行也没有说明：…；补齐参数后重试，确实缺信息用 clarify(missing=…)" }]
                         → kind: "invalid"（actions/created 均为空）→ pipeline 既有 repairOnce
```

### 3.1 切句

复用 `decision/split.ts` 的切句语义，但不复用它（它对 tool 层有两个副作用：条件句整句保留、
不按"然后/顺便"分句）：

| 规则 | 例子 |
| --- | --- |
| 句末标点 `。！？!?；;` 与换行一定切 | `记个便签。设个倒计时。` → 2 |
| 承接词切开：`然后/接着/随后/顺便/另外/同时/并且`（带不带逗号都算） | `…交周报，然后设一个倒计时` → 2 |
| `，再` 切；光秃秃的 `再` 不切 | `记个便签，再设个倒计时` → 2；`显示全部再整理` → 1 |
| 条件句整句不切 | `查一下明天上海天气，要是下雨就提醒我带伞` → 1（交给既有条件句校验） |
| 逐句去掉首部礼貌词/承接词 | `顺便加个待办跟进` → `加个待办跟进` |

切句只是"候选"，真正决定要不要报错的是下面的需求识别。

### 3.2 一个子句"在要什么"（`clauseDemandOf`）

按优先级判定，命中即止；都不命中就是**没有诉求**的子句（寒暄、修饰、纯内容），永远不报错：

| 判定 | 命中条件 | 结果要求 |
| --- | --- | --- |
| `op` | 子句以操作动词开头（打开/聚焦/高亮/显示/固定/移动/传送/删除/撤销/重做/整理/恢复…），或 `把/将…` + 操作动词（放回/固定/标成/改成/删除…） | 批次里有任一 view/卡片更新/删除/固定/移动/传送动作，或宿主操作 |
| `lookup` | 子句前 12 字里有 `查/搜/检索/天气/气温/预报/冷不冷/带伞/新闻…` | 本批有查询（search/weather/read_url/find_cards），或落了检索/天气卡 |
| `record` | 子句以 `记/写/记录/记下/整理成/做成/转成` 开头 | 本批有任何一张卡/查询/宿主操作（"记"只要求记录，卡型由模型定） |
| `countdown`/`todo`/`note`/`schedule`/`chart`/`notification`/`habit` | 子句里出现卡名词，且名词前是创建动词（`设一个倒计时` `加个待办` `新建一个任务清单`）或"名词：…"形式 | 本批建了对应卡型的卡（`todo` 也接受 `card.update` 追加） |
| `reminder` | `提醒我…` / `设个提醒…` | 倒计时、日程或通知三选一 |
| `record`（兜底） | 子句以创建动词开头但没点卡型（`加个提醒`） | 本批有任何结果 |

两条降噪规则很关键：

- **"提到卡"不等于"要建卡"**：`我不记得是哪张清单`、`参加明天的会议`、`购物清单里的牛奶已买`
  都只是目标或陈述，不是诉求。所以卡名词必须被创建动词"引出来"（`设一个` + `倒计时`），
  且弱动词（加/做/来/搞/弄）还要求量词（`加个待办` 算，`参加` 不算）。
- **`记`不是卡型**：`记一下明天的会议安排` 是记录（任何卡都算），不是日程；`记`/`写` 只走 `record`。

### 3.3 什么时候不判（误伤边界）

- **条件句整句不判**：`如果/要是/假如/倘若/若是/万一` → 归既有 `droppedConditionalClause`
  （它的结论是"宿主做不了满足条件才执行"，与"这个子句没做"是两个判断）。
- **模型已经明说了就不判**：批次里有 `unsupported`（`subtitle.show`）说明模型自己解释了这一段。
- **纯查询批次不判**：一批里没有任何 action/卡/宿主操作时，那是查询回合，宿主还要把结果回灌一轮
  （`find_cards`/`search`/`weather`/`read_url`），子句是"待办"而不是"丢了"。
- **查询已执行的回合不判**：pipeline 在把查询结果回灌给模型的那一轮打上 `lookupSatisfied`
  （`read_url` / `find_cards` / 混合查询的 repair 三条路径），查询子句算已执行。
- **逐字记录的子句不重复要求**：子句原文（或去掉引导动词后的核心）出现在已建卡的
  `displayProps` 里 → 这段被记下来了，不算丢（`记一下：买牛奶，然后设个倒计时` 记进一张便签就是结果）。
- **没有诉求的子句不报错**：`谢谢`、`哈哈好的`、`明天也要交`、`顺便`、`另外` 都是 `undefined`。

### 3.4 报错之后

宿主**不代写解释、不代补内容**：`dropped-clause` 只是一条 issue，走既有的一次修复轮。模型要么
补齐参数重做（sc-52 补上时长 → 两张卡），要么自己 `clarify(missing=…)` 问整句（sc-52 问时长 →
零卡）。修复轮仍失败时，用户看到的还是这条 issue 的原文（既有 `vendor-unavailable` 路径），
而不是"换一种说法"。

## 4. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  - 改动前（`87c9439`）：`Test Files 5 failed | 120 passed | 2 skipped (127)`，`Tests 8 failed | 2734 passed | 3 skipped (2745)`；
  - 改动后：`Test Files 5 failed | 122 passed | 2 skipped (129)`，`Tests 8 failed | 2780 passed | 3 skipped (2791)`；
  - **失败集合逐条一致（Compare-Object 差集为空）**，新增 46 条测试（`clause-coverage` 35 + `todo-empty-list` 11）。
    8 条既有失败：`command-matrix`(todo)、`deepseek`、`provider-main-transport`×3、`stepfun-stream`、`weekly-plan-grounding`×2。
- `pnpm typecheck`：只剩既有 `apps/local-api/tests/helpers.ts(8,23)` 一条（与本轮无关）。
- `oxlint` 改动文件：0 warnings / 0 errors。
- 未跑：线上 60/48 验收、真实模型联调、`apps/web` 测试与构建（本轮未改前端；`TodoCardSchema`
  只放宽 `minItems`，`TodoCardView` 对空条目本就渲染标题 + 加条目入口）。

## 5. 已知取舍

- 切句与需求识别是**保守**的启发式：宁可漏报（不判）也不误伤（把陈述当诉求）。已知不覆盖：
  一个子句里并列两个不同卡型（`记个便签并设个倒计时` 不切）、纯 `再` 连接的复合句、以及
  子句里 `把…` + 非操作动词的内容型请求。
- `TodoCardSchema` 从"条目至少一条"变为"标题或条目至少一个"：外部写入一张既无标题又无条目的
  `TodoCard` 仍然被拒；只有标题的卡是新增的合法形状，前端按空列表渲染。
