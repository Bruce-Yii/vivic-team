# 单一决策权：模型决定，宿主推导/校验/执行（2026-11-04）

- worktree：`work/backend-merge`（`codex/live-backend-20261103`），基线 `7918e99`，本轮提交在 `7918e99` 之上。
- 依据：`docs/research/agent-framework-tool-layer-20261103.md`；
  上一轮 `docs/decisions/2026-11-03-model-first-host-validates.md`；
  本轮审计 `docs/audits/2026-11-04-decision-points.md`（43 个决策点逐条判定）。
- 不做：不部署、不发布、不碰服务器、不跑线上验收（60/48 条一条都没跑）、不改 `apps/web` 与
  `packages/contracts` 的语义。

## 1. 原则（本轮落成代码结构的三条）

1. **决策权只在模型。** 宿主只有三种合法动作：确定性**推导**（日期、地名、布局、设备位置）、
   **校验**（allow / deny+原因）、**执行**。宿主不得替模型选能力、选卡、改参数、或自行澄清。
2. **澄清不是规则层的职责。** 规则快通道只做"语义 + 格式都完全确定"的直出；一旦它需要"决定接下来走哪条路"
   或"决定问什么"，就已经越界。澄清的唯一出口是模型的 `clarify` 工具。
3. **任何失败都必须结构化回传。** 参数错、目标找不到、工具选错、适配器无结果 → `invalid` + `issues`
   （适配器/校验器自己的原话），走既有修复轮（工具层 1 次、规划器 2 次尝试）。不许空响应、不许无声降级、
   不许把失败包装成"请换一种说法"式的死路——除非修复预算真的用完了（那是 `vendor-unavailable`）。

## 2. 结构：把边界做成类型，而不是约定

新增 `apps/local-api/src/decision/authority.ts`：

```ts
export const HOST_INTERRUPT_REASONS = ["confirm", "safety", "policy", "vendor-unavailable"] as const;
hostInterrupt(reason, message, extra?)   // 宿主唯一合法的"说话"方式
modelClarify(message, extra?)            // 模型自己决定的追问
adapterClarify(message, extra?)          // 适配器的拒绝（内部标记，永远不直接到用户）
decisionAuthorityIssue(result)           // null = 合规；否则说明违规
```

- `IntentResult` 增加 `source: "model" | "host" | "adapter"` 与 `interrupt: { reason }`；
  `IntentResponseSchema` 同步（对前端是可选字段，向后兼容）。
- `VIVIC_AUTHORITY_STRICT=on` 时 `runIntent` 在出口做硬校验：出现没有 `interrupt.reason` 的
  `clarify` 直接抛错（CI/预发用；默认不开，避免线上行为突变）。
- 四种理由都是**非语义**的，`HOST_INTERRUPT_WHY` 里逐条写下"为什么这不是在替模型做判断"。

## 3. 审计结论

逐点清单见 `docs/audits/2026-11-04-decision-points.md`。摘要：

| 层 | 点数 | 越权 | 其中本轮改 | 保留例外 |
|---|---|---|---|---|
| 规则层（rules/plans/fast/direct/on） | 11 | 6 | 1 | 5 |
| 适配器（data/*、search、travel、locale） | 11 | 6 | 5 | 1（`wantsLiveFacts` 下限） |
| 宿主目标解析（target/aliases/deleteTarget/hostTarget） | 9 | 2 | 0 | 2（决策模式路径） |
| 规划与工具循环（pipeline） | 13 | 8 | 7 | 1（`legacyFallback`） |
| 默认值/参数改写 | 7 | 2 | 0 | 2（P1） |
| **合计** | **51** | **24** | **13** | **11** |

"越权 → 改"的 13 处里，2 处是整段删除（关键词门、旅游追问），1 组是流程改写（终局澄清 → 修复轮），
其余是"打上正确的标签，让它可以被检查"。剩下 11 处例外逐条列在审计文档 §7。

## 4. 改了哪些

### 4.1 适配器不再抢跑（`pipeline.ts`）

```ts
const adapterPreemption = adapterOnly || !deps.toolCalls;
```

- `adapterOnly` = 模型自己选了 `weather` / `search` 之后的重新进入；
- `!deps.toolCalls` = 没有工具面的降级路径（旧规划器/离线），那里没有"能力列表"可让模型选。

工具面开启时，天气/数值/检索适配器**只能**由模型的工具调用触发；`pipeline.ts` 里那道
`searchQuery(req.text)` 关键词预取也被同一道门挡住（`!adapterPreemption`）。

### 4.2 适配器的拒绝不再是答复

- 工具面：`pipeline.ts:416-438` —— 适配器说不懂时，**不返回**，句子继续交给模型；
  只有"混合/破坏性句子"保留适配器的拒绝（`safety`：部分执行风险）。
- 无工具面：只有 `adapterClarifyIsNotFinal()` 认的句子交给模型，其余 `vendor-unavailable`；
  没有模型时也是 `vendor-unavailable`（能力边界，不是语义判断）。
- 模型选了 `lookup` 但适配器无法解析（`pipeline.ts:596-629`）：适配器原话作为 `issues` 回给模型 +
  1 次修复轮；同一 `(capability, args)` 指纹**不重复执行**（防死循环）；仍失败 → `vendor-unavailable`。

### 4.3 规则层与工具层不再自己澄清

| 原行为 | 现在 |
|---|---|
| `scheduledReminders` 精确语法但缺字段 → 终局澄清 | 能建卡就直出；有模型就交模型；无模型才 `vendor-unavailable` |
| 旅游 demo 构建失败 → "请补充旅游查询条件" | 交给模型（整段删除） |
| `hostOperationIssue` 校验失败 → 立刻问用户 | `issue` + 既有修复轮 |
| 场景卡 `ask` 直接成为答复 | 先进 `issue`；两轮都失败才 `vendor-unavailable` |
| 句子里有"然后/同时/；/不要"就拒绝模型的 `lookup` | 整段删除——多要求由模型自己拆 |
| `adapterOnly` 兜底"请明确要查询的城市" | 内部 `adapterClarify` → 工具路径转 `invalid`+issues |

### 4.4 sc-47：复合操作必须说出来

`toolCalls.ts` 新增 `actionSay` / `hostOperationSay` / `confirmationOf`：一次提交里被执行的效果
（建卡、聚焦、高亮、`canvas.fit`、`canvas.arrange`、暂停/继续、移动/固定/传送…）都会出现在
`spokenText` 里，按执行顺序串成一句，且只描述宿主**真的做了**的事。

- `显示全部 + 整理布局` → `spokenText: "已显示全部卡片，已整理布局"`（此前为空）。
- 只做一个宿主操作（如"整理布局"）→ `host-operation` 也带 `message: "已整理布局"`，不再"做了不说"。

### 4.5 结构性保护

`apps/local-api/tests/decision-authority.test.ts`（43 条）：

1. **静态**：12 个规则层模块不允许出现 `kind: "clarify"`，也不允许引入 `authority.ts`；
2. **静态快照**：除 `pipeline.ts`/`authority.ts` 外，只有 13 个"内部构造者"可以造 `clarify`，
   清单写死在测试里——**只能缩，不能悄悄长**；
3. **静态**：`data/**`、`search/**` 不得 value-import 或调用 `runIntent`（适配器不能决定一轮）；
4. **静态**：`pipeline.ts` 必须保留 `adapterPreemption` 那两道门（删掉就红）；
5. **运行时**：`VIVIC_AUTHORITY_STRICT=on` 跑一组句子，任何未打标的宿主追问都会抛错；
6. **运行时**：工具面开启时，天气句子**不会**在模型之前碰到 `handleDataIntent`，
   只会以模型规范化的 `"南京天气"` 调用一次；
7. **运行时**：sc-47 的 composite / host-operation 话术。

## 5. 保留的例外及理由

只保留"非语义"中断，逐条写在审计文档 §7。摘要：

| 例外 | reason | 为什么不是语义判断 |
|---|---|---|
| 截断画布不能按顺序/批量改（`contextSafety`） | `safety` | 宿主是唯一知道"摘要只有 64/N 张"的一方；继续执行会写错卡 |
| 复合批次合并失败整批拒绝（`decision/on.ts`） | `safety` | 一次提交要么全成要么不提交，部分执行是产品级破坏 |
| 删除/清空确认（规则路径 + 工具路径） | `confirm` | 不可逆操作必须用户点头；宿主只冻结提案 |
| HTTP/内网链接拒绝 | `policy` | 传输与隐私策略，与理解无关 |
| 没有模型 / 模型两轮无计划 / 修复预算耗尽 / 适配器在无工具面下无法解析 | `vendor-unavailable` | 没有可回传的对象，或预算已用完；但必须有一句可见的话 |

**明确不接受**的例外：规则层"信息不全"、适配器"没听懂"、宿主"目标不唯一所以先问"——
这些现在都必须回传给模型。

## 6. 验证

- `npx vitest run`（`apps/local-api`，全量）：
  - HEAD `7918e99` 基线：**32 failed / 2943 passed / 3 skipped（2978）**，13 个文件失败；
  - 本轮：**32 failed / 2986 passed / 3 skipped（3021）**，同样 13 个文件失败；
  - `Compare-Object` 逐条比对失败集合：**差集 0**（清单 `work/audit/baseline-failures.txt`、
    `work/audit/final-failures.txt`，全量日志 `work/audit/baseline-tests.log`、`work/audit/final-tests.log`）。
  - 新增 43 条全绿（`tests/decision-authority.test.ts`）；改写 1 条既有断言
    （`tests/tool-surface-accept60.test.ts` 的 sc-18：从"适配器被调用过"改为"适配器不该先说话"，
    断言更严，不是放宽）。
- `npx tsc -b`（`apps/local-api`）：仅既有 2 个错误（`tests/accept60-regressions.test.ts:196`、
  `tests/helpers.ts:8`），无新增。
- `npx oxlint` 改动文件（6 个）：**0 warnings / 0 errors**。

## 7. 未做项

> 2026-11-04 第二轮：下列 1–3 项已按用户决定**整块删除**（不是改成回传），见
> `docs/decisions/2026-11-04-remove-alternate-decision-paths.md`。第 4 项按用户要求只保留开关、默认 off。

1. `decision/on.ts` 的 13 处批次澄清（P1，需要重做 hybrid 合并协议）。
2. `intent/slotPlanner.ts` + `intent/slotNormalize.ts` 的槽位/扩展卡澄清（P1）。
3. `decision/intent.ts`、`intent/directOperations.ts` 的本地决策/直连入口澄清（P1）。
4. `VIVIC_LEGACY_FALLBACK` 分支删除（P1，等旧规划器下线）。
5. `wantsLiveFacts` 确定性下限改为"能力不可用的可见提示"（P1）。
6. `normalizeSceneData` 的 `rating` 降级（P1，等前端支持小数评分）。
7. 旧规划器的 `lookup` 失败只能打标 `vendor-unavailable`（P2，旧规划器没有能力表可重选）。
8. 把"画布被截断（64/N）"写进工具系统提示词，让模型自己决定要不要问（P2，`contextSafety` 的根治）。
9. 线上验收（60/48 条）与真实模型服从度：按约束未跑；本轮只能证明"模型选错时宿主不会让它成为答复"。
