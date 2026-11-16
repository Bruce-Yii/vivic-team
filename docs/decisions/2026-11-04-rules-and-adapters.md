# 规则层删除与适配器收口（2026-11-04）

- worktree：`work/backend-merge`（`codex/live-backend-20261103`），基线 `08ac4da`。
- 依据：`docs/decisions/2026-11-03-model-first-host-validates.md`、
  `docs/decisions/2026-11-04-single-decision-authority.md`（§7 未做项 1–5）、
  `docs/decisions/2026-11-04-composite-and-forecast.md`。
- 本轮边界：只改 `apps/local-api/src/intent/pipeline.ts`、`apps/local-api/src/data/*`
  与对应测试；不碰 `toolCalls.ts`（另一路并行修改）、不部署、不跑线上验收。
- 结论：**规则层不再替模型做"走哪条管线 / 问什么 / 拒绝谁"的决定**；工具面开启时，
  天气/数值/检索适配器只有模型的 `lookup` 工具一条入口。规则层剩下的只有
  "语义 + 格式都完全确定"的直出，且**任何多余的字都匹配不到，落到模型**。

## 1. 判据

保留一条规则快通道的条件（两条同时满足）：

1. **语义确定**：这句话是不是"倒计时/待办/便笺/提醒/显示全部/撤销"不依赖理解；
2. **格式确定**：同一句里已经给出全部参数，构造器是既有契约，不需要模型补值。

一条规则只要需要判断"接下来走哪条路""缺什么要问""这个请求要不要拒绝"，就已经越界：
它必须返回 `null`（落到模型），而不是自己回答。

## 2. 删除清单（8 条）

| # | 原行为（删掉的分支） | 现在 | 为什么删 |
|---|---|---|---|
| D1 | `wantsLiveFacts(req.text) && deps.search` 时，工具轮失败后宿主自动 `搜索 {整句}` | 删除该分支与 import。模型两轮都没给出可执行调用时，返回 `vendor-unavailable`（"模型这次没有给出可执行的动作…"），不再替模型选检索 | 关键词下限是"命中关键词就进检索管线"的最后一个实例；它绕过了模型对"要不要查、查什么"的决定，也把一次失败包装成另一次请求 |
| D2 | 规则命中 `cards.delete`/`card.delete` 且工具面开启 → `hostInterrupt("confirm", "删除/清空需要确认…")` | 删除该分支。工具面开启且有模型时，破坏性规则命中**不执行也不拒绝**，整句落到模型：`delete_card` 走任务管理器的冻结确认；工具面关闭的部署路径保持原样（规则删除） | 规则层既当执行者又当拒绝者；"删全部"这种表述工具面表达不了时，应该由模型决定怎么问，而不是宿主先拦住 |
| D3 | 适配器拒绝后按关键词决定"这个拒绝能不能当答复"：`adapterClarifyIsNotFinal(req.text)`，以及一个不可达的 `isMixedInstruction → safety` 分支 | 删除两段。有模型时适配器拒绝一律**落到模型/回传 issues**；没有模型时才 `vendor-unavailable` | "这句话是不是混合指令"是关键词判断，不是宿主事实；混合句现在能由工具层一次承载 lookup + 卡片，不再需要宿主否决模型选的能力 |
| D4 | 工具面开启时仍然先走 `runDecisionOn`：问候/自我介绍硬编码、`directOperation`（聚焦/高亮/打勾/删除/整理/显示全部）、13 处复合批次澄清、4B 本地分类 | 工具面开启时 `execute` 直接走既有规划路径，`runDecisionOn` 不再进入；`localDecisionIntent`（4B）也加了 `!deps.toolCalls` 门 | 工具面就是决策层；这些分支都是"关键词命中就自己执行/自己问"，和模型工具争同一句话的决策权 |
| D5 | 工具面开启时仍会进入 `runSlotPlanner`（槽位规划器会在 `slotNormalize` 校验失败时自己发问） | `slotPlanning` 在 `deps.toolCalls === true` 时为 `false`；工具轮之后落到普通规划器（仍是模型，两轮修复） | 工具面开启时槽位规划器是第二个规划器；它内部 `fail()` 的澄清无法与模型自己的 clarify 区分（`slotPlanner.ts` 不在本轮改动范围），不进入它就没有这条发问路径 |
| D6 | `adapterOnly` 下适配器返回 `error` / 检索空结果 → 直接作为整轮答复（`kind: "error"` / `"unknown"`） | 统一转成内部 `source: "adapter"` + `issues: string[]`；工具轮把它当校验失败走一次修复；修复后仍失败才 `vendor-unavailable` | 适配器失败是校验结果，不是答复；"如果上层还没接好，就返回 invalid + issues"——工具轮就是上层，`issues` 是适配器原话 |
| D7 | 槽位规划器内部 `lookup` 的适配器拒绝直接成为最终答复（`adapterClarify` 被当结果返回） | 管线检测到 `kind: "clarify" && source: "adapter"` 时，转成 `vendor-unavailable` 并带 `issues`；查询服务缺失同样返回 `issues` | 槽位规划器没有能力表可以重选（修复轮在 `slotPlanner.ts` 内部，不在本轮范围），但适配器的问句也不能冒充宿主的决定；至少把失败说清楚、把 issues 带出去 |
| D8 | `deps.decision`（4B 分类器）在任意模式都会先跑，命中就走 fit/focus/expand 等本地动作并可能自己问"请明确一张目标卡片" | 增加 `!deps.toolCalls` 门：工具面开启时不运行 | 同上：按关键词/分类分数决定"走哪条管线"的分支，在工具面开启时没有存在理由 |

> 附带结果：工具面开启时，`decision/on.ts` 里的问候/自我介绍硬编码也不再生效（模型用 `chat`
> 回答）。这是 D4 的直接后果，不是新增删除项。

## 3. 保留清单及理由

| 保留的规则 | 位置 | 为什么是"完全确定"的直出 | 匹配不到时 |
|---|---|---|---|
| `matchRules` 的固定短语（显示全部/适应画布、恢复原视图/退出聚焦、唤醒） | `intent/rules.ts` 经 `pipeline.ts` | 整句锚定的固定短语，动作就是 `canvas.fit`/`canvas.restore`/`stage.awaken` | 多一个字、否定、复合句都不匹配 → 模型 |
| `matchRules` 的字面建卡（待办、便笺、提醒、倒计时） | 同上 | 复用既有卡契约的**字面**解析：条目、正文、时长都在用户原话里，构造器不需要模型补值 | 解析器返回 `null` → 模型（如"每天背单词"没有日期） |
| `matchRules` 的"删除全部卡片" | 同上 | 整句固定短语 + 精确目标集合（当前画布全部卡片） | 工具面开启时见 D2，交模型；工具面关闭时才直出 |
| `fastHostOperation`（撤销/重做/整理画布） | `intent/operationsFast.ts` | 复用 `exactHostOperation` 的闭合表；否定词、复合句、长度超限直接不匹配 | `null` → 模型 |
| `planDeterministic`（编号清单/整周计划） | `intent/plans.ts` | 每个子句都由既有契约完整解析，整批构建、整批校验，不会部分提交 | `null` → 模型 |
| `scheduledReminderIntent` | `intent/scheduledReminders.ts` | 固定语法（每隔/每天/每周/当…完成）且时间、事项都在原话里；构建成功才直出 | 构建失败时：有模型交模型；没有模型才 `vendor-unavailable` |
| `chartFastPath` | `intent/chartFast.ts` | 用户点名图表类型并给出至少两个"名称+数值"，没有任何需要推断的值 | `null` → 模型 |
| `habitFastPath` | `intent/habitFast.ts` | 习惯名 + 本周具体星期都在原话里，固定形状 | `null` → 模型 |
| `parseTravelDemo` 旅游演示语法 | `scenes/travel.ts` | 闭合演示语法，目的地/类型/日期等全部来自原话，构建前先做 grounding 校验；失败落到模型 | `null` → 模型 |
| `locale`（"我在哪里"） | `data/deviceRegion.ts` | 设备位置/网络区划是宿主独有的数据，模型拿不到；答案是位置事实本身 | 解析器不命中 → 模型；适配器无结果 → `provider-unavailable` |
| 网页读取（`读取 https://…`） | `intent/article.ts` + `deps.search.fetchContent` | 用户给出字面 URL + 读取动词；工具面没有"读网页"工具，删掉入口等于删能力而非移决策 | 非 HTTPS/内网 → `policy`；抓取失败 → `error`（能力失败，非语义） |
| HTTP/内网链接拒绝 | `pipeline.ts` | 传输/隐私策略，与理解无关 | — |
| 截断画布不能按顺序/批量改 | `intent/contextSafety.ts` | 宿主是唯一知道"摘要只有 N/M 张"的一方；继续执行会写错卡（`safety`） | — |
| 破坏性工具提案的确认 | `pipeline.ts`（工具路径） | 不可逆操作必须用户点头；宿主只冻结提案（`confirm`） | — |
| 无模型时的离线参考/离线检索/`OFFLINE_MESSAGE` | `intent/offlineReference.ts`、`pipeline.ts` | 没有任何可回传的对象；必须有一句可见的话（`vendor-unavailable`） | — |

## 4. 适配器入口（工具面开启时）

| 能力 | 唯一入口 | 备注 |
|---|---|---|
| 天气（Open-Meteo，含明天） | 工具 `weather` → `runIntent(..., adapterOnly)` → `handleDataIntent` | 关键词预取由 `adapterPreemption = adapterOnly || !deps.toolCalls` 关掉；测试断言模型选 `chat` 时适配器 0 次调用 |
| 检索（webSearch/fetchContent） | 工具 `search` → `adapterOnly` | 同上；关键词 `searchQuery(req.text)` 只在 `!adapterPreemption` 时执行 |
| 数值/表格 | **没有 lookup 工具** | 工具面开启时不进入数值适配器；模型用 `create_chart` / `create_scene_card` 等工具出图/表格 |
| 网页读取 | 字面 URL（能力例外，见 §3） | 工具面无对应工具，保留为"用户已给全部参数"的能力入口 |
| 设备位置 | `parseLocaleIntent`（能力例外） | 模型无法获得设备位置 |

失败契约（工具面开启）：

```
adapter 返回 clarify/error/空结果
  → pipeline 返回 { kind: "clarify", source: "adapter", issues: [适配器原话] }
  → toolCalls 修复轮一次（issues 进提示词，不重复同一 (capability,args)）
  → 仍失败 → { kind: "clarify", source: "host", interrupt.reason: "vendor-unavailable", issues }
```

- 适配器实现（Open-Meteo、检索链、`data/*`）本轮**未改**；改的只是"谁能进来、失败怎么回传"。
- 槽位规划器内部 `lookup`（工具面关闭的 on 模式）：没有修复通道，失败转 `vendor-unavailable` + `issues`，
  不再把适配器的问句当答复（D7）。

## 5. `legacyFallback`

- 默认 `off`：只有 `VIVIC_LEGACY_FALLBACK=on`（或测试显式注入）才允许工具轮失败后回到旧规划器。
- 不是静默的：触发时写 `intentLog.path = "legacy"`，`intentPathOf` 输出 `legacy`；
  默认路径下工具轮失败直接 `vendor-unavailable`，旧规划器 0 次调用（新增测试断言）。
- 本轮不删这个开关（等旧规划器下线），但它不再是任何失败路径的默认行为。

## 6. 受改动范围限制的未做项

按本轮硬约束（只改 `pipeline.ts` / `data/*` / 测试），以下模块的**源码**未改，只通过管线入口处理：

1. `decision/on.ts` 的 13 处批次澄清、`intent/directOperations.ts` 的澄清：
   工具面开启时整段不可达（D4）；工具面关闭的 on 模式仍保留，需要在后续单独一轮改这两个文件。
2. `intent/slotPlanner.ts` + `intent/slotNormalize.ts` 的槽位澄清：
   工具面开启时不可达（D5）；工具面关闭的 on 模式仍是 P1，原因同上——
   其澄清与模型自己的 clarify 在现有返回值里无法区分，需要在 `slotPlanner.ts` 内给 `fail()` 打来源标签。
3. `VIVIC_LEGACY_FALLBACK` 分支删除：等旧规划器下线。
4. 网页读取入口：工具面没有对应工具，保留（见 §3）。

## 7. 新增测试

`apps/local-api/tests/pipeline-rules-and-adapters.test.ts`（8 条，全绿）：

1. "清空画布" 落到工具层（模型 clarify），不再有规则删除或宿主确认；
2. 实时事实句在模型选 `chat` 时，适配器 0 次调用（关键词不预取）；
3. "倒计时5分钟" 仍然 0 次模型调用直出（保留清单的回归锚点）；
4. `directOperation` 的句子（"聚焦会议记录"）在 on 模式 + 工具面下由模型 `focus_card` 执行；
5. 只有模型 `weather` 工具能打开 Open-Meteo：`handleDataIntent` 恰好 1 次、参数来自模型；
6. 适配器拒绝进 issues 并触发一次修复，适配器原话不出现在最终答复里；
7. 适配器 error 同样进 issues（不终局）；
8. 工具轮失败时默认不触发旧规划器（`generate` 0 次、`vendor-unavailable`）。

另改写 `tests/tool-surface-accept60.test.ts` 的 sc-19 下限用例：
从"模型没选检索时宿主自动搜索"改为"宿主不搜索、给一句诚实的 `vendor-unavailable`"，断言更严。

## 8. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  - 基线 HEAD `08ac4da`：**32 failed / 2956 passed / 3 skipped（2991）**，13 个文件失败；
  - 本轮：**32 failed / 2979 passed / 3 skipped（3014）**，失败集合与基线**差集 0**；
  - 日志：`work/verify/baseline-pipeline-tests.log`、`work/verify/after-pipeline-tests-2.log`；
    失败清单：`work/verify/baseline-failures.txt`、`work/verify/after-failures-2.txt`。
  - 注：首轮全量跑出过一次 `command-matrix` 的 2ms 计时容差抖动
    （`duration 1799997ms != 1800s`），单文件复跑与第二轮全量均通过，属既有测试的计时容差，不是行为变化。
- `npx tsc -b`（`apps/local-api`）：仅既有 2 个错误（`tests/accept60-regressions.test.ts:196`、`tests/helpers.ts:8`）。
- `npx oxlint` 改动文件（3 个）：0 warnings / 0 errors。
- 未跑：线上验收、真实模型服从度、部署；本轮只证明"删掉的路径不再拦截、适配器只能由模型工具触发"。

## 9. 提交

- `d2be181` 删除 `wantsLiveFacts` 下限
- `912b34b` 适配器拒绝/破坏性规则不再由关键词定夺
- `c865d86` 工具面开启时不进决策路由/槽位规划器/本地分类器
- `bd37315` 新增边界测试
