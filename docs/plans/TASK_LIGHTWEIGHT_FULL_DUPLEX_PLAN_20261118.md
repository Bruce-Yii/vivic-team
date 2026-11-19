# VIVIC 任务型轻量全双工执行计划

> 日期：2026-11-18  
> 关联设计：[VIVIC 任务型轻量全双工产品能力映射与代码审查](../design/task-lightweight-full-duplex-spec.md)  
> 基线分支：`main` (`88e51a79d6fcae7dd7e8951b50dd8a37ebd2838c`)  
> 实施分支：`feat/task-lightweight-full-duplex`

## 1. 目标与范围

- **Goal**：基于现有 `apps/web/src/ai/*` 全双工基线与 `apps/local-api` 语音网关，分阶段补齐 8 项任务型轻量全双工能力（C1–C4 + B1–B4），打通“防误触规则打断 + 连续多轮流式 ASR + 执行期安全覆盖/追问 + 打断上下文对齐 + UI 联动打断”的工程闭环。
- **Non-scope**：
  - 不引入端到端语音大模型替代 VIVIC Decision / Host；
  - 不修改线上部署配置、不提交任何真实 API Key 或 `.env`；
  - 不在未经真机实测前宣称真实供应商/麦克风验收通过。

## 2. 分阶段执行计划

### Phase 1：流式 ASR 客户端多轮会话与重连增强（C2, B4）
- **目标文件**：`apps/web/src/ai/asrGatewayClient.ts`
- **具体改动**：
  1. 支持可选配置项（`provider` 默认 `"mock"` 保持兼容、`language`、`autoReconnect`、`maxReconnectAttempts`）。
  2. 补齐 `msg.type === "error"` 分支，透传给 `callbacks.onError`。
  3. 增加多轮会话轮换机制：收到 `session.ended` 或 `commit()` 后自动标记会话待新建，下一轮 `sendAudio` / `startTurn()` 时在同一连接上发起新 `session.start` 并重置 `seq = 0`，解决连续多轮 ASR 失效问题。
  4. 增加异常断连后的有界重连，支持携带 `resumeSessionId` 对接服务端 grace window。

### Phase 2：规则打断防抖、中断上下文截断与工作上下文约束（C1, C3, B2, B3）
- **目标文件**：
  - `apps/web/src/ai/turnTaking.ts`
  - `apps/web/src/ai/taskProjection.ts`
- **具体改动**：
  1. 在 `turnTaking.ts` 新增 `InterruptedSpeechContext` 与 `buildInterruptedSpeechContext(snapshot)`：基于 `SpeechSnapshot.text`、`wordRange` 与 `playbackLedger.playedMs` 提取实际已播报片段并标记 `interrupted: true`，供下一轮请求对齐上下文。
  2. 在 `turnTaking.ts` 新增轻量 Working Context 约束队列（`appendWorkingConstraint` / `consumeWorkingConstraints` / `getWorkingConstraints` / `clearWorkingConstraints`），承接播报期或执行期用户追加的 `new_constraint`。
  3. 在 `taskProjection.ts` 扩展 `TaskMutationClass`（`"read_only" | "mutating" | "unknown"`）与 `canSafelySupersede` 字段，并在 `turnTaking.ts` 提供 `classifyTaskCancellationSafety()`，明确“只读可覆盖、写入防脏状态”的决策边界。

### Phase 3：全双工协调器闭环与 UI 联动打断（C1, C3, B1, B2, B3, B4）
- **目标文件**：`apps/web/src/ai/fullDuplex.ts`
- **具体改动**：
  1. 抽离并导出纯逻辑 `createSpeechSegmentDetector`：加入**起音防抖（默认 160ms）**与**尾音保持 Hangover（默认 500ms）**，替代单帧 RMS 翻转，避免瞬时噪声误打断和字间停顿误切句。
  2. 引入单调 `turnId`、显式协调器状态（保留既有 `FullDuplexStatus` 兼容并补充 `interruptedContext`、`pendingConstraints`、`turnId`）。
  3. 修复播报期 `onFinal` 分流逻辑：
     - `new_constraint`：存入 Working Context（若当前无活动任务则直接作为新指令发出），不再静默丢弃；
     - `new_topic` / 有效指令（非空且非语气词的 `unknown`）：确认打断（`confirmBargeIn`）、记录 `interruptedContext`，并按 `canSafelySupersede` 决定是否取消运行中的只读任务后触发 `onCommand`。
  4. 新增 `interruptByUi(reason)`：供卡片点击、输入框打字、焦点切换等 UI 交互调用，立即停播 TTS、记录中断上下文并恢复监听态。
  5. 移除 `(window as any).__fd_unsub` 全局挂载，改用模块私有清理句柄；补充 `visibilitychange` 保护。

### Phase 4：单元测试补齐与后续集成/实测清单
- **目标文件**：`apps/web/src/ai/__tests__/fullDuplexCoordinator.test.ts`
- **本轮落地测试**：
  - VAD 起音防抖与尾音保持边界测试；
  - 打断上下文截断（含 `wordRange` 精确截断、仅 `playedMs` 降级与无播放状态）；
  - 写操作 vs 只读任务安全取消判定；
  - Working Context 约束入队与消费；
  - UI 联动打断与 ASR 客户端多轮会话轮换 / 错误透传测试。
- **后续需在本地/CI 环境推进的集成与实测项**：
  1. 在 `ControlApp.tsx` / `ChatComposer.tsx` 接入 `interruptByUi()`，并将 `interruptedContext` 与 `pendingConstraints` 透传给 `/api/intent`；
  2. 将 `asrGateway.ts` 的真实 ASR Provider（如 StepFun / 本地模型）与 `AsrGatewayClient` 配置打通；
  3. 在真实浏览器 + 麦克风环境下运行回声消除（AEC）、语义打断与连续多轮 E2E 实测，更新 P3（YU-405）验收结论。

## 3. 验证命令（需在本地或 CI 执行）

```bash
pnpm --filter @vivic/web test turnTaking fullDuplexCoordinator speechStreaming
pnpm --filter @vivic/web typecheck
pnpm typecheck
```
