# VIVIC × MOSS-Live 实时交互架构约束

> **状态：当前有效的仓库级架构约束｜2026-11-14**
>
> 本文适用于 VIVIC 全双工语音、实时交互、前后台 Agent 协同及后续多模态扩展。所有相关 Agent、开发窗口和 Reviewer 开工前必须阅读。
>
> **研究依据：** 已直接核对 OpenMOSS/MOSS-Live 官方中文 README、官方实时音视频场景指南、官方实时 API Reference 与模型说明（2026-11-14）。本文按其公开架构和协议语义约束 VIVIC，不代表必须采购或接入 MOSS-Live 模型/API，也不复制其 SDK 或部署形态。
>
> 若旧语音文档、旧阶段报告与本文冲突，以本文、YU-401 当前授权和 YU-405 顶部 ONE-SHOT PRODUCT DELIVERY AUTHORITY 为准。本文不扩大任何付费、生产部署或数据留存授权。

## 1. 核心判断：不能把 MOSS-Live 简化成 ASR + VAD + TTS

MOSS-Live 公开的核心架构是：

**前台实时交互模型 + 协同层 + 后台模型 / Agent / 工具执行。**

- 前台实时交互模型负责连续倾听、理解、语义话轮、选择性注意、自然打断和语音交流。
- 后台模型 / Agent 负责复杂推理、工具调用和长程任务；它们在后台执行时，前台对话仍然持续。
- 协同层共享记忆、上下文和任务状态，管理委派、进度、结果和回传时机。

因此，单独完成麦克风采集、VAD、ASR、TTS、WebSocket 或关键词分类，并不等于完成 MOSS-Live 式全双工架构。

**VIVIC 的目标是复用这一架构分工，而不是把当前语音模块不断堆叠成一条更复杂的串行管线。**

### 1.1 架构对齐原则

1. 前台必须具备真正的实时交互决策能力。它可以由具备实时音频输入/输出和语义话轮能力的模型承担；也可以通过经过验证的兼容实现提供，但不能把单纯 VAD + 关键词规则包装成同等能力。
2. 后台业务 Agent 继续复用 VIVIC 现有 Agent / Host / Hosted Tasks / Space，不另造一套业务执行系统。
3. 协同层只协调 Session、Turn、Context、Playback、Delegation 和任务状态，不成为第二个业务 Agent。
4. 实时媒体协议、模型 Provider、业务执行协议分层；Provider 可替换，业务事实来源不能随 Provider 变化。
5. MOSS-Live 官方协议事件名是参考契约。VIVIC 内部可使用自己的类型和适配器，但必须保留相同的语义、身份关联、时序、回执和幂等保证。

## 2. VIVIC 目标架构：前台交互、协同、后台执行

| 架构层 | VIVIC 职责 | 必须负责 | 明确禁止 |
| --- | --- | --- | --- |
| 前台实时交互模型（Realtime Interaction Engine） | 实时语音/多模态模型适配层 | 持续听说、上下文理解、语义话轮、选择性注意、插话处理、实时文本与语音输出 | 独立写入业务 Space、绕过 Host 执行高风险工具 |
| 客户端媒体运行时（Client Audio Runtime） | AudioWorklet、PCM 采集、WebSocket 传输、播放器 | 持续采集、媒体帧发送、音频队列、实际播放进度、播放回执、资源释放 | 将媒体事件冒充业务意图；自行创建业务任务 |
| 实时协同层（Realtime Session Coordinator） | Session / Turn / Context / Playback / Delegation 协调 | 身份映射、事件顺序、上下文提交、任务委派映射、进度回传、UI 投影、重连恢复 | 另建第二套业务任务数据库、队列或 Agent |
| 后台业务执行层（Existing VIVIC Agent + Host） | 现有 Agent、Tool Calls、ActionEnvelope、Hosted Tasks、Space | 复杂推理、工具调用、业务读写、长任务、真实回执、持久化 | 被前台实时模型替代；被新的平行业务系统分流 |

### 2.1 单一事实来源

- **业务决策与工具执行：** 现有 VIVIC Agent / Host。
- **任务生命周期：** Hosted Tasks。
- **业务数据：** Space 及其现有版本 / 幂等契约。
- **实时交互状态：** Realtime Session Coordinator 管理的 Session / Turn / Playback / Delegation 状态。
- **界面状态：** 真实后端状态的只读投影，不是新的事实来源。

前台实时交互模型负责自然交流和实时话轮；后台 Agent 负责复杂业务执行。前台若产生需要后台处理的目标，应经协调层委派给现有 Agent / Host。业务写入仍由现有 Host 授权和执行。

### 2.2 身份不可混用

至少区分并显式关联：

- `sessionId`：实时会话；
- `inputTurnId`：用户输入话轮；
- `ownerTurnId`：触发后台委派的前台回复话轮关联标识；
- `runId`：一段模型输出；
- `outputTurnId`：模型回复话轮；
- `chunkId`：媒体片段；
- `delegationId`：前台模型委派给后台的任务标识；
- `hostedTaskId` / `requestId`：VIVIC 现有后台任务和请求标识；
- `eventId` / `seq`：事件去重和顺序。

不得把 `ownerTurnId` 当作用户输入 turn，不得把 `delegationId` 当作 Hosted Task ID，除非存在显式、持久、可验证的映射。不得把 requestId、taskId、runId 互相代用。

## 3. 实时媒体链路：连续输入与真实播放回执

### 3.1 上行音频

MOSS-Live 官方实时协议的基本模式：

- 通过持续 WebSocket Session 传输音频，而不是每段语音录完后上传一个 WAV 文件。
- 默认上行是 16 kHz、单声道、无文件头 PCM S16LE 二进制帧，按实时速度连续发送。
- 用户停止说话后仍持续发送静音帧，供前台模型判断停顿和话轮。
- **AI 播放期间仍持续采集和发送麦克风音频。**
- 浏览器应用通过服务端中继媒体和事件；Provider API Key 只留在服务端。

VIVIC 必须达到相同的连续输入语义。Provider 的采样率或编码可以由 Adapter 转换，但不能把分段 WAV + `POST /api/transcribe` 称为持续流式 ASR 或 MOSS-Live 级全双工。

### 3.2 用户转写事件

MOSS-Live 的语义包括：

- `input.transcript.updated`：当前输入片段的完整文本快照；更新时覆盖展示，不逐次拼接。
- `stable_text`：当前已稳定、不再变化的文本部分。
- `input.transcript.done`：当前输入片段的最终文本。
- `input.transcript.revised`：修订已经确认的历史输入，按原 `turn` 更新，不新增一条用户消息。

VIVIC 的 Working Context 可接收 partial / stable text；只有稳定 final 或经过明确确认的内容才能进入 Committed Context 或触发业务 Agent。历史文本修订必须更新原 turn，不能重复写入或重复派发。

### 3.3 下行音频与 Playback Ledger

MOSS-Live 通过事件和二进制帧配对：

1. `response.audio.started` 标识一段回复开始；
2. `response.audio.context` 提供 `run_id`、`turn_id`、`chunk_id`，与紧随其后的二进制音频片段配对；
3. 客户端按顺序排队和播放；
4. 每个片段**实际完整播放**后，才发送 `playback.chunk.completed`；
5. 收到 `response.audio.done` 只代表服务端已经发送完音频；只有本地对应音频也全部实际播放完成后，才发送 `playback.completed`。

收到 `response.audio.stop` 时：

- 只停止对应 `run_id` + `turn_id`；
- 清空该回复尚未播放的音频队列；
- 先确认已完整播放的 chunk；
- 再发送 `playback.stopped`，并按真实播放进度报告当前未完成 chunk 的 `played_audio_ms`。

播放回执必须来自真实播放器进度，不能以网络收到、SourceBuffer append、updateend、服务端 done 或 UI 状态冒充用户已经听到。没有词级时间对齐时，VIVIC 只能按可验证的句段 / chunk 边界恢复，不得声称精准到词。

## 4. 语义话轮、选择性注意与打断

MOSS-Live 的关键能力不是“检测到声音就停”，而是前台实时交互模型结合上下文判断：

- 用户是否正在对助手说话；
- 是简短附和、思考停顿还是正式接管话轮；
- 是背景语音、旁人交谈、导航或媒体声音；
- 是补充约束、纠正、切换话题，还是明确取消后台任务；
- 被打断后应该回应什么，以及何时恢复原有话题。

VAD / 音量阈值只能作为声学候选信号，不能独立决定语义意图。固定静音阈值也不能成为唯一 turn-end 规则。关键词规则只能作为可解释 fallback，不能作为 MOSS-Live 级语义交互已经完成的证据。

### 4.1 动作语义必须分开

| 交互意图 | 前台模型 / 播放器动作 | 后台业务任务动作 |
| --- | --- | --- |
| backchannel / 简短附和 | 保持倾听，通常继续播放 | 不变 |
| thinking pause / 犹豫停顿 | 不抢话，继续等待 | 不变 |
| not-addressed / background speech | 不接话；按模型状态恢复原输出 | 不变 |
| user interruption / 接管话轮 | 停止指定回复，清空对应待播音频，处理新输入 | 不自动取消后台任务 |
| new constraint / correction | 更新 Working Context，明确关联原话题 / task | 不得默认 abort 原任务、创建新 task 或重复 dispatch |
| new topic | 建立新输入话轮，保留必要历史上下文 | 原任务按实际执行阶段继续或等待明确处理 |
| explicit task cancellation | 停止相关输出并确认取消意图 | 通过现有 Host / Hosted Tasks 取消，等待真实回执 |
| uncertain / ASR 不稳定 | 保守等待或澄清 | 不执行破坏性动作 |

**三种状态严格正交：**

1. 前台回复 / 音频输出是否停止；
2. 当前实时会话 / 话轮是否结束或切换；
3. 后台 Hosted Task 是否取消、继续或完成。

MOSS-Live 的 `response.audio.stop` 是指定回复的媒体控制，不等于后台委派取消；`session.delegation.cancel` 才是对后台委派的取消请求。在 VIVIC 中，后台业务取消必须落到现有 Host / Hosted Tasks 取消接口，并等待真实回执。

## 5. 前后台委派与上下文协同

### 5.1 MOSS-Live 公开的委派模式

MOSS-Live 在 `attach_session` 中通过 `delegation: { type: "client" }` 启用客户端后台委派。会话建立后，前台模型可以发出 `session.delegation.created`，其中包含：

- `delegation.id`：本次委派的标识；
- `objective`：任务目标；
- `context`：近期对话上下文；
- `owner_turn_id`：触发委派的回复话轮关联标识；
- `purpose`：`task` 或 `reasoning`；
- `timeout_ms`：当前回复等待后台结果的时间，不是后台任务自身的执行超时。

应用保存委派标识并异步执行；后台运行期间，实时音频会话继续工作。

### 5.2 进度、结果与取消

MOSS-Live 提供的回传语义：

- `session.thinking.append`：静默回传事实或进度，供后续回答使用；
- `session.commentary.append`：向用户表达可播报的进度或最终成功 / 失败结果；
- `session.instructions.append`：追加后续会话指令；
- `session.delegation.cancel`：请求取消指定委派；
- `session.delegation.cancelled`：确认委派已标记取消，应用停止执行器并丢弃迟到结果。

回传事件应带 `delegation_id`；重试复用相同 `event_id` 和相同载荷。取消通知不等于执行器已经停止；已发生的业务副作用由应用自己的业务系统处理。

### 5.3 VIVIC 的映射规则

- 将 `delegationId` 显式映射到现有 Hosted Task / requestId，不另建任务数据库或 Worker Queue。
- 后台复杂推理、工具调用、业务写入全部复用现有 VIVIC Agent / Host。
- 任务进度、结果和失败原因从 Hosted Tasks / Space 的真实事实读取；前台不能自行宣称成功。
- 只有 Hosted Tasks 的真实 `succeeded` receipt 才能播报“已完成”。
- `failed`、`unknown`、`awaiting_clarification` 必须如实表达，不能推断成功。
- 重复委派、重连、事件重放不得重复 dispatch、重复建卡或重复写入。
- 不把 MOSS-Live 的 `session.*append` 机械复制成第二套 VIVIC 业务存储；只保留必要的适配和回执语义。

### 5.4 VIVIC Context 分层

以下是 VIVIC 为保证既有业务一致性增加的内部约束，不应误称为 MOSS-Live 公共 API 字段：

- **Working Context**：当前 session / turn 的 partial、候选意图、新约束、临时状态。
- **Committed Context**：稳定 final、已确认意图、已提交的任务变更和可追溯事实。

Partial 不得直接写入 Committed Context 或业务数据。新约束必须保留原文、来源、session / turn / taskId 关联；处理方式取决于 Hosted Task 当前真实阶段，不能只暂停语音后丢失约束。

## 6. Session、重连与安全

- 新连接完成 WebSocket 握手后，先 attach / 恢复 session，再启用媒体输入。
- MOSS-Live 的重连方式要求先断开旧连接，再使用原 `session_id`、相同稳定 user 和原创建选项恢复；应用自行保留后台任务和工具执行记录。
- 重连后重新确认媒体配置；旧 socket、旧 turn、旧 run 和迟到回调不得覆盖新状态。
- VIVIC 重连恢复 Session / UI / Playback / Task Projection，不重放已经提交的业务写操作；任务状态通过 requestId、taskId、receipt 和 Space version 查询。
- 服务端负责 Provider Key；浏览器、截图、日志、仓库、Linear、Notion 和 Agent 回传中不得出现 API Key 或原始凭证。
- 默认不留存原始音频；麦克风授权、关闭和资源释放必须可见、可验证。
- 视频 / 屏幕输入是 MOSS-Live 的扩展能力，不属于当前 P3 必须实现范围；只有语音核心稳定后，按既有 P6 另行评估。

## 7. 当前 VIVIC 代码真值：2026-11-15 独立 Review

本节以实际读取的 GitHub 分支代码为准，不接受 Agent 自报状态替代。当前审计分支 `codex/full-duplex-w0`，HEAD：`edb53fda2037dce39586544d773fb5d5edcb4ce3`；相对 canonical `codex/live-backend-20261103`（`15684b0c9e34baff10ae886b923481caac26c31b`）ahead 49 / behind 0。

### 7.1 已经真实实现

- 浏览器通过 `getUserMedia + AudioWorklet` 持续采集麦克风；AI 播放期间仍保持采集。
- 本地能量 VAD 以 RMS 阈值识别 speech candidate；在候选语音开始时对当前 TTS 做 ducking。
- VAD 结束后可以把当前音频段编码成 WAV，调用 `POST /api/transcribe` 获取文本。
- 有基于文本正则的 stop / cancel / continue / new_topic / new_constraint / backchannel 分类。
- stop 输出路径会终止当前 TTS；cancel_task 额外按 taskId 请求现有取消接口。
- new_constraint / new_topic 会暂停当前语音；`resumeSpeech` 会等待浏览器 `audio.play()` Promise settle 后更新 SpeechSnapshot。
- 已有基础 taskId 绑定、取消身份比较，以及只读 TaskProjection 类型定义。

### 7.2 尚未实现：不能宣称 MOSS-Live 级实时交互已完成

1. **没有持续流式 ASR / partial。** `fullDuplex.ts` 仍以 `SILENCE_END_MS = 700` 作为分段结束条件，之后才把完整片段编码为 WAV 并请求 `POST /api/transcribe`。当前没有将 PR #8 的 WebSocket Gateway / 原生 partial / final 事件接入该前台链路。它证明了播放期间并行采集 + 静音后批式转写，不满足“无需等用户说完或静音后才开始处理”。
2. **没有 MOSS-Live 前台语义交互模型。** `turnTaking.ts` 仍是关键词 / 正则分类，没有上下文、受话人、当前委派状态或回声来源判断；VAD 只提供能量候选。
3. **new_constraint / new_topic 会丢失输入。** 在 AI 正在播放的分支中，`handleUserTranscript(text)` 只暂停当前语音；调用方没有将该 transcript 送到 `onCommand`，也没有追加到原 Hosted Task 的上下文。避免取消原任务是正确方向，但没有把新约束真正交给原任务，不构成任务一致性闭环。
4. **ducking 恢复有缺陷。** `fullDuplex.ts` 对 backchannel / irrelevant / unknown 分支没有调用 `unduckSpeech()`，可能导致播放音量一直保持降低；`duckSpeech()` 每次调用都会用当前音量覆盖保存值，连续分段再次 duck 会逐次降低基准音量，后续 unduck 无法恢复最初音量。停止监听时也没有显式保证恢复音量。
5. **播放回执不够完整。** `playedMs` 是媒体时间位置，不是已完整播放的 chunk 回执；当前没有将 `runId / turnId / chunkId` 与实际播放完成事件逐块关联。不能据此证明用户实际听到了哪些文本片段。
6. **TaskProjection 未接入运行时。** `taskProjection.ts` 仍是纯转换 helper；当前主链没有读取真实 Hosted Tasks 状态、receipt 和 version，也没有由其驱动前台状态。
7. **续播状态仍有异步竞态。** `resumeSpeech` 内部在 `play()` Promise settle 后更新 SpeechSnapshot，但 `resumeFromPause` 会因为同步返回 true 而立即清除 paused 状态并更新 TurnTakingState；若 Promise 后续 reject，两套状态可能短暂或持续不一致。
8. **取消幂等尚未被证实。** ControlApp 显式取消时 abort 本地 controller 并调用 `cancelDecisionTask`；`runDecisionTask` 的 finally 在未 finished 时还会 best-effort 再发一次 cancel。需要验证服务端对同一 taskId 的重复取消幂等，或收敛成单一取消请求路径。
9. **当前 E2E 证据不足。** `fullDuplex.spec.ts` 只打开页面、点击开关、等待并断言状态条可见且不包含“错误”；虽然注册了 `/api/transcribe` mock，但没有断言该 endpoint 被调用，也没有验证真实音频帧、意图结果、TTS 中断、任务状态或恢复。因此不能把 T4 / T7 / T8 / T9 / E1 / E4 / E6 / E8 标成 E2E 已通过。单测只有 7 个分类断言，也不验证状态转换。
10. **本轮改动口径需区分累计代码与本轮增量。** 从此前已审计基线 `c7bf6626096bd3026ca2fe4dd6c4b055f46c463c` 到本次 `edb53fda`，净变化仅 8 个文件：AGENTS、README_FIRST、fullDuplex、speech、E2E、handoff、docs index 和本架构文档。ControlApp、ChatPage、decisionTask、turnTaking、taskProjection 等实现早已存在于 c7 基线，不是本轮新增。不能把累计实现列表当作本轮交付清单。
11. **测试摘要未完成独立复核。** “22 failed / 839 passed、4 个预存 typecheck 错误”目前只有文字回报，没有与基线绑定的原始命令、完整 stdout / stderr 和 commit SHA 对照，因此仅记为 Agent 报告，不能视为独立验收证据。

### 7.3 本次独立结论

**P3 不通过 / 保持 In Progress**

当前准确描述：**VIVIC 已实现播放期间麦克风并行采集、能量 VAD、700ms 静音后的批式 ASR、规则意图分类和基础 TTS duck / pause / resume。尚未实现 MOSS-Live 对齐的前台实时语义交互模型、持续 partial ASR、可靠播放块回执、补充约束进入原任务、真实 Hosted Task Projection 和端到端恢复。**

这不是简单补几个边缘 bug 就能通过的产品验收。必须把 P3 重新聚焦为一条真实用户闭环：实时语音输入 → 及时语义判断 → 正确控制播放 → 必要时将新约束委派给既有 Agent / Host → 从真实任务状态与播放事实恢复。不能用“ASR 批式是设计选择”豁免原始实时交互目标。

### 7.4 2026-11-15｜ee9fe37 WebSocket 集成独立 Review

审查对象：代码提交 `ee9fe37ed07cd6fef7307c75a52d43cb9f20ec8a`。相对上一轮已审代码 `edb53fda2037dce39586544d773fb5d5edcb4ce3`，新增业务代码仅 3 个文件：`asrGatewayClient.ts`、`fullDuplex.ts`、`vite.config.ts`；`speech.ts`、`turnTaking.ts`、`ControlApp.tsx`、`decisionTask.ts`、`taskProjection.ts`、E2E 测试并未在本轮代码增量中改变。相对 canonical `15684b0c9e34baff10ae886b923481caac26c31b`，分支累计 ahead 53 / behind 0。

#### 7.4.1 协议级阻断：当前 WebSocket 客户端无法成功建立 Gateway Session

- `apps/local-api/src/asrGateway.ts::handleMessage` 在解析每一条入站消息前强制检查 `protocolVersion === ASR_TRANSPORT_VERSION`；缺失时直接返回 `InvalidFormat`，不进入消息处理。
- `apps/web/src/ai/asrGatewayClient.ts` 发出的 `session.start` 与 `audio.chunk` 均未携带 `protocolVersion`。因此当前客户端消息必然被 Gateway 拒绝，不能创建有效 Session，也不能接收有效 ASR 流。
- 客户端 `onmessage` 不处理 `type: "error"`；`connect()` 只能在收到 `session.started`、WebSocket error 或 5 秒定时器时 resolve。服务端协议错误不会被转成可见错误或调用 `onError`。
- `fullDuplex.ts` 在 `connect()` 返回 false 后仅将 `gatewayClient` 设为 null，随后仍设置 `enabled=true` 并显示 listening；没有 fail-closed，也没有关闭失败连接。故 UI 的 listening 不能证明 Gateway 已连接。

#### 7.4.2 Final 事件链路没有闭合

- `MockAsrProvider` 的 partial 由音频 chunk 到达后的定时器触发；final 只在 `provider.commit()` 后产生。
- Gateway 通过 `session.end` 事件调用 `provider.commit()`；协议定义的客户端结束消息是 `session.end`，没有 `audio.commit` 类型。
- `AsrGatewayClient.commit()` 发送的是 `audio.commit`，且 `fullDuplex.ts` 根本没有在 VAD / turn-end 时调用该方法或发送 `session.end`。当前没有可靠的 utterance-end → final 触发路径。
- 因此不能声称稳定 ASR Final 已接入 turn controller；即使先修复 protocolVersion，Final 仍无法按当前客户端代码正常闭合。

#### 7.4.3 当前 Provider 是 Mock，不是真实语音识别

- 客户端把 `provider: "mock"` 写死。
- `asrGatewayServer.ts` 创建 Gateway 时没有注入 `providerFactory`，Gateway 默认创建 `MockAsrProvider`。
- Mock Provider 生成的是 `词1词2词3...` 这类合成文本，不会根据音频内容识别语音。当前没有 StepFun / 离线 ASR Provider 的实际适配和运行证据。
- 这可以证明 Gateway Mock 事件机制，不可以证明真实音频识别或真实 ASR 语义动作。

#### 7.4.4 认证凭据与安全 Gate 不通过

- `fullDuplex.ts::getAsrToken` 将 Gateway bearer fallback 硬编码在前端源代码中，并通过 WebSocket URL query 参数传递。
- 服务端 `asrGatewayServer.ts` 校验的是 `loadConfig().token`，即 `VIVIC_LOCAL_TOKEN` / 本地 `.env.local` 中生成的随机值；Vite 仅为 `/api` 代理注入该 token，没有为 `/asr` 注入认证头。仓库也没有找到设置 `vivic.asr.token` 的代码，Vite 配置没有开放 `VIVIC_ASR_TOKEN` 的 `envPrefix`。
- 因而前端 fallback 与服务端随机 token 没有可靠绑定，默认连接可能在 Upgrade 阶段即被 401 拒绝；即使本机通过手工配置恰好匹配，提交 bearer 到前端 bundle / URL 仍不满足原有“服务端持有本地凭据”的安全约束。
- 必须移除前端硬编码凭据，建立只在服务端代理侧完成的认证，并按 YU-405 安全 Gate 验证旧 token 失效、新 token 有效；不得把凭据写入评论或测试产物。

#### 7.4.5 产品行为仍未闭环

1. **new_constraint / new_topic 仍丢失。** AI 正在播放时 `onFinal` 调用 `handleUserTranscript`，该函数只暂停当前 TTS；随后本分支只 `unduckSpeech()`，没有调用 `onCommand`，也没有把文本追加给原 Hosted Task。AI 未播放时则会走 `onCommand(text)`，可能创建新任务，而不是按任务阶段修订原任务。
2. **意图仍是关键词规则。** `turnTaking.ts` 没有本轮变更，仍用正则区分 stop / cancel / continue / new_constraint 等，没有受话人、上下文和 uncertain 语义策略。
3. **TaskProjection 仍未接入。** `fullDuplex.ts` 和 `ControlApp.tsx` 没有消费 `taskProjection.ts`；没有真实 Hosted Tasks / Space status、receipt、version 的 UI 投影。
4. **Ducking 重复调用问题仍存在。** `speech.ts::duckSpeech` 每次都把当前音量重新保存为恢复值；重复 duck 会覆盖原始音量。它在本轮没有改动。播放 Promise settle 后的 SpeechSnapshot 更新也没有与 `resumeFromPause` 的同步 TurnTakingState 更新统一成一个异步状态事务。
5. **没有 reconnect。** `AsrGatewayClient.onclose` 只把 `ws` 设为 null，没有重连、session resume 或状态回调；generation token 只能丢弃 stale callback，不能证明 E8 reconnect 行为。
6. **E2E 仍是旧 smoke。** `fullDuplex.spec.ts` 没有修改，仍拦截已弃用的 `/api/transcribe`，只检查按钮和状态条可见且不含“错误”；不验证 `/asr` WebSocket、协议版本、鉴权、音频 chunk、partial/final、turn action 或 Task receipt。
7. **CI 无证据。** 对 `ee9fe37` 查询 GitHub Actions workflow runs 和 combined status 均为空；本地测试汇总未附绑定此 SHA 的原始日志，不能作为独立验收证据。

#### 7.4.6 当前裁定

**P3 不通过 / 保持 In Progress。** 本轮增加了一个 WebSocket 客户端模块和前端接线尝试，但按当前源码，Gateway 握手协议不匹配、认证未可靠接通、Final 没有结束事件、Provider 固定为 Mock；new_constraint、TaskProjection、播放状态和 reconnect 仍未闭环。回传中的“WebSocket 连续流式 ASR / Partial-Final E2E PASS / E8 reconnect PASS”均不成立。

已接受的 P1 TTS 与 P2 Gateway Stage A 工程成果不撤销；但 P2 Gateway Mock Stage A 的通过不等于本轮前端 Gateway 集成通过。PR #7 / #8 仍为 Draft、未合并；不得合并 canonical、部署线上或扩大真实付费调用。

后续仍只使用 YU-405 顶部 ONE-SHOT PRODUCT DELIVERY AUTHORITY，在同一 W0 内一次性解决协议、服务端认证代理、真实/离线 Provider、utterance finalization、语义委派、TaskProjection、播放状态与 reconnect，并提交真正覆盖行为的 E2E 和原始日志。不要新建 Issue，也不要再回传模块清单。

## 8. 现有 Linear 任务与执行顺序

不得另起一套任务或重复创建 Issue。复用：

1. [YU-402｜Canonical Branch × Deployment Truth × Voice Contract Audit](https://linear.app/yi383775/issue/YU-402)
2. [YU-403｜Streaming TTS Player × Playback Ledger](https://linear.app/yi383775/issue/YU-403)
3. [YU-404｜Continuous ASR × Authenticated Realtime Session Gateway](https://linear.app/yi383775/issue/YU-404)
4. [YU-405｜Full-duplex Turn-taking × Barge-in × Resume](https://linear.app/yi383775/issue/YU-405)
5. [YU-406｜Realtime Coordinator × Existing Agent / Hosted Tasks](https://linear.app/yi383775/issue/YU-406)
6. [YU-407｜Reconnect × Observability × Privacy × Release Gate](https://linear.app/yi383775/issue/YU-407)

当前 P3 以 YU-405 顶部 2026-11-14 的 ONE-SHOT PRODUCT DELIVERY AUTHORITY 为唯一执行任务包。W0 自主组织 Lane A / B / C 并行，统一接口并完成真实 Web 主入口集成；Lane C 只做 YU-406 所需的只读任务状态接入切片，不提前重建完整 P4。

### YU-405 产品级 Exit Gate

必须在真实 VIVIC Web 主入口证明：

- TTS 播放期间麦克风持续采集；同一实时会话内得到有来源可区分的 partial / final；
- 前台能够区分附和、思考停顿、背景语音、明确打断、补充约束和明确任务取消；
- partial 不触发业务 Agent 或不可逆写入；
- stop_output 只停止指定输出，原 Hosted Task 继续；explicit_cancel_task 才通过现有 Host 取消并等待真实回执；
- new_constraint 不丢失、不无条件 abort 原任务、不重复 dispatch；
- 播放状态等待 `audio.play()` Promise settle；实际播放回执基于客户端播放进度；
- 至少两次连续打断和续说，没有旧音残留、错误续播或错任务取消；
- Task Projection 消费真实 Hosted Tasks / Space 状态、receipt、version 和 taskId；
- 至少覆盖 YU-405 指定的 T4 / T7 / T8 / T9 / E1 / E4 / E6 / E8；补充背景语音、旁人对话、导航音、回声、无关语音和相同音量不同语义的反例；
- 真实浏览器 E2E、确定性 Mock 测试和至少一个来源明确的真实 / 离线语音识别证据；Mock 不得冒充真实 Provider；
- 提供最新代码 SHA、测试源码、原始命令与输出、播放进度 / 静音延迟、真实 Hosted Task 状态与 receipt、未覆盖 Gate。

不得用按钮可见、模块单测、Mock happy path、旧测试计数或 Agent 自报 PASS 代替产品验收。

## 9. 费用、安全与发布边界

- 本文不授权接入或调用 MOSS-Live 商业 API，不授权新 Provider 订阅或任何新增付费。
- YU-401 最新授权记录：StepFun TTS 首轮最多 3 次、每次不超过 60 个汉字，已有 2/3 次使用记录；如确需再次调用，**最多剩余 1 次**，且必须先核对本地 API Key、余额、实际模型和计费。禁止自动重试、并发压测、充值或开通新订阅。
- ASR 优先使用免费、离线或 Mock 路径；不得自行新增付费 ASR 调用。
- 真实调用无法确认费用或额度时停止，继续离线 / Mock 验证。
- YU-401 曾记录本地 Gateway dev token 暴露风险；必须在本地证明旧 token 已失效、新 token 有效。只回传轮换验证结果，不回传凭证。
- **严禁部署或变更线上 / 云端服务器、生产 DNS、反代、生产数据库、线上配置或正式发布。** 生产发布必须另获用户明确授权。
- 不采集长期原始音频，不引入声纹或默认长期旁听。

## 10. 每次开发与 Review 的强制问题

每次改动必须回答：

1. 本次改动实现 MOSS-Live 哪一项明确职责：前台实时交互、协同、后台执行，还是媒体运行时？
2. 它对应 YU-405 哪个现有 Gate？为什么没有另建业务 Agent、任务库或队列？
3. 证明的是 Mock、离线、真实 Provider，还是真实 Web 产品 E2E？
4. 是否保留了 session / turn / run / chunk / delegation / task 身份映射？
5. 任务是否只有一个真实事实来源？播放回执是否来自真实播放进度？
6. 测试绑定哪个 commit SHA？原始命令、输出和测试源码在哪里？
7. 哪些 Exit Gate 已通过、哪些仍未通过？不能把未验证写成完成。

Coordinator 必须先检查最新仓库分支、SHA、PR、Linear 现有授权和实际入口，再派发；完成后独立检查代码、测试、真实状态、副作用和证据。

## 官方架构与协议依据

- [OpenMOSS / MOSS-Live README（中文）](https://github.com/OpenMOSS/MOSS-Live/blob/main/README.zh-CN.md)：前台交互模型、后台模型与协同层的公开架构。
- [MOSS-Live 实时音视频场景指南](https://platform.moss.cn/docs/scenarios/moss-live/)：持续音频输入、播放期间持续采集、播放回执和打断处理。
- [MOSS-Live 创建实时对话 API Reference](https://platform.moss.cn/docs/reference/moss-live/)：Session、媒体协议、transcript、Playback、Delegation、取消、重连和幂等事件契约。
- [MOSS-Live 模型说明](https://platform.moss.cn/docs/models/moss-live/)：模型能力和实时交互接口。
- [YU-401｜VIVIC MOSS-Live 级全双工实时交互](https://linear.app/yi383775/issue/YU-401)
- [YU-405｜P3 产品级集成与验收](https://linear.app/yi383775/issue/YU-405)
