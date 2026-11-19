# C1「播报可随时打断」本地验收证据（2026-11-20）

> 真实数字来自：Windows SAPI 合成中文语音 → **真实 StepFun ASR**（`stepaudio-2.5-asr`，真实 key，脚本不落盘 key）→
> **真实 `classifyIntent` / `looksLikeSelfEcho` / `handleUserTranscript` / `fullDuplex` 播报分支**。
> 未经物理麦克风/扬声器，因此 ④ 的端到端是**估算值**（见下）。复跑步骤见 `work/asr-corpus/BARGEIN-REPRO.md`。

## 1. 结论总表

| 编号 | 标准 | 阈值 | 实测 | 判定 |
| --- | --- | --- | --- | --- |
| ① | 自回声不自打断（12 条助手 TTS 回灌） | 0 次 | 守卫拦截 12/12，生产播报分支停播 **0/12**（无守卫时 3/12 = 25% 会自打断） | 达标 |
| ② | 真实插话识别率（20 条） | ≥ 90% | 按 `classifyIntent` 四类意图 **11/20 = 55%**；按生产 fullDuplex 播报分支实际停播 **20/20 = 100%** | 题面定义不达标；生产行为达标（代价见 ③） |
| ③ | 误打断率（12 回声 + 20 真人旁人 + 5 反馈词） | ≤ 5% | 回声 **0/12 = 0%**；负样本按四类意图 **2/25 = 8%**；按生产分支实际停播 **22/25 = 88%** | 不达标 |
| ④ | 开口 → TTS 停播 | p95 ≤ 300ms | 声学第一响应 duck p95 ≈ 250ms（≤300ms，但只是压低音量）；**语义停播 p95 ≈ 3087ms**（p50 2228ms） | 按"停播"不达标 |

## 2. 方法

- 插话语料：20 条中文插话（"停一下""等一下，不是这个""不对，我说的是后天""取消刚才那个"…），
  Windows SAPI `Microsoft Huihui Desktop` 合成 16kHz/16bit/mono WAV，逐条经真实 StepFun ASR 转写。
- 负样本 A（自回声）：`work/asr-corpus/tts/*.wav`（12 条助手播报台词，真实 TTS）经真实 ASR 转写。
- 负样本 B（旁人/反馈词）：AISHELL-1 `train/S0002` 前 20 条真人语料 + 5 条反馈词（嗯/好的/对/嗯嗯/好）经真实 ASR 转写。
- 判定：把 ASR 文本喂给真实 `handleUserTranscript`/`classifyIntent`；再把同一条文本喂给真实
  `fullDuplex` 的 `onFinal` 播报分支（只替换音频设备、WebSocket 传输与 `<audio>` 元素），记录
  `duckSpeech` / `pauseSpeech` / `confirmBargeIn` / `dispatchCommand` 是否真的发生。
- ① 额外验证：`looksLikeSelfEcho(transcript, 正在播报的台词)` 在本轮新转写上仍全部为 true。

## 3. ② 插话意图分布与逐条结果

`classifyIntent` 命中 stop/cancel_task/new_constraint/new_topic：**11/20**（stop 4、cancel_task 3、new_topic 3、new_constraint 1），
其余 9 条为 `unknown`（例如"等一下，不是这个。""不对，我说的是后天。""先等一下，我看一下。"）。

生产分支对这 9 条 `unknown` 按"≥2 字有效指令"处理：`confirmBargeIn()` + `dispatchCommand()`，因此 20/20 都会停播。
也就是说 ② 的高分来自"任何不认识的句子都当新指令"，这正是 ③ 崩掉的原因。

## 4. ③ 负样本明细（真实 ASR 文本）

- 回声 12 条：守卫全部拦截（0 停播）。
- 真人旁人 20 条：2 条被判 `cancel_task`（"自6月底…率先宣布**取消**限购后"、"41 个已正式**取消**或变相放松了限购"），
  另 18 条 `unknown` 且在播报期被当作新指令 → **20/20 停播**。
  若任务正在执行，`cancel_task` 分支还会经 `onCancelTaskById` 取消后台任务，风险高于"只是停播"。
- 反馈词 5 条（真实 ASR 文本）：`好的` → `unknown` → 停播并派发新指令；`闻啊闻`（ASR 把"嗯嗯"识别成"闻啊闻"）→ 停播；
  `文`（ASR 把"嗯"识别成"文"）、`对`、`好` → 未停播（`文` 因长度 1 未过 ≥2 字门槛，`对`/`好` 是 backchannel）。
  即经典反馈词"好的"会误打断，"嗯"的正确性依赖 ASR 恰好输出"嗯"。

> 这与 `docs/moss-live-full-duplex-architecture-constraints.md` §4 的约束直接冲突：
> "VAD / 音量阈值只能作为声学候选信号，不能独立决定语义意图……关键词规则只能作为可解释 fallback"。
> 当前正是用关键词规则 + `unknown` 兜底承担语义判定，所以 ②（要"认出"）与 ③（要"忍住"）无法同时达标。

## 5. ④ 延迟分解（真实 fullDuplex 链路，设备/网络只替换不参与计时的部分）

| 阶段 | p50 | p95 | 来源 |
| --- | --- | --- | --- |
| VAD 起音（配置 160ms，被 2048 sample = 128ms AudioWorklet 包量化） | 192ms（相位扫描）/ 256ms（帧对齐） | 250ms | 真实 `createSpeechSegmentDetector` + 真实帧长 |
| duck 处理（压低音量，同步于起音） | 0.25ms（起音帧） | 逐帧处理最大 1.6ms（含 ASR 转发） | 真实 worklet 回调计时 |
| 用户说完 + hangover 提交（配置 500ms，帧量化 512ms） | 512ms | 512ms | 真实 detector 状态机 |
| 语句剩余时长（播完这句话） | 1280ms | 2176ms | 20 条插话实测 voicedMs |
| ASR 往返（commit → final，真实 StepFun） | 289ms | 913ms | 20 条实测（全 57 条 p50 309 / p95 524） |
| 语义判定 + `confirmBargeIn` 调用 | 0.07ms | 0.07ms | 真实 onFinal 分支计时 |
| **端到端（逐样本求和）** | **2228ms** | **3087ms** | min 1267ms / max 3788ms |

- ≤300ms 唯一能满足的是**第一响应 duck**：开口 → VAD 起音（p95 250ms）+ 同 tick 调 `duckSpeech()`（音量降到 20%）。
  它是"可听见的让位"，**不是停播**。
- 真正的 `confirmBargeIn()`（中止播放）只能在 ASR final 之后执行，而 final 必须等用户说完 + hangover + ASR 往返，
  因此端到端必然在秒级，**无法满足 300ms**。若产品要求 300ms 内真正静音，需要在 partial/声学层就执行可回滚的 stop，
  或把 300ms 定义为 duck 延迟。
- 明确标注：以上 ④ 为**估算值，非声学实测**（没有真实扬声器 → 麦克风回路，也没有真实房间混响/AEC 残余）。

## 6. 未测项

- 物理扬声器 ↔ 麦克风回路（AEC 开启/关闭、回声残余、device 延迟）与真实房间噪声、真实咳嗽声学样本（未合成）。
- 真实浏览器 Web 主入口 E2E（本机无麦克风权限；架构约束要求的主入口端到端行为未覆盖）。
- 仅单一 SAPI 音色（本机只安装 Huihui；Kangkang/Yaoyao 不可用），未覆盖多音色/多说话人。
- ASR 往返为直连 provider 实测，未含 local-api WebSocket 网关一跳（同机，历史实测 p50≈320ms 与本轮 289ms 同量级）。
- 费用/配额、跨区域抖动、并发下的延迟分布未测。

## 7. 自动化回归（本仓库内，无需 key）

- `apps/web/src/ai/__tests__/selfEcho.test.ts`：新增真实 ASR 文本回归 —— 12 条回声必须被守卫拦截；
  20 条真实插话与 25 条旁人/反馈词不得被守卫吞掉（守卫两个方向都锁住）。
- `apps/web/src/ai/__tests__/bargeInDecision.test.ts`：在真实 `fullDuplex` 链路上锁住
  "起音 256ms 先 duck、不 commit 不停播 → hangover 后 commit → ASR final 才停播"，
  以及自回声忽略、`对` 这类 backchannel 不停播。

