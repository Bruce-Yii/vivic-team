# VIVIC 全双工｜两天攻坚验收报告（交给队友）

> 日期：2026-11-20
> 仓库：`Bruce-Yii/vivic-team`（**Public**）
> 分支：`main`，本文基线 SHA：`847064172f91cfebedbe4f1c3f27299735111e01`
> 范围：任务型轻量全双工（C1–C4 + 工程边界 B1–B4），不含部署与线上变更

---

## 1. 目标：四大核心能力

| 编号 | 能力 | 含义 |
|---|---|---|
| **C1** | 播报可随时打断（Barge-in） | 助手说话时用户开口即打断，且不被环境声/自己的回声误触发 |
| **C2** | 边说边传 + 流式 ASR | 16kHz PCM 持续推流、partial 字幕、多轮连续、断连恢复 |
| **C3** | 执行期可追问、可覆盖（状态双工） | 任务执行中可下新指令/追加约束；状态来自真实 Host 回执 |
| **C4** | 短语音反馈 + 卡片承载 | 语音只做状态确认，细节交卡片 |

配套边界：B1 UI 联动打断、B2 按 `playedMs` 截断上下文、B3 写操作安全取消、B4 统一状态机 + `resumeSessionId`。

---

## 2. 验收标准与实测数据

**测量环境**：Windows + PowerShell 7，本机真实调用 StepFun ASR / DeepSeek / StepFun TTS，无物理麦克风（全部注入式或合成音频）。

### C1 打断

| 标准 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| ① 自回声不自打断 | 0 次 | 12 条助手播报经真实 ASR → 守卫拦截 **12/12**，生产停播 **0/12** | ✅ |
| ② 真实插话识别率 | ≥ 90% | 20 条合成中文插话 → 真实 ASR → 真实策略：**100%（20/20）** | ✅ |
| ③ 环境误打断率 | ≤ 5% | 37 条环境声（12 自播报 + 20 真人 AISHELL + 5 反馈词）：**2.7%（1/37）** | ✅ |
| ④ 开口→停播延迟 | p95 ≤ 300ms | duck 首响应 **250–256ms**；真正 `confirmBargeIn` 停播 **p50 2228ms / p95 3087ms** | ❌ |

④ 延迟构成：VAD 起音 192–256ms → duck 0.25ms → 用户说完 + hangover 512ms → 语句剩余 1280ms → ASR 往返 p50 289ms/p95 913ms → 判定 0.07ms。

> 结论：**"音量压低"能进 300ms，"真正静音"不能**。要进 300ms 需要在 partial 层做可回滚 stop，属架构改动。

### C2 流式 ASR / 多轮 / 断连恢复

| 标准 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| ① 真人 CER（干净） | ≤ 8% | AISHELL-1 真人 50 条：原始 **2.81%**，去 ITN 格式差异后 **0.25%**，完全一致 96% | ✅ |
| ② 噪声 CER（SNR 15dB） | ≤ 20% | 同批语料叠白噪声：**0.25%**（与干净一致） | ✅（弱证据，白噪声≠人声嘈杂） |
| ③ final 延迟 | p95 ≤ 800ms | 真实网关：**p50 321ms / p95 375–411ms** | ✅ |
| ④ 连续 10 轮 | 无丢帧/卡死 | **10/10 出 final，错误帧 0**，每轮新 sessionId，转写逐条正确 | ✅ |
| ⑤ 断连恢复 | 丢字 ≤ 1 句 | resume 后**成功产出 final、0 错误帧**，断连前 29 帧与续传音频一起转写 | ✅ |

> ⑤ 修复根因：`StepfunAsrProvider.reset()` 只清 `cancelled` 不清 `closed`，导致 resume 后所有音频被静默丢弃 → 改为 **ack token** 机制 + reset 重开 + 保留断连前缓冲。

### C3 状态双工

| 标准 | 结论 | 证据 |
|---|---|---|
| ① 执行期约束入队并影响下次规划 | ✅ | `decideInterjection`：有新约束且任务活跃 → 入队不派发；下次 dispatch 消费并清空 |
| ② 只读任务可覆盖、不重复执行 | ✅ | cancel 恰 1 次、dispatch 恰 1 次（原子断言） |
| ③ 写任务不被静默取消 | ✅ | 有 `executionId` 的写任务：不 cancel；新话题仅派发一次且 `cancelRunning:false`；显式取消才生效 |
| ④ 状态来自真实 Host 回执 | ✅ | 真实 `/api/intent` 返回服务端自增 `step`、`exec_<UUID>` 的 `executionId`、`canvasVersion`、`clarification`；伪造回执被拒；重放返回存储版本（请求 9 → 存储 7） |

新增 14 条验收测试 + `interjection.ts` 纯策略抽出（测试断言的就是生产同一份代码）。

### C4 语音反馈与卡片

| 标准 | 阈值 | 实测 | 结论 |
|---|---|---|---|
| ① 建卡/动作成功率 | ≥ 95% | N=20：HTTP 200 **20/20**、envelope **20/20**、建卡类实际建卡 **12/12** | ✅ |
| ② 首音延迟 | p50 ≤ 800 / p95 ≤ 1500ms | 模型段 p50 **741**/p95 1193ms + TTS 首包 p50 **497**/p95 660ms = **p50 1238 / p95 1853ms** | ❌ |
| ③ 语音只播一句话 | 一句话 | 建卡类 12/12 只播 5–16 字 ✅；闲聊/问答整段朗读（最长 96 字），>40 字占 10% | ⚠️ |
| ④ 卡片承载细节 | — | 细节在卡片 **12/12**；语音复述卡片正文 1/12 | ✅ |

> 分路径：确定性规则路径合计 p50 **502ms 达标**；模型规划路径合计 p50 **1242ms 不达标**。

---

## 3. 这两天修掉的真 Bug（不是测试债）

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| 1 | `StepfunAsrProvider.reset()` 未清 `closed` | 断连重连后**永久失聪**，续传音频被丢弃 | ack token + reset 重开 + 保留缓冲（PR #19） |
| 2 | 播报期任何 ≥2 字未分类文本都打断 | **环境人声误停 88%**（电视/旁人/反馈词都停） | 未分类不停播 + 关键词要求短句 + 指令形态放行（PR #24） |
| 3 | 自回声无守卫 | 助手**自己打断自己** 25%，含把自己任务取消 | `looksLikeSelfEcho()` 文本层守卫（PR #17） |
| 4 | 网关 ASR 用 Coding-Plan base | 普通 key 请求 `/step_plan/v1/audio/asr/sse` **404** | 新增 `STEPFUN_API_BASE_URL`，env-key 路径改 `/v1`（PR #16） |
| 5 | 主模型默认 StepFun plan | 普通 key 调 `/api/intent` **400** | 默认 `/v1`；plan 仅显式 opt-in（PR #18） |
| 6 | `createOnlineSessionApp` 从不传 `mainProvider` | `VIVIC_MAIN_PROVIDER` 在线上模式**完全失效** | 补齐 provider 环境契约（PR #20） |
| 7 | `findForRole("main")` 让 StepFun 种子行永久压制用户后保存的主模型 | 用户设置 DeepSeek **不生效** | 改为"专用角色优先、其次最新"，并解耦语音回退（PR #14） |
| 8 | 主模型默认改 DeepSeek | StepFun p50 1280ms / 最大 2791ms | DeepSeek p50 **454ms** / 最大 489ms（PR #20） |
| 9 | TaskProjection 丢弃真实回执字段 | 状态是前端自己猜的 | 消费 `step`/`executionId`/`canvasVersion` + 乱序保护（PR #15） |
| 10 | `DataActions` 清空画布丢守卫 | 确认期间切换 Space 会**清错画布** | 恢复画布/控制权校验 + 持久化后回执（PR #10） |
| 11 | `DisplayApp` 待机遮罩永不卸载 | 拦截点击、污染展示页 | 最小延迟后淡出并卸载（PR #10） |
| 12 | `HarkCanvasBackdrop` 暂停/离屏仍建 WebGL 上下文 | 不可见空转 ~72s@60fps | 仅 running 时挂载（PR #11） |

---

## 4. 仍未达标（如实标注）

| 项 | 现状 | 需要什么 |
|---|---|---|
| C1④ 真停播 ≤300ms | p50 2228 / p95 3087ms | partial 层可回滚 stop（架构改动） |
| C4② 首音 ≤800ms | 模型路径 p50 1238ms | 流式 TTS（边生成边播）或更快的规划模型 |
| C4③ 语音只播一句话 | 闲聊类会整段朗读 96 字 | 代码强制截断（当前仅提示词约束） |
| C4④ 语音不复述卡片 | 便笺类 1/12 复述正文 | 播报模板统一化 |

**从未验证（无物理环境）**：真实麦克风采集、扬声器↔麦克风 AEC 回路、真实房间噪声、真机 GPU/帧率、Android 端、线上部署环境。

---

## 5. 怎么复跑

前置：Node 24 + pnpm 12.11.2；`pnpm install --frozen-lockfile`。

**无凭据可跑（CI 同款）**

```bash
pnpm --filter @vivic/local-api test
pnpm --filter @vivic/web test
pnpm typecheck
pnpm lint
```

**需要真实 key（本地，不进 CI）**

- `VIVIC_STEPFUN_API_KEY`：ASR/语音
- `DEEPSEEK_API_KEY`：默认主模型
- 启动：`pnpm --filter @vivic/local-api start`；`pnpm dev:web`

**live-gated 测试**：`apps/local-api/tests/asr-stepfun-live.test.ts`（无 key 自动 skip；有 key 用仓库内合成语音 fixture 跑真实链路，约 1 次转写成本）。

生成验收数据的 harness（未入库，在本地 `work/asr-corpus/`）：`cer-harness.ts`（真人 CER）、`fullduplex-harness.ts`（多轮 + 断连恢复）、`echo-harness.ts`（自回声）、`bargein-asr.ts`（打断识别/误打断）。

---

## 6. 关键文件

| 领域 | 文件 |
|---|---|
| 打断策略 | `apps/web/src/ai/interjection.ts`、`turnTaking.ts`（`classifyIntent`/`looksLikeSelfEcho`/`looksLikeCommand`） |
| 全双工协调 | `apps/web/src/ai/fullDuplex.ts` |
| 任务投影 | `apps/web/src/ai/taskProjection.ts` |
| ASR 网关 | `apps/local-api/src/asrGateway.ts`、`asrGatewayServer.ts`、`asrStepfunProvider.ts` |
| 主模型选择 | `apps/local-api/src/providers/main.ts`、`apps/local-api/src/config.ts` |
| 验收测试 | `apps/web/src/ai/__tests__/{bargeInDecision,selfEcho,taskDuplexAcceptance}.test.ts`、`apps/local-api/tests/{voice-feedback,asr-stepfun-live,asr-gateway-base-url}.test.ts` |
| 历史验收记录 | `docs/verification/barge-in-acceptance-20261120.md`、`docs/updates/2026-11-20-c4-voice-feedback-acceptance.md` |

---

## 7. 现状一句话

**C2（流式/多轮/断连恢复）与 C3（状态双工）已整项达标；C1 差"真停播延迟"，C4 差"首音延迟"。CI 三平台全绿，主模型默认 DeepSeek（带 StepFun 回退）。**
