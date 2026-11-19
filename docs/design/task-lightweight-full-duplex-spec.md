# VIVIC 任务型轻量全双工产品能力映射与代码审查

> 日期：2026-11-18  
> 基线：`Bruce-Yii/vivic-team@main` (`88e51a79d6fcae7dd7e8951b50dd8a37ebd2838c`)  
> 关联资料：[MOSS-Live 接入评估报告](../operations/moss-live-integration-report-20261114.md)、[MOSS-Live 全双工架构约束](../moss-live-full-duplex-architecture-constraints.md)、[交接说明](../../HANDOFF.md)

## 1. 产品定位与取舍

VIVIC 是以“决策 → Host 执行工具 → 建卡/呈现结果”为核心的 Web 信息画布工作台，而非陪聊型语音助手。结合 2026-11-14 的 MOSS-Live 公开 API 探测结论（`function_call_output` 回灌与文本输入被拒，无法闭环接入 VIVIC 工具与卡片管道），VIVIC 不需要引入端到端语音大模型接管对话状态或拟人化附和，而应将全双工能力收敛为 **8 项任务型轻量全双工能力**（4 项核心交互能力 + 4 项工程边界能力）。

## 2. 全双工能力映射到 VIVIC（8 项对齐清单）

### 2.1 核心交互能力（4 项）

| 编号 | 能力项 | 产品目标 | VIVIC 映射模块 |
|---|---|---|---|
| **C1** | **语音播报可随时打断（Barge-in）** | 播报过程中通过 AEC + VAD/规则检测到用户开口，先压低/停播并快速切入新输入；不依赖重型端到端语音模型。 | `apps/web/src/ai/fullDuplex.ts`, `turnTaking.ts`, `speech.ts`, `vad.ts` |
| **C2** | **边说边传与流式 ASR 预判** | 16kHz PCM 持续推流、实时出 partial 字幕、停顿后快速出 final transcript，压低起手延迟并保留完整文本与工具调用链路。 | `apps/web/src/ai/asrGatewayClient.ts`, `apps/local-api/src/asrGateway.ts` |
| **C3** | **工具执行期可追问、可覆盖（状态双工）** | Host 执行工具或查询期间不锁死输入；支持新指令覆盖旧轮次、取消任务或追加约束（Working Context）。 | `apps/web/src/ai/fullDuplex.ts`, `turnTaking.ts`, `taskProjection.ts`, `decisionTask.ts` |
| **C4** | **短语音反馈 + 卡片承载主信息（输出双轨）** | 语音仅承担“状态确认 + 一句话结论 + 行动引导”（短句、去 Markdown/长列表），详细信息与交互操作交给卡片承载。 | `apps/web/src/ai/presetFeedback.ts`, `shortFeedback.ts`, `speech.ts`, `packages/contracts` |

### 2.2 工程边界能力（4 项）

| 编号 | 边界能力 | 产品与工程目标 | VIVIC 映射模块 |
|---|---|---|---|
| **B1** | **UI 联动打断（多模态 Barge-in）** | 用户在听播报时点击卡片按钮、切换画布焦点或开始打字，同样立即停播 TTS，避免界面已切换而语音仍在播报。 | `apps/web/src/ai/fullDuplex.ts`, `speech.ts`, `apps/web/src/control/*` |
| **B2** | **打断后的上下文截断（实际播报对齐）** | 播报中途被打断时，基于实际播放进度（`wordRange` / `playedMs`）生成截断摘要并标记 `interrupted`，避免下一轮误以为用户听完了未播内容。 | `apps/web/src/ai/speech.ts`, `turnTaking.ts`, `fullDuplex.ts` |
| **B3** | **写操作的安全取消边界** | 只读查询类工具被新话题覆盖时可直接作废旧轮次；有外部副作用或写操作的工具需区分“未发出直接取消”与“已发出必须回告结果”，防止脏状态。 | `apps/web/src/ai/taskProjection.ts`, `turnTaking.ts`, `decisionTask.ts` |
| **B4** | **统一显式状态机与断连恢复** | 以单调递增 `turnId` 和显式状态流转管理前后端全双工生命周期，支持 ASR 断连重连（`resumeSessionId`）与连续多轮会话轮换，防止旧轮次残帧串扰。 | `apps/web/src/ai/fullDuplex.ts`, `asrGatewayClient.ts`, `apps/local-api/src/asrGateway.ts` |

## 3. 仓库分支与现有代码审查（2026-11-18）

### 3.1 分支审查

除 `main` 外，仓库当前存在 5 个分支，经核查均为 2026-11-16 的文档同步与交接门禁分支，**无独立未合入的全双工代码分支**：

- `docs/collaborator-repo-version-sync` (`e52edb6`)：协作仓库文档同步，已整合入 `main`。
- `docs/frontend-source-version-collaboration` (`84f8789`) / `docs/frontend-source-version-collaboration-v2` (`1808ad5`)：前端源码留存与协作规范。
- `docs/handoff-accuracy-followup` (`2438fbf`)：交接文档对齐。
- `fix/handoff-gates` (`39972c1`)：交接门禁与陈旧测试修复。

全双工代码基线（`full-duplex a3e5f43`）已随初始快照提交 `5806af4` 合入 `main`。

### 3.2 现有代码实现盘点与缺口

| 模块 | 当前已实现 | 审查发现的缺口 / 缺陷 | 对应能力 |
|---|---|---|---|
| `apps/web/src/ai/fullDuplex.ts` | AudioWorklet 16kHz PCM 采集、RMS 阈值检测、首帧 `duckSpeech()`、挂接 `AsrGatewayClient` 与 `TaskProjection` | 1. **无起音防抖与尾音保持（Hangover）**：单帧超过阈值即触发 duck，单帧低于阈值即 `commit()`，易被瞬时噪音误触发或字间停顿截断。<br>2. **播报期插话逻辑未闭环**：`new_constraint` / `new_topic` 仅写注释未存约束也不触发新命令；普通有效指令（`unknown`）在 AI 播报时被静默丢弃。<br>3. **缺少 `turnId`、UI 联动打断接口与中断上下文记录**；且将订阅清理挂载在 `(window as any).__fd_unsub`。 | C1, C3, B1, B2, B4 |
| `apps/web/src/ai/asrGatewayClient.ts` | WebSocket 连接 `/asr`、`session.start`、`audio.chunk`、`session.end`、`cancel` | 1. **硬编码 `provider: "mock"`**，无法通过配置切换真实 ASR Provider。<br>2. **缺少连续多轮会话轮换**：`commit()` 发 `session.end` 后原会话结束，后续语音帧仍复用旧 `sessionId`。<br>3. **未处理服务端 `error` 帧**，未调用 `onError` 回调。<br>4. **无断线重连与 `resumeSessionId` 逻辑**（而后端 `asrGateway.ts` 已实现 grace window 内重连）。 | C2, B4 |
| `apps/web/src/ai/turnTaking.ts` | 规则意图分类（`stop`/`cancel_task`/`continue`/`new_topic`/`new_constraint`/`backchannel`）、`pauseSpeech`/`confirmBargeIn`/`resumeFromPause` | 1. 缺少打断后上下文截断摘要构造器（未消费 `SpeechSnapshot.playbackLedger` 与 `wordRange`）。<br>2. 缺少 Working Context 约束存储队列。<br>3. 缺少写操作/只读操作的安全取消策略判定函数。 | C1, C3, B2, B3 |
| `apps/web/src/ai/taskProjection.ts` | `TaskProjection` 只读投影（`isActive`/`isTerminal`/`needsFeedback`） | 缺少 `mutationClass`（`read_only` / `mutating` / `unknown`）与 `canSafelySupersede` 字段，无法区分只读覆盖与写操作保护。 | C3, B3 |
| `apps/web/src/ai/speech.ts` & `apps/local-api/src/speechStream.ts` | SSE/MSE 流式 TTS、`duckSpeech`/`unduckSpeech`/`pauseSpeech`/`confirmBargeIn`、`playbackLedger`（含 `playedMs`、`firstAudibleFrameMs`） | 基础能力较完整，可直接作为 B1/B2 的底层数据源；需配合上层协调器输出中断上下文。 | C1, C4, B2 |
| `apps/web/src/ai/presetFeedback.ts` & `shortFeedback.ts` | 路由预设短文案、16 条预录短语音、防伪造完成态正则拦截 | 已具备 C4 前端基础，后续需与后端契约对齐 `spokenSummary` 长度与纯口语约束。 | C4 |

> 说明：2026-11-14 报告中“语义打断未充分验证”属于尚未执行实测验证，不代表底层不具备该能力；本次工程落地先补齐端到端状态机、防抖、多轮会话、约束队列与单元测试，真机/真实供应商实测单独作为验收阶段。
