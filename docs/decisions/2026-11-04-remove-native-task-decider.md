# 删除原生 V2 决策回路，任务管理器只留流程（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），起点 `6dc7f94`，工作树干净。
- 用户决定：删除 `decision/taskV2.ts` 里由 `NativeV2Provider.decide` 驱动的整套"原生 V2 决策回路"。
  这是代码中最后一条**非模型**决策路径：它自己解析 `next_step`/`operation`/`target`/`slots`，
  还保留一条 `fallback("vision_requires_planner")`，遇到带图请求时由宿主改道。
- 原则：模型是唯一决策者，任务管理器只负责流程。删除后任务管理器只有一条规划路径——
  `deps.legacy` → 同一个 `runIntent`（规则层 + 工具面 / 规划器）。
- 边界：只改本 worktree 后端源码/测试/文档；不部署、不碰服务器、不跑线上验收；单测在本地跑。

## 1. 删了什么

### 1.1 原生协议与目录

| 删除 | 说明 |
|---|---|
| `apps/local-api/src/decision/nativeV2.ts`（72 行） | `NativeV2Provider`/`NativeQuestion`/`NativeScore`/`NativeResult`、`NativeGate` 与 `DEFAULT_NATIVE_GATE`、`parseNativeAnswers`、`acceptedNativeChoice`、`HttpNativeV2Provider` |
| `apps/local-api/src/decision/catalogV2.ts`（43 行） | `CAPABILITIES`、`capabilityCatalog`、`cardCatalog`、`CATALOG_VERSION`；只被原生 `choose()` 的 state/operation/target 问题使用 |
| `scripts/decision-model/native-v2-probe.ts`（66 行） | 只探测原生 state/questions readout 的脚本；没有运行时消费方 |

### 1.2 `DecisionTaskManager` 里的选择循环

`decision/taskV2.ts` 从 533 行降到 306 行，删除：

- `Options.provider` / `Options.gate` / `Options.maxSteps`、`NativeV2Provider` 注入、`status()`（`configured`/`executionEnabled`/`calibration`/`mode`）；
- `choose()`、16 轮 `next_step` 循环、`state()`、原生 `span()`（Unicode code point 分段）、`build()`（operation→action/host-operation 的宿主构造）、`Defer`/`Missing` 降级；
- `scores`/`operation`/`targetId`/`slots`/`slotEvidence`/`failures`/`llmCalls`/`toolCalls`/`hasRemaining`/`proposed`/`phase`/`reason`/`mode` 这些只为循环存在的状态字段；
- `fallback("vision_requires_planner" | "v2_not_configured" | "v2_quality_gate_disabled")` 及
  `if (request.attachments?.length) return fallback("vision_requires_planner", true)`；
- `exactHostOperation` 的宿主直出捷径（规则层 `fastHostOperation`/`offlineReference` 已经覆盖同一批整句命令，且仍受回执约束）。

### 1.3 配置与装配

| 位置 | 删除 |
|---|---|
| `src/config.ts` | `decisionV2Url`/`decisionV2Token`/`decisionV2ExecutionEnabled`/`decisionV2TimeoutMs` 字段与 `VIVIC_DECISION_V2_URL`/`_TOKEN`/`_EXECUTION_ENABLED`/`_TIMEOUT_MS` 读取 |
| `src/online/appFactory.ts` | 在线会话对上述四个字段的注入（含 `decisionV2ExecutionEnabled: false`） |
| `src/app.ts` | `AppDeps.decisionV2Provider`、`HttpNativeV2Provider` 装配、`ManagedStartluxRuntime.decideNative` 适配、`/api/decision/status` 的 `v2` 子状态（`source`/`available`/`runtimePhase`/`profileId`/`calibration`/`executionEnabled`/`mode`） |
| `src/runtime/startluxRuntime.ts` | `decideNative()`、`nativePending` 与消息/退出/终止分支；保留旧的七标签 `decide()`（模型设置/本地运行时面板仍在用） |

`src/hosted/service.ts` **无需改动**：其中的 `executionEnabled: false` 属于
`/api/space/models/decision/*` 的"分类模型连接"状态（`protocol: "classification-only"`），
是模型设置面，不是本轮删除的任务执行门。

### 1.4 端点/类型/线上兼容

- `/api/decision/status` 不再返回 `v2` 字段；前端 `LocalDecisionSettings.tsx`/`LauncherApp.tsx`
  读取的是 `status?.v2?.configured`（可选），字段消失后该行自然隐藏，不会 404。
- `packages/contracts/src/decisionTask.ts` 的 `protocolVersion` 与 `decision` 字段**保留**：
  它们是任务响应的线协议，web 的 `IntentResultSchema`/`DecisionTaskStatusSchema` 是 strict 解析，
  `apps/web/src/control/legacyChoicePolicy.ts` 也读 `decision === "legacy-fallback"`。
  但后端现在**永远**返回 `protocolVersion: "vivic-decision-v2"` + `decision: "legacy-fallback"`，
  `native-v2` 不再产生，也没有任何 native state/questions/概率/校准字段。文档在此写明，避免误读。

## 2. 任务管理器现在只做什么

`DecisionTaskManager.run` 保留的职责（全部是流程/宿主安全，不选下一步）：

1. **任务创建与跨请求续接**：`task.id`、TTL/容量、澄清回答（编号/完整标题冻结在提问时）、
   confirm/cancel 回答、执行回执、取消、幂等。
2. **唯一规划路径**：每轮调用 `deps.legacy`（`runIntent`），把原始目标、补充回答、
   `resolvedTargets`/`resolvedTargetId`、已完成步骤与观察记录交回模型；模型给
   envelope / host-operation / clarify / error，任务管理器只做校验与状态推进。
3. **破坏性操作冻结**：`safetyMode` 下 `assessDeletion` → `freezeDeletion`，
   只有整句肯定（模型分类 `confirm` 或确定性语法）且目标/画布未变才执行；
   复合删除不借确认问题夹带第二个操作。
4. **执行回执**：`executionId`、画布版本、创建卡 id 校验、失败/取消状态、重复回执去重；
   成功回执后任务完成（不再由宿主规划下一步）。
5. **现有安全门**：纯指代删除（"删了它"）的宿主解析、歧义候选冻结、每次请求的连接/预算/画布校验。

`/api/intent` 的路由也相应简化：没有 `task` 的普通请求直接 `runIntent`；带 `task.id` 的请求
（web 的 `runDecisionTask` 每次都会带）才进入任务管理器。

## 3. 带图任务怎么走

删除特判后，带图请求与文字请求走**同一条**模型路径：

```
带图请求（task 有 id）
  └─ DecisionTaskManager.advance
       └─ deps.legacy → runIntent
            ├─ 工具面（VIVIC_TOOL_CALLS=on 且本次附件带图）→ 模型选择能力/建卡
            ├─ 视觉规划器（工具面关闭或 GPT 主规划器）→ 模型出 action/坐标/内容
            └─ 模型自己的 clarify → 任务管理器原样返回，不建卡
```

宿主不再插入 `vision_requires_planner`，也不再替模型决定"图片一定要交给规划器还是工具面"。
图片分析卡已经在工具路径恢复（见 `2026-11-04-image-on-tool-path.md`），本轮把任务入口也接上。

## 4. 为什么

1. **它是最后一条非模型决策路径**：`choose()` 用原生概率替模型选择 resolve/execute/llm/tool/clarify/finish，
   `build()` 又由宿主构造动作与槽位；同一句话会有"模型答案"和"原生回路答案"两个来源。
2. **带图分支直接暴露了越权**：宿主看到 `attachments` 就改道，模型没有机会决定"这张图要不要建卡、
   建成什么"。删除后模型是唯一决定者。
3. **默认部署本来就没开**：`VIVIC_DECISION_V2_EXECUTION_ENABLED` 默认关闭，在线会话强制 `false`；
   删除只是去掉一条随时可能被环境变量打开的旁路。
4. **流程职责已经完整**：澄清、删除冻结、回执、幂等、取消、续接都由任务管理器负责，
   不需要它自己"选下一步"。

## 5. 剩余引用与风险

1. **没有自动多步重规划**：此前原生回路可在一次任务里连续执行多步；现在一次任务 = 一次模型提案
   + 一次真实回执。需要继续操作时由调用方发新请求/新任务（hosted 的冲突重规划与澄清续接仍在）。
   web 的 12 步执行循环在收到 `completed` 后正常结束，不会卡住。
2. **外部对 `/api/decision/status.v2` 的依赖**：仓库内前端已按可选字段处理；仓库外客户端若读取
   `v2.calibration`/`v2.executionEnabled` 会得到 `undefined`，属于预期破坏，本轮未部署。
3. **`VIVIC_DECISION_V2_*` 环境变量**：代码不再读取；服务器上即使仍设置也不会生效（本轮未部署、未改服务器）。
   旧文档 `docs/updates/2026-10-23-jev-actions.md`、`docs/verification/full-mac-20261024.md` 保留为历史证据。
4. **4B 原生探针**：`scripts/decision-model/native-v2-probe.ts` 删除后，原生协议无法再本地复现；
   模型运行时本体（下载/加载/七标签推理）与 `/api/space/models/decision/*` 保留。
5. **`decision` 标签的语义**：字段只为线协议兼容而保留，值恒为 `legacy-fallback`；不要再据此判断"有没有模型"。

## 6. 测试基线（与 HEAD 逐条比对）

- 命令：`pnpm --filter @vivic/local-api test -- --maxWorkers=4`（`vitest run` 全量）。
- 删除前（HEAD `6dc7f94`，`work/native-removal/baseline.log`）：
  **8 failed / 2609 passed / 3 skipped（2620 条），116 个测试文件**。
- 删除后（`work/native-removal/final3.log`）：
  **8 failed / 2595 passed / 3 skipped（2606 条），116 个测试文件**。
- 测试数变化：2620 → 2606（-14）。`decision-v2.test.ts`（30 条）整份删除，新增
  `decision-task-flow.test.ts`（16 条），净 -14。
- 删除的 8 条失败集合与 HEAD **逐条一致，新增 0**：

| 套件 | 用例 | 与本次删除的关系 |
|---|---|---|
| `command-matrix` | false positives: ambiguous or mixed requests must defer > todo | 既有 |
| `deepseek` | fails clearly without DEEPSEEK_API_KEY and never falls back to StepFun | 既有 |
| `provider-main-transport` ×3 | uses a saved DeepSeek row without… / prefers a DeepSeek row… / picks up a provider… | 既有 |
| `stepfun-stream` | bounds an open stream by the existing deadline without retrying timeout | 既有 |
| `weekly-plan-grounding` ×2 | builds proposed days… / lets the rule planner build sc-16… | 既有 |

### 随功能删除的用例（不进入剩余失败）

`tests/decision-v2.test.ts` 的 30 条中，属于原生回路的 19 条删除：

- `independent native v2 adapter` 3 条（概率分布解析、原生 HTTP 请求体、超时）；
- `versioned decision task execution` 中以 `scripted(provider)` 驱动 `choose()` 的 16 条
  （原生选路/冻结候选/取消迟到结果/finish 防循环/删除范围/原生提醒 span/LLM 回灌/工具选择/质量门/在线原生任务）；
- 其余 11 条不是原生协议测试：2 条纯工具/协议单测（`hostOperationIssue`、host union 与 envelope 互斥）、
  2 条卡片格式归一化、1 条主模型 host-operation 回退**原样保留**；另外 6 条
  （回执/错误回执/过期回执/取消在途规划/TTL/总预算）改写为不依赖 provider 的流程测试。

保留/新增的流程覆盖（`decision-task-flow.test.ts`，16 条）：

- 一次规划 + 真实回执 + 重复回执幂等、错误/失败回执、创建卡在回执和画布同时确认前不能完成、
  画布版本过期的回执、取消进行中的规划、TTL 过期、总预算；
- 澄清编号冻结 + 原始目标重放（`resolvedTargetId`）、删除冻结 + 整句肯定才执行 + 否定取消；
- 带图任务直通模型（管理器和真实 `/api/intent` 各一条，断言附件原样到 `runIntent`、请求体含
  `image_url`、模型 clarify 不建卡）；
- 既有宿主安全（固定卡不能移动、日期/条件提醒不能暂停、host union 与 envelope 互斥、卡片格式归一化）。

### Typecheck

`pnpm --filter @vivic/local-api typecheck`：只剩既有的 `tests/helpers.ts(8,23)`
（`modelApiBaseUrl: string | undefined`）。删除 `decision-v2.test.ts` 后，该文件里所有原生类型错误随文件消失。

### Oxlint

`pnpm exec oxlint` 逐个检查改动文件（`app.ts`、`config.ts`、`decision/taskV2.ts`、`online/appFactory.ts`、
`runtime/startluxRuntime.ts`、两个测试文件）：**0 warnings / 0 errors**。
`catalogV2.ts`/`nativeV2.ts` 删除后没有未使用导出残留。
