# 歧义只拒绝猜测；卡片传送到用户页/展示页（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `97e77aa`。
- 范围：只改 `apps/local-api/src/decision/target.ts`、`apps/local-api/src/intent/toolCalls.ts`、
  `tests/tool-calls.test.ts`、`tests/tool-surface-accept60.test.ts` 和本文档。
  不部署、不碰服务器、不跑 60/48、不推送。
- 前情（本地 60 条复跑）：`聚焦待办`（画布两张待办）与 `把待办传到用户页我要编辑`
  判分期望是“列候选澄清”，模型却按规则 11 的口头约束直接挑了 `todo_week` → 判分失败。
  同时 `传到用户页/展示页` 根本没有工具入口，模型只能说做不到。

用户原则：**模型是决策者，宿主只做校验**。原话本身指向多张卡、又没有任何唯一证据时，
模型挑的那张就是“猜”，宿主应当拒绝并回传候选，让**模型**去澄清——宿主不替它选。

本文件补充（不改写）`2026-11-04-host-recalls-model-decides.md`（宿主不覆盖模型 id）与
`2026-11-04-clarify-multi-target-and-compound-clauses.md`（规则 11 只提高“该问”的指令强度）。
两者的“宿主不裁决”不变；新增的只是“宿主不执行一个原话无法支撑的猜测”。

## 1. 歧义校验：只拒绝猜测，不裁决

`cardFor(modelId, …)` 在“模型 id 在画布上、类型也符合”之后、**返回成功之前**加一道校验。
命中拒绝时走既有 `targetFailure`：`kind: "invalid"` + `code: "ambiguous-target"` +
`targetCandidates`（真实候选，≤5）+ 一句编号兜底问句，交给 pipeline 已有的**一次修复轮**。

### 放行条件（任一即放行，`uniqueTargetEvidence`）

| # | 证据 | 判定 |
|---|---|---|
| ① | 原话里有该卡 id | 去空白、忽略大小写后 `原话.includes(模型 id)` |
| ② | 原话含唯一标题/别名 | `namesCard`（标题+别名+译名组）命中**恰好 1 张** |
| ③ | 原话含唯一条目 | `resolveEntryTarget` 返回 `targetId`（不是 `ambiguous`） |
| ④ | 指代 + 有焦点 | 原话含「这张/那张/它/刚才」，且 `focusHistory` 末尾的 id 真在画布上 |
| ⑤ | 序号 | 原话含「第N张/第N条/第N项/第N个/第N行」——用户按编号点了名 |
| ⑥ | 方位词 | 「最左/最右/最上/最下/最后一张」且 `spatialTarget` 能唯一分离出一张（两张叠在一起时不给证据） |

⑤ 是实跑暴露后补的：`find_cards` 回灌后模型常调用 `arrange/view(card_id=…)` 而原话是
「聚焦第31张表格」，31 张表格让卡型匹配变成 31 个候选——这不是猜，是用户数过号。
交给 `find_cards` 的既有流程（`tests/find-cards.test.ts` 两条用例钉住）。

### 拒绝条件

同时满足才拒绝：

1. 模型给了**存在**的 `card_id`（类型也符合该工具）；
2. 上面六条证据一条都没有；
3. 原话**正面点名** ≥2 张卡（`namedCards`：标题/别名命中、条目命中、或卡型词命中）。

拒绝时 `issues[0]` 的 message 列出 `标题(id)`，hint 固定为
“原话能对上多张，请 clarify(missing="target") 并列出候选，不要自己挑一张；宿主会把真实候选写进 targetCandidates”。

### 保持现状（**不拒绝**）

- 原话对不上任何卡（“只有指代但没有焦点”，如 `把它往左移` 而 `focusHistory` 为空）——
  `namedCards` 为空，绝不把“剩下的所有卡”当成候选；
- 模型没给 `card_id`（走原有 `useEntry` / `missing-param` 分支）；
- 原话点名恰好 1 张卡（证据②）——即使模型选的是**另一张**，也照模型执行：
  **证据只用来放行，不用来换卡**。这是与上一轮一致的原则，本次没有加“唯一命中就覆盖”。

### 为什么用 `namedCards` 而不是 `resolveTarget`

`resolveTarget` 在“什么都对不上”时会回退成 `ambiguous: […所有卡…]`。若直接用它做判断，
空原话、纯参数句（“把标题改成周末清单”）都会被判成多候选，等于把既有行为全部推翻。
`namedCards` 只统计**正面命中**的卡，`length >= 2` 才是“原话真的指向多张”。

## 2. 传送到用户页 / 展示页：`arrange(target, surface?)`

契约里 `card.surface {targetId, surface: "user"|"display"}` 早已存在（`packages/contracts`、
`apps/web/src/ai/hostOperation.ts`、`mobile-console` 都在用），缺的只是工具入口。

选定设计：**`position` 与 `surface` 是同一个槽位的两种动作，二选一**。

```
arrange(target: 卡 id | "canvas", position?: pin|unpin|left|right|up|down, surface?: user|display)
```

| 调用 | 结果 |
|---|---|
| `{target: 卡id, surface: "display"}` | HostOperation `card.surface`（surface=display） |
| `{target: 卡id, surface: "user"}` | HostOperation `card.surface`（surface=user） |
| `{target: 卡id, position: "pin"}` | `card.pin`（既有） |
| `{target: 卡id, position: "up"}` | `card.move`（既有） |
| `{target: "canvas"}` | `canvas.arrange`（既有） |
| `{target: 卡id, position + surface}` | `invalid-param`：position 与 surface 不能同时填 |
| `{target: "canvas", surface}` | `invalid-param`：传送只对单张卡有效 |
| `{target: 卡id}`（两个都没给） | `missing-param`：要 position 还是 surface |

- 复用既有 HostOperation，不新增协议；`routes` 仍是 `arrange`（`ROUTES.arrange` 本来就写着
  “或把卡片传送到用户页/展示页”）；口播用既有的 `hostOperationSay`：`已送到展示页` / `已切到用户页`。
- 传送目标同样走 `cardFor` → 因此“把待办传到用户页”（两张待办）会得到
  `ambiguous-target` + 两个候选，而不是把某一张传过去。
- 同一批仍只允许一个宿主操作（`一次只能执行一个宿主操作`）。

同步更新：

- `ARRANGE_DESCRIPTION` 五段式重写（做什么/输入/何时用/何时绝对不用我/返回 都写了 surface，
  并写明“传送不是聚焦，不要用 view 顶替”）；
- `TOOL_DEFINITIONS.arrange.parameters` 增加 `surface`（enum user/display）；
- `TOOL_CATALOG.arrange.actions` 增加 `surface:user`、`surface:display`；
- 进度口播 `TOOL_FEEDBACK_PHRASES.arrange` 从“我来整理布局”改为“我来调整一下”
  （一次调用既可能是整理画布/移动，也可能是传送，单一标签不能说错）；
- 系统提示：工具清单行改为 `arrange 排布局/传送卡片`；规则 4b 写明“唯一的例外是猜”
  （原话能对上两张以上又没有唯一证据时宿主会把候选退回并要求 clarify）；规则 11 写明
  这不是建议而是宿主会校验的契约，并把序号加进证据列表；多动作示例新增
  `「把这张卡传到展示页」→ arrange(target=…, surface="display")`。

## 3. 验证

- 针对性：`tests/tool-calls.test.ts` **182 passed**（新增 16 条）、
  `tests/tool-surface-accept60.test.ts` **24 passed**、`tests/find-cards.test.ts` **17 passed**。
- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  **2669 条 / 8 failed / 3 skipped**；基线 `97e77aa` 是 **2651 条 / 8 failed / 3 skipped**。
  失败清单逐条对比**差集 0**（`work/baseline-head-97e77aa.log` vs
  `work/after-ambiguous-surface2.log`）：command-matrix 假阳性、deepseek 凭据、
  provider-main-transport ×3、stepfun 流超时、weekly-plan-grounding ×2，全部既有。
- `pnpm --filter @vivic/local-api typecheck`：只剩既有 `tests/helpers.ts(8,23)`。
- `pnpm exec oxlint` 四个改动文件：0 warnings / 0 errors。

改写的既有用例（都是本次裁决的直接对立面）：

- `tests/tool-calls.test.ts`「does not ask which card when the model already picked one (sc-56)」
  → 「refuses to execute a pick the sentence cannot back (sc-56)」：断言 `invalid` +
  `ambiguous-target` + 两个候选 + 编号问句不含 id。
- `tests/tool-surface-accept60.test.ts`「sc-56 uses the card the model chose instead of asking
  among them」→「sc-56 refuses a guess between two 待办 and hands the candidates back」：
  断言修复轮得到 `ambiguous-target`，最终是宿主兜底的编号问句（两轮模型调用、不出卡）。

## 4. 行为边界与风险

1. **卡型词是宽口径**。`namedCards` 复用 `decision/target.ts` 的 `types` 表，其中
   `/计划|安排/` 覆盖面最大：一句带“安排”的话（如“把购物清单安排到用户页”）在画布上
   ≥2 张日程卡时会被判成多候选。代价是一次修复轮 + 一句 clarify，不会写错卡；
   但这是本层最容易误伤的一条，若实跑出现，先把该 type 词从“正面命中”里去掉。
2. **只校验“模型给了存在的 id”**。`create_card(kind=todo, card_id=…)`（追加条目）不在
   `cardFor` 路径上，本次未加校验——它已有自己的“回传清单候选”流程，且任务口径只列了
   `view`/`update_card`/`delete_card`/`arrange`。两条路径口径不完全一致，是已知的缝。
3. **方位词只认 `spatialTarget` 能分离的**。两张卡坐标叠在一起时“最左那张”不构成证据，
   这时宿主不拒绝也不裁决（回退到“原话没点名”，照模型执行）——即“叠在一起”这个边界
   仍未强制 clarify，只由规则 11 约束模型。
4. **歧义校验不看工具类型**。原话对上 2 张便笺、模型却对一张待办做 `update_card`，也会被
   判 `ambiguous-target`（因为“原话撑不起这个选择”）。语义上更严格，可能比预期多问一次。
5. **传送只到两个页面**。`surface` 是 enum，没有“传送到设置页/手机”；手机侧
   （`contrib/mobile-console`）的 `card.surface` 权限与投影逻辑未改，仍由既有 connector 负责。
6. 没做的：不重跑 60/48、不部署、不推送；模型仍可能无视提示挑一张，此时宿主按上述规则
   退回一次；修复轮仍挑同一张时，用户看到的是宿主兜底的编号问句，不会执行错误目标。
