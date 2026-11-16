# 工具面补齐契约 + 目标解析接回工具路径（2026-11-03）

本轮依据 `work/verify/findings/accept60-failures-20261103.md` 的十条失败根因，只做 4 组改动：

- **C 工具面缺出口**（sc-13 / sc-33 / sc-45 三条真回归 + sc-25 的不稳定回归）；
- **D 目标解析没进工具路径**（sc-30 / sc-56 两条真回归）；
- **B 规则层两道确定性门**（sc-16 / sc-18，旧版就有）；
- **E 遥测路径误标**（sc-21 被记成 `rules-fast`）。

不部署、不改服务器、不碰 `apps/web`。契约层（`packages/contracts`）一行未改：`answer` 契约、
`card.highlight.itemId`、`card.update` 早就在，缺的只是工具面的出口。

## 1. `answer`：知识问答必须落卡（sc-13、sc-45）

- 新工具 `answer(title?, text, points?)`，参数映射到 `cards/answer.ts` 的 `AnswerSlotsSchema`
  （`title→headline`、`text→summary`、`points→keyPoints`），宿主调用 `CARD_CONTRACTS.answer.build`
  产出 **NewsCard**，不手写 CardRecord。`title` 缺省时由正文首句截断成 headline（只截断模型给的字，不编造）。
- 参数上限按工具轮的 512 token 预算收紧（正文 ≤240 字、要点 ≤5×60 字、标题 ≤40 字）：语音优先的产品里
  一张回答卡就该是 1-3 句；超长会被 zod 拒绝并进修复轮，而不是被 `max_tokens` 截断成半张卡。
- `chat` 的语义收窄为“纯闲聊/寒暄/感谢/情绪表达”，描述里明确知识问答走 `answer`。
- `chat` 不再与其它工具互斥：混批时它不贡献 action、也不否决同句里的建卡（sc-45 需要
  `answer + create_todo` 一次返回 NewsCard + TodoCard）。`clarify` 仍然独占——它是对整句的裁决，
  不能和任何工具同批。

## 2. `create_todo` 的 `card_id` = 追加（sc-33）

- `card_id` 指画布上已有的 TodoCard 时走 **`card.update`**：只带 `items`，宿主把新条目接在原有条目后面，
  原有条目的 `id`/`text`/`done` 原样保留，新条目 id 继续 `item-N` 且避开已用 id；不新建卡。
- 合并后的 `displayProps` 用 `TodoCardSchema.shape.displayProps` 复核（最多 30 条、每条 ≤160 字）；
  超限即 `invalid`，进修复轮，不静默丢条目。
- `card_id` 不在画布 / 不是 TodoCard → `invalid`（带 id），让修复轮改参数，不猜。
- 句子本身点名了**唯一**一张待办卡且带追加动词（“购物清单里加上酱油”“把酱油加到购物清单”）
  时，宿主即使没收到 `card_id` 也按追加处理：既有的 `uniqueCanvasMatch` 已经能证明只有一个指代对象，
  不去新建一张只含新增条目的卡。
  这一条**优先于**模型给的 `card_id`：句子点名 购物清单、模型却填了 本周待办 时，宿主按购物清单追加
  （模型挑错卡是 sc-33 的原始失败模式）；只有句子没点名时才回落到模型 id 做存在性校验。

## 3. `unsupported`：做不到就说做不到（sc-25）

- 新工具 `unsupported(reply?)`，产出 **只含 `subtitle.show` 的 envelope**（0 卡、无动作、无 hostOperation），
  不落便笺、不说“记下了/已完成”。`reply` 缺省用一句固定的诚实话术。
- 与建卡工具同批时两边都保留（“打个电话，顺便记个待办”）：字幕说做不到，待办照建。
- `create_note` 描述补了否定句：用户要求系统做不到的事时不要用便笺顶替。

## 4. `highlight_card` 的 `item_id`（sc-30 的第二层）

- `highlight_card` 增加可选 `item_id`，产出 `{type:"card.highlight", targetId, itemId}`（契约早已支持）。
- 校验：`item_id` 必须是该卡 `items` 里的条目；条目级高亮只对 TodoCard 开放（与
  `cards/views.ts:targetAction` 的执行端约束一致）。不在卡上 → `invalid`，并列出可用条目。
- 模型把条目**文本**填进 `item_id` 时按文本归一成条目 id，不因此失败。

## 5. 画布摘要带条目与条目 id（sc-30 的第一层）

`buildToolSystemPrompt` 的卡片行在几何信息之后追加 `条目：交周报(item-1)/买牛奶(item-2)/预约牙医(item-3)`
（最多 3 条、总长 72 字截断）。此前模型只看到卡名「本周待办」「购物清单」，无法把「买牛奶」对到
其中一张；现在条目文本与 `item_id` 同时在摘要里，标题行仍保持原有前缀格式。

## 6. targeted 工具不再直接信模型的 `card_id`（sc-30、sc-56）

`toolCalls.ts` 新增 `hostTarget(utterance, ctx, route)`，`focus_card` / `highlight_card` / `edit_card` /
`arrange_card` / `delete_card` 都先过一遍：

1. **条目文本命中**（`decision/target.ts` 新增 `resolveEntryTarget`）：最长条目名获胜，“买牛奶”压过更短的
   “牛奶”；唯一卡 → 用宿主的 `targetId`（+`itemId`）；多张卡各有同名条目 → 候选澄清。
2. 原话里没有任何卡片指代（`hasExplicitCardReference` 为 false）→ 保留模型的 id（后续仍校验存在性）。
3. 否则用 `resolveTarget(text, ctx, route)` 复核：唯一命中 → 覆盖模型 id；`ambiguous` → 带编号的候选澄清
   （`missing:"target"`）；`missing` → `invalid`（`画布上没有能对上这句话的卡片`）。
4. `resolveTarget` 返回“整画布候选”（等于它也没主意）时不用它，退回模型的 id：把 24 张卡都列给用户
   比模型的一个 id 更糟。

候选澄清是**决策**而不是校验失败：不带 issues，所以不会触发工具修复轮（修复轮只会让模型再猜一次 id）。
候选只显示卡名（sc-56 期望「本周待办 / 购物清单」），不显示内部 id。

删除确认门不变：工具路径仍然只产出 `card.delete` 提案，`toolCallsInTask` 之外的删除仍由宿主的冻结确认拦住；
纯指示代词（“删了它”）仍先走 `deicticDeletion`。

## 7. 删掉规则层两道健身门（sc-16）

`intent/pipeline.ts` 的 `:296-300` 与 `:359-363` 两处 `gateFitness` 删除。理由：`下周的健身计划` 已自带
周锚点，练哪几天是计划内容（`scenes/build.ts:74-84` 的既有契约），而 `plans.ts:parseWeeklyPlan` 本来就能
确定性地建这张周计划卡——门却在它之前用 79 ms 把句子截成澄清。

**保留** `toolCalls.ts` 里 `create_weekly_plan` 的同款判断：那是模型已经选了工具之后的参数校验
（问“哪几天、每次多久”而不是替用户编），`tests/tool-calls.test.ts` 已锁定该行为。若要一并删除，
需要产品先裁决“裸健身计划”是否必须先问。

## 8. 解耦 `slotPlanning`（sc-18）

`pipeline.ts:404` 的放行条件从 `deps.slotPlanning && …needsNumericSlotExtraction` 改为只看
`!adapterOnly && dataResult.kind === "clarify" && needsNumericSlotExtraction(req.text)`。
“句子里有数字但不符合表格语法 → 交给模型填 grounded slots”本来就与 4B 是否在线无关；关掉分类器
不该让数据适配器的澄清变成终局答复。

## 9. 遥测：真实模型轮次不再记成 `rules-fast`（sc-21）

- `pipeline.ts` 的 `generate()`（所有主模型/planner 调用都从这里过）在 sink 尚未有 path 时写入
  `intentLog.path = "planner"`；`tool-repair` / `legacy` 等已写过的标记不覆盖。
- `intentPathOf` 在 `toolCalls` 判定之后、provider 判定之前识别这个标记。于是
  “planner → lookup → 数据适配器澄清”的回合（最终结果没有 provider 标签）被计为 `planner`。
- 纯规则回合（`显示全部` 等）不经过 `generate`，仍是 `rules-fast`；单测两侧都锁了。

## 未修 / 已知边界

- **sc-21 本体**（南京同名地点择优）属数据层 `data/weather.ts`，本轮不动：按既有身份策略澄清，
  需要产品先定是否按 feature_code/人口择优。
- **sc-47**（显示全部+整理布局缺首句）是话术问题，不在本轮 C/D 范围。
- **sc-18 判分口径**（`expected_card_types` 用集合全等）仍需评测侧加 `card_any_of`。
- `tests/wire-json-schema.test.ts` 的 `card-record.schema.json` 与 Zod 源不一致是 **HEAD `ceb1a42`
  之前就存在**的失败（本地 pre-fix 全量同样 33 failed），本轮未改生成物。
- 工具层仍可能把 `unsupported` 用成 `chat`（模型行为），提示词已把两者分开；真实模型的效果要等复跑验收。

## 验证

- `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：**33 failed / 2924 passed / 3 skipped（2960）**。
  改动前同一 worktree 是 33 failed / 2886 passed（2922）；**失败集合完全一致**（`work/verify/logs/` 里
  的 pre-fix / after 失败清单逐条对齐），新增 38 条断言全部通过。与
  `work/verify/logs/baseline-failures.txt`（32 条）相比，多出的唯一一条是本 worktree 在 HEAD 就有的
  `wire-json-schema` 生成物不一致。
- `pnpm --filter @vivic/local-api typecheck`：仅既有 2 个错误（`tests/accept60-regressions.test.ts:196`、
  `tests/helpers.ts:8`），无新增。
- `npx oxlint` 改动文件：0 warnings / 0 errors。
- 新增/改写覆盖：`tests/tool-surface-accept60.test.ts`（11 条，pipeline 级）、`tests/tool-calls.test.ts`
  （`answer` / 追加 / `unsupported` / `item_id` / 目标歧义 / 摘要条目 / 提示词规则，共 27 条，另按新契约改写 2 条既有断言）。

### 五条真回归的单测覆盖

| 用例 | 现在锁在哪 |
|---|---|
| sc-13 | `tool-surface-accept60`「turns a knowledge question into a NewsCard」 + `tool-calls`「answer … NewsCard」 |
| sc-30 | `tool-surface-accept60`「highlights 买牛奶 in 本周待办 even when the model picked 购物清单」 + `tool-calls` 条目级高亮 5 条 + 摘要条目断言 |
| sc-33 | `tool-surface-accept60`「appends 酱油 to 购物清单」 + `tool-calls` 追加 7 条 |
| sc-45 | `tool-surface-accept60`「returns the answer card and the todo in one envelope」 + `tool-calls`「answers and creates … in one batch」 |
| sc-56 | `tool-surface-accept60`「asks among 本周待办 / 购物清单」 + `tool-calls` 编号候选断言 |
