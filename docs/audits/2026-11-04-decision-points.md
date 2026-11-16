# 决策点审计：谁在替模型做决定（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`，审计基线 `7918e99`）
- 范围：`apps/local-api/src/`（宿主侧）。不含 `apps/web`、`packages/contracts`、部署与线上验收。
- 依据：`docs/research/agent-framework-tool-layer-20261103.md`（P0/P1/P2）、
  `docs/decisions/2026-11-03-model-first-host-validates.md`（上一轮结论）。
- 结论落点：`docs/decisions/2026-11-04-single-decision-authority.md`；
  结构性保护：`apps/local-api/src/decision/authority.ts` + `apps/local-api/tests/decision-authority.test.ts`。

## 0. 判定标准

宿主只允许做三件事，其余都算越权：

| 允许 | 含义 | 例子 |
|---|---|---|
| **推导** | 从用户原话/画布/设备算出确定事实，不改写模型给的语义 | 相对日期→ISO、别名→候选、布局→"最左那张"、`本次请求现在` |
| **校验** | 对模型的提案给出 allow / deny+原因（deny 必须回到模型） | 契约 schema、目标不存在、值不在原话里、能力互斥 |
| **执行** | 把已通过校验的提案落成动作/宿主操作 | 建卡、聚焦、移动、撤销 |

| 越权 | 含义 |
|---|---|
| **选** | 宿主决定"用哪个能力/哪张卡/要不要问" |
| **改** | 宿主静默改写模型给的参数 |
| **问** | 宿主用一句用户可见的追问代替"把问题回给模型"（除安全/确认/供应商不可用） |

判定"越权澄清"只有三个非语义例外可以保留，且必须带 `interrupt.reason`：
`confirm`（破坏性确认）、`safety`（数据完整性/部分执行）、`policy`（传输与隐私策略）、
`vendor-unavailable`（上游拿不出可用结果）。模型自己 `clarify` 标 `source: "model"`。

---

## 1. 规则层（`intent/rules|plans|chartFast|habitFast|operationsFast`）

| # | 位置 | HEAD 行为 | 判定 | 处理 |
|---|---|---|---|---|
| R01 | `intent/rules.ts:matchRules` | 整句闭合语法（显示全部/恢复视图/唤醒/建待办/建便签/精确提醒/精确倒计时/清空画布）直出 envelope；对不上返回 `null` | 允许（执行） | 保留。已由静态检查锁死"不产生 clarify" |
| R02 | `intent/operationsFast.ts` | 整句撤销/重做/整理画布 → `host-operation` | 允许（执行） | 保留 |
| R03 | `intent/plans.ts:planDeterministic` | 编号清单/周计划的确定性构建；不能完整构建返回 `null` | 允许（执行） | 保留 |
| R04 | `intent/chartFast.ts` | 句子里已含全部数据点的图表语法直出 | 允许（执行） | 保留 |
| R05 | `intent/habitFast.ts` | 固定形状的打卡记录（习惯 + 本周哪几天）直出 | 允许（执行） | 保留 |
| R06 | 原 `intent/directOperations.ts:43/99/136/137` | 直接契约解析失败 → `clarify("这次操作没有通过校验，请换一种说法。")` 等 4 处 | **越权（问）** | **已删除**：整个 `directOperations.ts` 只被 `decision/on.ts` 引用，随 on/shadow 路径一起删除（`2026-11-04-remove-alternate-decision-paths.md`） |
| R07 | `intent/scheduledReminders.ts`（9 条 `message`）+ `pipeline.ts:330-339` | 精确命中提醒语法但字段缺失/非法 → 规则层终局澄清（"请一次设置一项计划提醒…"） | **越权（选/问）** | **已改**：能完整建卡直出；建不出且**有模型**则交模型（该句可能是别的东西）；**无模型**才 `vendor-unavailable` |
| R08 | `intent/contextSafety.ts:incompleteCanvasIssue` + `pipeline.ts:299-303` | 画布摘要被截断（>64 张）且句子"改动既有卡" → 终局澄清"请先聚焦目标卡片" | **越权（选）但底层是数据完整性** | **保留**（`safety`）：宿主是唯一知道"摘要不全"的一方，继续执行会写错卡；但它是靠关键词判定 `actsOnExisting`，属已知妥协，P1 应改为"执行前校验失败→回传" |
| R09 | 原 `intent/slotNormalize.ts:91-147` | 槽位归一失败 → `{ clarify: "倒计时需要具体时长…" }` | **越权（问）** | **已删除**：`slotNormalize.ts` 随槽位规划器整块删除 |
| R10 | 原 `intent/slotPlanner.ts:198/207/252/546/627` | 扩展卡未安装、参数过大、规划失败 → 宿主澄清 | **越权（问）** | **已删除**：`slotPlanner.ts`（连同 `planCache.ts`、`promptCompact.ts`）与 `VIVIC_DECISION_POLICY` 一起删除 |
| R11 | 原 `decision/on.ts:144/150/192/199/204/376/401/406/444/454/469/499/507` | 复合批次无法按子句合并时整批拒绝并给一句澄清 | **越权（选）**：把"合并失败"变成用户问题 | **已删除**：整个 `decision/on.ts`（on/shadow 执行路径、hybrid 合并协议）删除；原子提交的确认闸门由任务管理器保留 |

## 2. 适配器（`data/*`、`intent/search.ts`、`scenes/travel.ts`、`scenes/index.ts`）

| # | 位置 | HEAD 行为 | 判定 | 处理 |
|---|---|---|---|---|
| A01 | `pipeline.ts:414-441`（`deps.data.handleDataIntent(req.text)`） | 天气/数值/表格关键词命中即进数据适配器，**在模型之前**；适配器的澄清直接成为答复 | **越权（选/问）** | **已改**：`adapterPreemption = adapterOnly \|\| !deps.toolCalls`，工具面开启时适配器只能由模型 `weather`/`search` 触发；适配器澄清在工具面下**不是终局**（混合/破坏性句子除外） |
| A02 | `pipeline.ts:442`（`searchQuery`） | 检索动词命中即联网并落卡 | **越权（选）** | **已改**：同一道门（`!adapterPreemption` 时才算） |
| A03 | `pipeline.ts:446`（`articleRequest`） | 句子里有显式 URL + 读取动词 → 读网页 | 允许（格式完全确定） | 保留 |
| A04 | `pipeline.ts:497`（`offlineSearchQuery`） | 没有模型时，信息型问句仍联网 | 允许（供应商不可用下的降级） | 保留 |
| A05 | `pipeline.ts:399-408`（`parseLocaleIntent` + locale 适配器） | "我在哪里"由设备定位直接回答；定位缺失 → 澄清 | 允许（推导）；失败 → `vendor-unavailable` | 已改（失败分支打标） |
| A06 | `pipeline.ts:381-393`（`parseTravelDemo`） | 旅游 demo 语法命中即建卡；构建失败 → 宿主追问"请补充旅游查询条件" | 直出允许；追问**越权（问）** | **已改**：构建失败不再追问，句子交给模型 |
| A07 | `data/numeric.ts`、`data/transform.ts`、`data/weather.ts`、`data/weatherInput.ts` | 适配器自带"请提供数据/请明确城市/找到多个同名地点"等 20 余条澄清 | **越权（问）**（当模型可用时） | **已改（工具面）**：`pipeline.ts:429-438`——有工具面 → 非终局；无工具面 → 只有 `adapterClarifyIsNotFinal` 认的句子才交给模型，其余 `vendor-unavailable`；无模型 → `vendor-unavailable`。适配器内部文案未动（它们是能力边界说明） |
| A08 | `pipeline.ts:416-438`（适配器拒绝 = 答复） | 适配器说"没听懂"时，用户只收到这一句，模型没有机会补救 | **越权（问）** | **已改**（见 A07）；工具面下改为"回传 invalid+issues → 修复轮" |
| A09 | `intent/toolCalls.ts:wantsLiveFacts` + `:591/834` | 实时事实句用 `answer`/`chat` → `invalid` + issues 要求改选 `search`/`weather` | 允许（校验：能力互斥） | 保留 |
| A10 | `pipeline.ts:661`（`wantsLiveFacts` 确定性下限） | 工具轮两轮都拿不出计划时，宿主按关键词直接走检索链 | **越权（选）**：关键词决定"这次要检索" | **保留（例外）**：它只在"模型已经失败"后触发，作用是避免"实时问答死路/凭记忆编造"；属 P1（应改为模型可见的"能力不可用"提示） |
| A11 | `intent/search.ts:searchQuery/offlineSearchQuery` | 纯函数：只做语法判断，无 I/O | 允许 | 保留 |

## 3. 宿主目标解析（`decision/target.ts`、`aliases.ts`、`deleteTarget.ts`、`intent/toolCalls.ts:hostTarget`）

| # | 位置 | HEAD 行为 | 判定 | 处理 |
|---|---|---|---|---|
| T01 | `target.ts:188-207`（标题/别名唯一命中） | 唯一命中 → 绑定 `targetId`，并覆盖模型给的 id | 允许（推导：用户自己的名字） | 保留（sc-15/sc-30 的修复点） |
| T02 | `target.ts:208/228/260`（多候选） | 工具路径 → `invalid` + issues（编号候选 + "用摘要里的 id 或 clarify"）；决策路径 → 宿主澄清 | 工具路径允许（校验）；决策路径**越权（问）** | **决策路径已删除**：`decision/intent.ts` 与 4B 目标分类调用删除；工具路径保留 |
| T03 | `target.ts:193/233/255-259`（找不到） | 工具路径 → `invalid`（画布上没有能对上的卡）；决策路径 → 澄清 | 允许（校验）/ 决策路径 **越权** | **决策路径已删除**：`resolveTarget` 只保留宿主推导，不再调用分类器；工具路径保留 |
| T04 | `decision/aliases.ts:matchKeysOf` | 别名只用于**召回**，把规范名一起给模型，不把"谷歌"改写成"Google"当成功 | 允许（推导） | 保留 |
| T05 | `target.ts:162-186 resolveEntryTarget` | 条目级指代（"买牛奶那条"）最长命中；两张卡都有 → 候选 | 允许（推导） | 保留 |
| T06 | `deleteTarget.ts:deicticDeletion` | 纯指针（"删了它"）按 focusHistory 解析；无焦点证据 → 确认或诚实拒绝 | 允许（推导 + 确认） | 保留 |
| T07 | `toolCalls.ts:405-409 appendTarget` | 句子点名唯一待办 + 追加动词 → 覆盖模型给的 `card_id` | 允许（唯一命中绑定），但**是参数覆盖** | 保留并记风险：模型给了另一张存在的卡时，宿主按用户原话改回；P1 可改为 invalid+issues |
| T08 | `target.ts:movementParts/resolveMovementReference` | "A 挪到 B 下面"：B 只作参照，不当作目标 | 允许（推导） | 保留 |
| T09 | `target.ts:spatialOf/spatialTarget` | 方向词按布局取卡；重叠堆叠 → 候选而不是猜 | 允许（推导） | 保留 |

## 4. 规划/工具循环（`intent/pipeline.ts`、`intent/toolCalls.ts`）

| # | 位置 | HEAD 行为 | 判定 | 处理 |
|---|---|---|---|---|
| P01 | 原 `pipeline.ts:776` | 模型选了 `lookup`，但句子里有"然后/同时/；/不要"→ 宿主用关键词判定"这是多要求"并终局澄清 | **越权（选）** | **已删**：模型选了就执行，多要求由模型自己拆 |
| P02 | 原 `pipeline.ts:768-771` | `hostOperationIssue` 校验失败 → 立刻 `clarify(problem)` | **越权（问）** | **已改**：`issue` + 既有修复轮（`continue`） |
| P03 | 原 `pipeline.ts:809` | 旅游场景构建失败 → `clarify(ask)` | **越权（问）** | **已改**：并入 `issue`，走修复轮 |
| P04 | `pipeline.ts:883`（`sceneAsk`） | 场景卡两次校验失败后，用适配器/模型的 `ask` 作为终局 | 前半**越权**、后半允许 | **已改**：`ask` 先进 `issue` 交给模型；两轮都失败才 `vendor-unavailable` |
| P05 | `pipeline.ts:821`（planner 的 `lookup` 失败） | 适配器原话直接成为答复 | **越权（问）** | **已改**：打 `adapter` 标 → 宿主以 `vendor-unavailable` 说出同一句话（旧规划器没有能力表可重选，见未做项） |
| P06 | `pipeline.ts:596-629`（工具 `lookup` 失败） | 适配器原话直接成为答复 | **越权（问）** | **已改**：`invalid` + issues → 一次修复轮；同 `(capability,args)` 指纹不重复执行（防死循环，报告 §3.3）；仍失败 → `vendor-unavailable` |
| P07 | `pipeline.ts:485`（`adapterOnly` 兜底） | "请明确要查询的城市或资料关键词" 终局澄清 | **越权（问）** | **已改**：返回 `adapterClarify`（内部标记），由工具路径转成 `invalid`+issues |
| P08 | `pipeline.ts:117/656/680`（`legacyFallback`） | `VIVIC_LEGACY_FALLBACK=on` 时，工具轮失败可静默改用旧规划器 | **越权（选）** | **保留开关、默认 off**（本轮按用户要求只删第二套决策系统，不动该开关）；P1 直接删除该分支 |
| P09 | `pipeline.ts:669/681/888`（终局） | 两轮都失败 → 一句"换一种说法" | 允许（`vendor-unavailable`：修复预算耗尽必须有可见输出） | 已改（打标） |
| P10 | `pipeline.ts:646/784/829`（模型 `clarify`） | 模型自己决定问什么 | 允许（决策） | 已改（`source: "model"`） |
| P11 | `pipeline.ts:360/638`（删除确认） | 删除/清空在无任务管理器的场景下被冻结，要求用户到控制页确认 | 允许（`confirm`） | 已改（打标） |
| P12 | `pipeline.ts:444`（HTTP 链接） | 只允许公开 HTTPS | 允许（`policy`） | 已改（打标） |
| P13 | `toolCalls.ts:634-651 resolveHostTarget` | 目标歧义/缺失 → `invalid` + 编号候选 + 追问话术兜底 | 允许（校验） | 保留（上一轮已完成） |

## 5. 默认值填充 / 参数改写（`intent/toolCalls.ts`、`intent/validation.ts`）

| # | 位置 | HEAD 行为 | 判定 | 处理 |
|---|---|---|---|---|
| N01 | `toolCalls.ts:normalizeSceneData`（日期） | 把"下周一/昨天/周一二三"换算成 ISO | 允许（推导） | 保留 |
| N02 | 同上（`book_record.status` / 场景枚举） | 中文状态词映射到契约枚举 | 允许（推导） | 保留 |
| N03 | 同上（`rating` 小数） | 前端不认小数评分时，删除 `rating` 并写进 `notes`（"评分 4.5"） | **越权（改）**：静默替换模型的值 | **保留（P1）**：由 `VIVIC_DECIMAL_RATING` 控制，前端支持后删除该分支 |
| N04 | `toolCalls.ts:414 headlineFrom` | 回答卡缺标题时用正文首句截断 | 允许（推导，不编造） | 保留 |
| N05 | `intent/validation.ts:normalizeBatchCamera/ReminderStamps/DateCountdownUpdates` | 批量镜头、提醒时间戳、日期倒计时归一 | 允许（推导/执行前归一） | 保留 |
| N06 | `toolCalls.ts:434-450 clarifyRejection` | 模型问的日期/时间/目标其实原话已确定 → 拒绝该问题并回 `invalid`+事实 | 允许（校验） | 保留 |
| N07 | `toolCalls.ts:561-1064 planFromToolCalls` | 工具→动作的纯映射；缺参数 `need()`（宿主问） vs 值非法 `fail()`（invalid） | 缺参数分支**越权（问）**（模型已选工具、只是参数缺席） | **保留（P1）**：与 `create_countdown`/`create_todo` 的 `askOrFail` 一致，属"参数校验 vs 信息不全"的边界，需产品裁决 |

---

## 6. 汇总

| 层 | 决策点 | 越权 | 本轮改 | 保留例外 |
|---|---|---|---|---|
| 规则层（R01–R11） | 11 | 6 | 1 | 5 |
| 适配器（A01–A11） | 11 | 6 | 5 | 1 |
| 宿主目标解析（T01–T09） | 9 | 2 | 0 | 2 |
| 规划/工具循环（P01–P13） | 13 | 8 | 7 | 1 |
| 默认值/参数改写（N01–N07） | 7 | 2 | 0 | 2 |
| **合计** | **51** | **24** | **13** | **11** |

- 允许（推导/校验/执行）：27，全部保留。
- 越权 24：**改掉 13**（R07、A01、A02、A06、A07、A08、P01、P02、P03、P04、P05、P06、P07）；
  **保留为例外 11**（R06、R08、R09、R10、R11、A10、T02、T03、P08、N03、N07，理由见 §7 与 §8）。
- 删除的越权代码：2 段整段删除（P01 关键词多要求门、A06 旅游追问）+ 1 组流程改写
  （P02/P03/P04 从"终局澄清"变"修复轮"）。
- **后续一轮（2026-11-04，`2026-11-04-remove-alternate-decision-paths.md`）**：
  第二套决策系统整块删除——不再有"保留例外"，因为它们所在的路径已经不存在了。
  删除的条目：R06（`directOperations`）、R09（`slotNormalize`）、R10（`slotPlanner`）、
  R11（`decision/on.ts` 批次合并）、T02/T03 的决策路径（`decision/intent.ts` 本地决策 + 4B 目标分类）。
  R08、P08、A10、N03、N07 与四条非语义中断理由（`confirm`/`safety`/`policy`/`vendor-unavailable`）保留不变。

## 7. 保留的例外（本轮删除第二套决策系统后剩 7 行，其中 2 行各含多项；逐条理由）

| 例外 | 理由 | 依据 |
|---|---|---|
| R08 `contextSafety.incompleteCanvasIssue` | 截断画布下"只有一张匹配"不可证明；继续执行会删错/改错卡。宿主是唯一知情者 | `safety`（数据完整性） |
| P11 删除/清空确认（规则路径 + 工具路径） | 不可逆操作必须由用户点头，宿主只冻结提案 | `confirm` |
| P12 HTTP/内网链接拒绝 | 传输与隐私策略 | `policy` |
| A07（无工具面）/R07（无模型）/P05/P09/终局 fallback | 没有可回传的对象或修复预算已用完，必须给出可见的一句话 | `vendor-unavailable` |
| A10 `wantsLiveFacts` 确定性下限 | 只在模型两轮失败后触发，避免"实时问题凭记忆回答"或死路；**但触发条件仍是关键词**，列为 P1 | `vendor-unavailable`（兜底执行） |
| P08 `legacyFallback` | 运维开关，默认 `off`；打开即"用旧规划器代替模型" | 属配置，不属于默认行为 |
| N03 `rating` 降级、N07 `need()` 缺参数追问 | 前者是前端契约未就绪时的静默替换（P1 删除）；后者是"参数校验 vs 信息不全"的边界，需产品裁决 | 有开关/待裁决 |

## 8. 未做项（按优先级）

1. ~~**P1｜`decision/on.ts` 批次澄清**~~：**已随整条 on/shadow 路径删除**（2026-11-04 第二轮）。
2. ~~**P1｜`intent/slotPlanner.ts` + `slotNormalize.ts`**~~：**已删除**（连同 `VIVIC_DECISION_POLICY`、`planCache`、`promptCompact`）。
3. ~~**P1｜`decision/intent.ts` + `directOperations.ts`**~~：**已删除**（本地分类器不再参与理解）。
4. **P1｜`VIVIC_LEGACY_FALLBACK` 分支删除**：工具轮失败后静默改用旧规划器，与原则直接冲突；
   本轮按用户要求**只保留开关、默认 off**，不删分支。
5. **P1｜`wantsLiveFacts` 下限**：把"关键词 → 检索"换成"模型收到能力不可用的可见提示"。
6. **P1｜`normalizeSceneData` 的 `rating` 降级**：前端支持小数评分后删除。
7. **P2｜旧规划器的 `lookup` 失败**（P05）：现在只能打标成 `vendor-unavailable`；旧规划器没有能力表，无法重选，随其下线一起消失。
8. **P2｜上下文注入**：截断画布这个事实应该写进工具系统提示词（"你只看到 64/N 张卡"），让模型自己决定要不要问——R08 的根治方案。
