# 多候选必须问、复合句不许静默丢子句（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `1532bd5`。
- 范围：只改 `apps/local-api/src/intent/toolCalls.ts`、`tests/tool-calls.test.ts`、
  `tests/tool-surface-accept60.test.ts` 和本文档。不部署、不碰服务器、不推送、不重跑 60 条。
- 前情：2026-11-04 本地新版 60 条验收 55/60，5 条失败里 sc-56 / sc-59（`fail-clarify`）
  和 sc-60（`fail-cards+clarify`）是**主动行为变化**：
  - `聚焦待办` / `把待办传到用户页我要编辑` 在两张待办都能对上时，模型按规则 11
    "先按标题和条目判断哪张最像"直接选了 `todo_week`；旧版会列候选再问。
  - `查一下明天上海天气，要是下雨就提醒我带伞` 只建了天气卡，条件提醒子句被静默丢掉，
    口播"已显示上海明天天气"里没有任何说明。
  - 其余 2 条（sc-07、sc-49）是模型抽样/契约收紧，不在本次范围。

## 1. 规则 11：多候选必须 `clarify(missing="target")`，不许猜

`buildToolSystemPrompt` 的规则 11 从"先按标题和条目判断哪张最像，真的分不出来再 clarify"
改成**默认必须问**：

> 多候选不许猜：原话能对上多张卡或多个条目时，只有下面这些唯一证据才能直接执行——
> ①用户用"它/这张/刚才那张"指代，且摘要里有 [当前聚焦]/[最近聚焦]；②原话里有明确的
> 标题或别名；③只命中一张卡的唯一条目；④方位词（最左/最右/最上/最下/第一张/最后一张）
> 能唯一确定的那一张；⑤该卡型在画布上唯一。没有任何唯一证据时，必须调用
> `clarify(missing="target")`，按画布摘要把候选（卡名和条目）逐个写进 `question`；
> 宿主也会用 `targetCandidates` 补齐，不许自己挑一张。

配套把 `view`（focus/highlight）、`update_card`、`delete_card`、`clarify` 的"何时用 /
何时绝对不用我"改成同一口径（多候选 → clarify，不许猜；`missing=target` 时用宿主给的
`targetCandidates` 列候选）。`create_card` 的"推不出来才 clarify"不涉及卡目标，未动。

### 宿主只给事实，不替模型选

模型主动调用 `clarify(missing="target")` 时，`planFromToolCalls` 现在会：

- 用 `resolveEntryTarget`（条目歧义，如"买牛奶"同时出现在两张待办）或
  `resolveTarget(..., "focus")`（说了卡型/「X卡」且确实有多张）**派生真实候选**；
- 把候选写进 `targetCandidates`（id 只给模型，`question` 里只用卡名/条目名）；
- 如果模型自己的问句里已经点了候选名，不再重复追加，否则按 `1. 本周待办 2. 购物清单`
  的既有编号格式补上。

**不改**"照模型执行"：模型给了一个存在的 `card_id` 时宿主仍直接执行、不按原话换卡
（规则 4b 与 `tool-surface-accept60.test.ts` 的
"sc-56 uses the card the model chose instead of asking among them" 保持不变）。
宿主只在模型**选择提问**时补候选，不把模型的动作变成问题。

## 2. 规则 12b：复合句里不能执行的子句必须说出来

新增规则 12b：

> 一句话里有多个子句时，每个子句都要有结果——能做的做，做不到/不适用的必须在回复里明确
> 说明，或者整体 clarify；不许静默丢弃，也不许假装完成。条件句（如果/要是/假如/倘若…就…）
> 目前做不到"满足条件才提醒/才执行"：遇到这种子句就整体 `clarify(missing="other")` 说明
> 条件提醒暂时做不了，不要只把另一半做掉还什么都不说。

### 宿主校验（一次修复轮，不代写内容）

`planFromToolCalls` 在工具批处理结束后加了一条**形状校验**：

- 触发条件：原话里有可执行的条件子句（`如果/要是/假如/倘若/若是/万一 … 就/则/便`，
  且子句里出现提醒/通知/加/建/删/聚焦/倒计时等动作词），本次批处理只产生了 ≤1 张卡、
  没有宿主操作、也没有任何 `subtitle.show`（即 `unsupported` 的说明）；
- 命中后返回 `kind: "invalid"` + 一条 `code: "unsupported"` 的 `issues`，交给 pipeline
  **既有的**一次修复轮（`repairable` 已包含 `invalid`）。issue 里写明"不能只执行其余子句"，
  要求模型要么整体 `clarify`、要么保留要执行的子句并加 `unsupported(reply="…")`；
- 宿主只提供一句**兜底**（"这句话里的条件「…」暂时做不了，我先没有执行"），不写卡片内容、
  不写解释文案；修复轮仍不改就用这句诚实结束，绝不静默执行半句；
- 已经产出两个及以上动作、或模型已经用 `unsupported` 说明过的批次不触发（它不是"只做一个
  动作且不说"的形状）；"记个便签：如果下雨就提醒我带伞"这类**把条件原文记进卡里**的请求
  也不触发——子句在卡片的 `displayProps` 里逐字出现，说明它是被记录而不是被丢掉。
  `clarify` 是整句决定，走原有早退路径。

只覆盖**条件子句**这一种宿主能确定"做不到"的形状；其它类型的子句依赖规则 12b 由模型说明。
这是有意的窄口径：宿主不判断语义，只识别"这句话有一部分注定执行不了，却什么都没说"。

## 3. 验证

- 新增 `tool-calls.test.ts`：多候选目标问题带两个真实候选（条目歧义 + 只说卡型）、
  没有真实候选时保持原问句；条件子句只出天气时 `invalid` + issue 指名子句、补了
  `unsupported` 后通过、无条件的两动作句不误伤、把条件原文记进便签的请求不误伤。
- 新增 `tool-surface-accept60.test.ts`：假 provider 下 sc-60 首轮只出天气 → 触发一次修复轮
  （修复提示含被丢子句与"静默"），模型补说明后最终口播包含"条件提醒暂时做不了"；
  模型重复半句时以诚实问句结束，不出卡、不静默。
- 针对性测试：`tool-calls`、`tool-surface-accept60`、`relative-dates`、`tool-repair`、
  `pipeline-rules-and-adapters`、`find-cards`、`clarification` 共 273 条全过（新增 9 条）。
- 全量 `pnpm --filter @vivic/local-api test`（vitest run）：**2615 条，8 failed / 3 skipped**；
  与 HEAD `1532bd5` 的 2606 条、8 failed / 3 skipped **失败集合逐条一致（差集 0）**。
  这 8 条是基线就存在的环境/既有问题（command-matrix 假阳性、deepseek/provider 存储、
  stepfun 流超时、weekly plan grounding）。
- `tsc -b`：只剩既有的 `tests/helpers.ts(8,23)` 类型错误（该文件未改动）。
- 基线快照：`work/test-runs/baseline.json` / `baseline-failures.json`，改后
  `work/test-runs/after-final4.json`。

## 4. 没做 / 边界

- 不重跑 60 条（本地或线上）、不部署、不推送；验收侧结论留给下一次跑批复核。
- 模型仍可能无视提示直接选一张：宿主按既定契约**照模型执行**，不在这条改（用户明确要求）。
  规则 11 提高的是"该问"的指令强度，不是宿主的强制拦截。
- 条件子句的检测是窄口径（条件词 + 动作词 + 单动作形状）；"假装完成"（例如真的建了一张
  普通倒计时卡冒充条件提醒）没有被宿主拦截，只由规则 12b 约束。
- sc-07 / sc-49 的契约变化不在本轮；判分口径的 route N/A 修正在
  `work/local-acceptance/judge-fix.md`（评测脚本不在本 worktree）。
