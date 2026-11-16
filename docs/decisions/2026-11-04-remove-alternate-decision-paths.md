# 删除第二套决策系统（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），起点 `ca0c494`。
- 用户决定：把"第二套决策系统"**从代码里删除**（不是关开关），只保留 `VIVIC_LEGACY_FALLBACK` 开关（默认 off）。
- 判定标准：删除后"理解"只剩一条路径——**模型**（规则层保留的"格式完全确定"直出除外）。
- 边界：只改后端源码/测试/文档；不部署、不碰服务器、不跑线上验收；单测在本地跑。

## 1. 删了什么

### 1.1 on/shadow 的 4B 路由与执行路径

| 删除 | 说明 |
|---|---|
| `apps/local-api/src/decision/on.ts`（528 行） | `runDecisionOn`、`multiCardMode`、greeting/intro 直出、`literalRoute`、`hybridProposal`（M1/M3 多卡合并协议）、`isInitialTask`、`friendlySay` |
| `apps/local-api/src/decision/intent.ts`（45 行） | `localDecisionIntent`：本地分类器把七标签向量直接变成 `canvas.fit`/`card.focus` 等信封 |
| `apps/local-api/src/intent/directOperations.ts`（147 行） | 直连单卡操作解析（只被 `decision/on.ts` 引用，`git grep` 确认无第二处引用） |
| `apps/local-api/src/decision/router.ts` 的 4B 部分 | `createIntentRouter`、`routeUtterance`/`chooseTarget`、`VIVIC_DECISION_MODE`、`VIVIC_DECISION_URL`/`_API_KEY`/`_MODEL`/`_TIMEOUT_MS`/`_ROUTES`、`IntentRouter`/`RouteResult`/`ChoiceResult`、`buildState`/`stateLabel`/路由提示词、扩展卡两层选择 |
| `decision/trace.ts` 的观察器 | `observeDecision` 不再调用任何分类器、不发布 route hint、不等待 250/300ms 预算；只记录本轮"宿主提交了什么" |

`decision/router.ts` 现在只保留 `cardTitle`/`cardLabel`/`selectedCards` 三个纯标签/几何辅助（`target.ts`、`toolCalls.ts`、`deleteTarget.ts` 需要它们），文件头写明"这里不再路由任何东西"。

### 1.2 槽位规划器

| 删除 | 说明 |
|---|---|
| `apps/local-api/src/intent/slotPlanner.ts`（552 行） | 与主规划器竞争的第二套规划器：contract/slots 输出、扩展卡澄清、`VIVIC_DECISION_POLICY=main-only` 分支 |
| `apps/local-api/src/intent/slotNormalize.ts`（144 行） | 槽位归一 + 槽位澄清字符串 |
| `apps/local-api/src/intent/planCache.ts`、`promptCompact.ts` | 只被 `slotPlanner` 使用的计划缓存与紧凑提示词 |
| `PipelineDeps.slotPlanning` / `compactContext` / `mainOnly`、`pipeline.ts` 的 `runSlotPlanner` 分支与 shadow/on 输出通道重排 | 整块删除 |
| `VIVIC_DECISION_POLICY`（`full`/`main-only`） | 只喂养槽位规划器与 hybrid 多卡；连同 `policy` 字段、trace 里的 `policy` 一起删除（历史 trace 行仍可解析） |

### 1.3 本地分类器（4B）在理解链路上的调用

- 删除 `PipelineDeps.decision`（`Pick<DecisionManager,"score">`）与 `pipeline.ts` 里在规划器之前的那次本地分类调用；`app.ts` 不再把决策管理器交给一轮请求。
- 七标签向量与它的保守判定表（0.8 阈值 + 0.25 领先，破坏性/否定/引用句一律不执行）**没有删除**，移到 `decision/labels.ts`：它是被保留的模型运行时（`DecisionManager`、`/api/decision/*` 设置面板）自己的解码/校验层，只收窄提供方自己的输出，**不再决定一轮请求**。

### 1.4 配置

| 环境变量 | 处理 |
|---|---|
| `VIVIC_DECISION_MODE`、`VIVIC_DECISION_URL`、`VIVIC_DECISION_API_KEY`、`VIVIC_DECISION_MODEL`、`VIVIC_DECISION_TIMEOUT_MS`、`VIVIC_DECISION_ROUTES`、`VIVIC_DECISION_POLICY`、`VIVIC_MULTI_CARD_MODE` | 删除：没有任何代码再读取它们，设置了也没有行为 |
| `VIVIC_LEGACY_FALLBACK` | **保留**（默认 `off`，只关闭、不删除；用户明确要求） |
| `VIVIC_DECISION_V2_*`、`VIVIC_DECISION_PROVIDER_*`、`VIVIC_MANAGED_DECISION` | 本轮保留：它们属于**模型运行时/任务执行器**，不是本轮删除的"理解路径"（见 §4）。**同日后续轮已删除 `VIVIC_DECISION_V2_*`**：见 [删除原生任务决策器](2026-11-04-remove-native-task-decider.md) |

## 2. 为什么

1. **两套系统对同一句话给两个答案。** on/shadow 模式下，4B 分类器的 route/target 行先决定"这句话是什么、指向哪张卡"，主规划器只填空；槽位规划器又用另一套 contract/slots 协议做同一件事。哪一套先说话取决于环境变量，用户和模型都看不见。
2. **本轮的审计已经判定这些路径越权。** `docs/audits/2026-11-04-decision-points.md` 把 R06/R09/R10/R11/T02/T03 标成"宿主替模型选/问"，并把 `decision/on.ts`、`slotPlanner`、`decision/intent.ts`、`directOperations.ts` 列为 P1 未做项。删除比"改成回传"更彻底：这些路径本身没有存在的必要。
3. **默认路径本来就不需要它们。** `VIVIC_DECISION_MODE` 默认 `off`，`main-only` 是试点；线上由 `hosted/service.ts` 在"有 4B 密钥"时才打开 on。删除后默认行为就是原来的 `off` 行为，只是不再有第二条路可切回去。
4. **规则层已经覆盖"格式完全确定"的直出**（`rules`/`plans`/`chartFast`/`habitFast`/`operationsFast` + 精确提醒/倒计时语法），这些保留；剩下的一律交给模型。

## 3. 保留了什么

- **规则层直出**：整句闭合语法、编号清单/周计划、图表数据点、打卡、撤销/重做/整理画布、精确提醒。
- **VIVIC_LEGACY_FALLBACK 开关**（默认 off；工具轮失败仍会给一句可见的话，除非运维显式打开）。
- **宿主推导与校验**：相对日期→ISO、别名/标题/位置→候选、条目级指代、删除确认冻结、`hostOperationIssue`、`actionExecutionIssue`、`incompleteCanvasIssue`、传输策略。
- **任务管理器**（`decision/taskV2.ts`）：任务状态、澄清、删除确认冻结、回执。它现在只有一条底层路径（`deps.legacy` → 同一个 `runIntent`）；复合指令由模型+工具面在一次提案里表达，任务管理器不再逐段规划（同日后续轮删除了原生逐段回路，见 [删除原生任务决策器](2026-11-04-remove-native-task-decider.md)）。
- **决策日志（decision_log）**：仍按轮记录，但内容只剩"宿主提交了什么"（clauses、plannerCalls、directClauses、provider、动作/卡型、plans）；分类器对比字段（`mode`/`decisions[].probabilities`/`policy`）变成可选，只用于读历史行，不再产生。
- **模型运行时与管理面板**：`DecisionManager`、`/api/decision/status|models|profile|prepare|stop|clear|enable`、`/api/space/models/decision/*`、`runtime/startluxRuntime.ts`、`decision/provider.ts`。这些是"模型设置/下载"这条产品面（前端 `LocalDecisionSettings`、`LauncherApp`、启动器仍在调用），**不再参与理解**。同日后续轮删除了 `decision/nativeV2.ts` 与原生任务回路（模型设置面保留），见 [删除原生任务决策器](2026-11-04-remove-native-task-decider.md)。

## 4. 结构上的结果

```
一句话
 ├─ 规则层（format-determined）           → 直接 envelope / host-operation
 ├─ 工具面（VIVIC_TOOL_CALLS=on）          → 模型选能力，宿主校验
 └─ 规划器（默认）                        → 模型出提案，宿主校验/执行
        ↑ 只有这一条"理解"路径；没有任何分类器/第二规划器参与
```

- `runIntent` 现在只有 `legacy()` 一条执行体；`observeDecision` 只是记录器（没有监听者时是直通）。
- `resolveTarget` 只做宿主推导（标题/别名/指针/序号/类型/方向），推不出来就是 `ambiguous`，由模型问。
- 任务管理器不再消费 route hint；删除确认由 `execute()` 的 `assessDeletion` + `freezeDeletion` 统一负责。

## 5. 已知缺口（删除的代价，需要后续补）

1. **图片分析卡**：`cards/imageAnalysis.ts` 的 `image_analysis` 契约只在槽位规划器里被调用；`hosted-intent-image.test.ts`（图片留存/跨账号读取/NewsCard 构建）随之删除。现在图片请求仍会进入规划器（视觉），但**没有宿主把 `media:image_<hash>` 注入 NewsCard** 的路径。
   跟进方案：在图片请求下由宿主把本次 `trustedImageRef` 注入模型创建的 `news_summary`/NewsCard（属于"推导"，模型无法知道这个值），或给工具面加 `analyze_image`。
   **已于同日补上**（走前一种方案，不新增工具）：见 `docs/decisions/2026-11-04-image-on-tool-path.md`。
2. **任务执行器的原生 v2 门**（`VIVIC_DECISION_V2_EXECUTION_ENABLED`，默认关闭）：它按"原生 state/questions"选择 `next_step`/`operation`/`target`，只在显式打开且配置了服务时生效。本轮没有删除它（它不是"本地分类器"，也不在默认理解路径上），但它是最后一条非模型决策回路；要彻底单一裁决需另开一轮。
   **同日后续轮已删除**：`nativeV2.ts`、`catalogV2.ts`、provider 驱动的 `choose()`/`build()`、`VIVIC_DECISION_V2_*` 与本任务里的带图改道全部移除，任务管理器只保留流程。见 [删除原生任务决策器](2026-11-04-remove-native-task-decider.md)。
3. **前端设置面板**：`apps/web/src/control/LocalDecisionSettings.tsx`、`apps/web/src/launcher/*` 仍在调用 `/api/decision/*`。后端端点保留，所以面板不会 404，但它管理的模型已不参与理解。
4. **`deploy/decision/` 脚本**：`prepare_shadow_eval.py`、`provision_key.py` 仍写 `VIVIC_DECISION_MODE`，现在这些变量无效。

## 6. 测试基线（逐条对比）

- 命令：`pnpm --filter @vivic/local-api test`（`vitest run`，全量）。
- 删除前（`ca0c494` 工作树，`work/decision-removal/baseline-*.log`）：
  **32 failed / 3026 passed / 3 skipped（3061 条），132 个文件**。
- 删除后（`work/decision-removal/after3-*.log`）：
  **8 failed / 2574 passed / 3 skipped（2585 条），114 个文件**。
- `Compare-Object` 逐条比对失败集合：**新增 0**；随功能一起删除的失败 **24 条**（全部落在被删的 5 个套件里：
  `decision-on`/`decision-shadow`/`decision-routing`/`decision-main-only`/`decision-target-clarification`/`provider-main-multicard`/`routing-rules-first` + accept60 的 on-mode 用例）。
- 剩余 8 条失败全部是删除前就存在的（`command-matrix.todo`、`deepseek` 无密钥、`provider-main-transport` × 3、
  `stepfun-stream` 超时、`weekly-plan-grounding` × 2），与本次删除无关。
  另有一次全量跑出现 `command-matrix` 的 1422 变体用例超时（并行负载下抖动），单跑与第三次全量均通过。
- 测试数变化：3061 → 2585（-476），其中删除的套件 18 个文件；保留测试中 **没有把失败断言改成通过**：
  只删除了驱动被删路径的用例，其余改动是"去掉 `router`/`routeHint` 注入"与"断言从 `trace.mode` 改为仍存在的 provenance"。

### 逐条说明：哪些失败随功能一起删除

| 套件 | 删除的失败 | 原因 |
|---|---|---|
| `accept60-regressions` | 9 条（sc-05/sc-34/sc-39/sc-40/sc-51/sc-54/sc-58、暂停确认、main-only sc-12） | 全部靠 on-mode 的"逐子句分类 + 宿主解析目标"实现 |
| `decision-main-only` | 5 条 | `VIVIC_DECISION_POLICY` 删除 |
| `provider-main-multicard` | 4 条 | hybrid 多卡（`VIVIC_MULTI_CARD_MODE`）删除 |
| `decision-routing` / `decision-shadow` / `decision-on` / `decision-target-clarification` / `routing-rules-first` | 各 1 条（共 5 条） | 4B 路由/影子观察/目标分类删除 |

### 删除的测试文件（18 个）

`decision-on`、`decision-on-http`、`decision-shadow`、`decision-routing`、`decision-main-only`、
`decision-target-clarification`、`decision-confirmation`、`decision-provider-http`、`extension-routing`、
`multi-card-hybrid`、`provider-main-multicard`、`routing-rules-first`、`task-route-feedback`、
`slot-planner`、`extension-slots`、`plan-cache`、`hosted-extension-intent`、`hosted-intent-image`。

其中 `decision-confirmation`（444 行）整份删除：它的全部装置都在驱动 task manager 的
"route hint → 预删除目标 → 冻结确认"分支，而该分支随 route hint 删除；删除确认本身仍由
`delete-safety`、`delete-target`、`local-entry` 三个套件通过"规划器提案 → `assessDeletion`/`freezeDeletion`"覆盖。

### Typecheck

`pnpm --filter @vivic/local-api typecheck`：只剩既有的 `tests/helpers.ts(8,23)`（`modelApiBaseUrl: string | undefined`）。
`tests/accept60-regressions.test.ts:196` 的既有错误随其所在用例（"keeps the loaded-state requirement for the model path"）删除而消失——该用例断言的是 on-mode 的宿主暂停路径，且调用了 `hostOperationIssue` 不存在的第三参数。
