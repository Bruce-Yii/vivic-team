# C4 短语音反馈 + 卡片承载主信息：本地验收记录（2026-11-20）

本记录只收录本机真实调用得到的数据，脚本在 `work/asr-corpus/`（不入库，含 key 读取逻辑但不含 key）。
线上部署、真实麦克风 ASR、浏览器音频设备不在本次范围。

## 环境与口径

- 仓库：本机 worktree `work/wt-c4`，基线 `9ac177f`，交付分支 `test/voice-feedback-acceptance`。
- 端到端入口：真实 `createApp`（`mode: "online"`），`providerStore` 存一条 DeepSeek main 行
  （`protocol: openai-compatible`、`baseUrl: https://api.deepseek.com/v1`、`model: deepseek-flash`），
  `providerSeed: false`、`providerPersist: false`、`searchEnabled: true`；请求走真实 `/api/intent` HTTP 处理链。
- TTS：真实 StepFun `https://api.stepfun.com/v1/audio/speech`，`stepaudio-2.5-tts`、
  `voice=wenrounvsheng`、`speed=1.3`、`response_format=mp3`、`stream_format=sse`、`timestamps=false`
  （即 `resolveSavedSpeech` 给 `planSpeech` 的真实请求形状与浏览器默认偏好）。
- 所有 key 只在进程内读取，未写入任何文件、日志或提交内容。

## ① 语音 → 建卡/动作成功率

| 项 | 结果 |
|---|---|
| 样本量 | 20 条受控中文（倒计时 3、待办 2、提醒 5、便笺 2、查询 4、闲聊 4） |
| HTTP 200 | 20/20 = 100% |
| `kind=envelope` | 20/20 = 100% |
| `envelope.actions` 非空 | 20/20 = 100% |
| 建卡类 12 条实际建出卡片 | 12/12 = 100% |

判定：**达标（100% ≥ 95%）**。

两条已知质量问题（不影响建卡/动作成功率，但影响内容质量，未修）：

- `建一个待办清单，一条是整理房间` → `TodoCard.items = ["清单", "一条是整理房间"]`：快路径把
  "清单" 当成一条待办，属于确定性子句切分缺陷。
- 首次跑测时 2 条查询（金价、新闻）返回 `kind=error`「查询服务暂时不可用」，原因是测试用
  `testConfig()` 只给了部分配置、`searchEnabled` 未开（产品 `loadConfig()` 默认开）。开启后同两条
  转为 envelope（`SearchResultCard` ×3）。这属于量测口径修正，不是产品失败。

## ② 首音延迟（说完 → 第一段音频可播）

分解测量，未含浏览器 MSE 播放启动、音频设备与 ASR。

| 段 | 样本 | p50 | p95 | 最小/最大 |
|---|---|---|---|---|
| 模型段：`/api/intent` 端到端（全部走 DeepSeek，无规则命中） | 10 | **741ms** | **1193ms** | 553 / 1193 |
| TTS 首包：发请求 → 第一个音频 delta | 8 | **497ms** | **660ms** | 481 / 660 |
| 合计（模型段 + TTS 首包） | — | **1238ms** | **1853ms** | — |

对照：TTS 整段合成完成 p50 1302ms / p95 1517ms（不计入首音）。

判定：**不达标**（门槛 p50 ≤ 800ms、p95 ≤ 1500ms）。

按路径拆分（同一批 20 条 `/api/intent`）：

| 路径 | n | `/api/intent` p50 / p95 | 加 TTS 首包 p50 / p95 | 是否达标 |
|---|---|---|---|---|
| 确定性规则（0 模型） | 10 | 5ms / 34ms | 502ms / 694ms | 达标 |
| 模型规划（DeepSeek） | 7（专测 10） | 745ms / 1215ms（专测 741 / 1193） | 1242ms / 1875ms（专测 1238 / 1853） | 不达标 |
| 20 条混合 | 20 | 34ms / 1215ms | 531ms / 1875ms | p50 达标、p95 不达标 |

结论：首音延迟的门槛目前只在确定性规则路径成立；一旦需要模型规划（约 35% 的样本），
仅模型段就吃满 800ms 预算，合计必然超 1.5s。

## ③ 播报文本长度（只播状态确认/一句话）

实参确认（读代码）：`ControlApp.tsx` 在 envelope 分支把 **`result.envelope.spokenText`** 传给
`speakText()`（L683–684）；`task` 完成分支传 `result.message`（L677）；decision-task 路径的
`clarify`/`error` 不朗读。因此下表按 `envelope.spokenText` 统计。

| 指标 | 结果 |
|---|---|
| n | 20 |
| p50 | 9 字 |
| p95 | 49 字 |
| 最大 | 96 字 |
| 平均 | 19.1 字 |
| > 40 字 | 2/20 = 10%（c19 49 字、c20 96 字） |
| > 80 字 | 1/20 |
| > 100 字 | 0/20 |

- 建卡类 12 条全部 ≤ 16 字（5–16 字），都是"已设置 1 项提醒 / 已记下 3 条待办 / 30分倒计时已就位"
  这类状态确认，是**达标**的"一句话"。
- 闲聊/问答类会把整段回答当播报：`你都能做什么` 96 字、`我今天有点累` 49 字、`现在几点` 39 字。
  这类不是"状态确认"，而是"朗读答案"，**不满足"语音只播一句话"**。
  契约上限是 180 字（`ActionEnvelopeSchema`），40 字只是提示词要求，没有代码强制。

判定：建卡/动作类**达标**；闲聊/问答类**不达标**（10% 超过 40 字，最长 96 字）。

## ④ 细节由卡片承载，语音不重复

| 项 | 结果 |
|---|---|
| 建卡样本 | 12 |
| 卡片承载细节 | 12/12 = 100% |
| 语音复述卡片细节 | 1/12 = 8.3% |

细节落点随卡片契约不同：`TodoCard.displayProps.items[].text`、`NoteCard.displayProps.text` 在
`displayProps`；`CountdownCard` 按契约 `displayProps = {}`，事项与时间在
`sourceData.reminderText` / `sourceData.targetAt`（渲染层直接读 `sourceData`）。

脱敏样例：

1. `帮我记一下待办：买牛奶、交电费、取快递`
   - 卡片：`TodoCard`，`displayProps.items = [买牛奶, 交电费, 取快递]`
   - 语音：`已记下 3 条待办`（9 字，不复述条目）
2. `明天下午三点提醒我和王工对一下接口`
   - 卡片：`CountdownCard`，`sourceData.reminderText = 和王工对一下接口`，
     `targetAt = 2026-11-21T07:00:00Z`（Asia/Shanghai 15:00）
   - 语音：`已设置日期提醒。`（8 字，不念时间与事项）
3. `帮我记下来：wifi 密码是八个八`（反例）
   - 卡片：`NoteCard.displayProps.text = wifi 密码是八个八`
   - 语音：`记好了，wifi 密码是八个八。`（16 字，**复述了卡片正文**）——语音与卡片重复，
     建议这类便笺只播"记好了"。

判定：**卡片承载达标（12/12）**；"语音不重复细节"基本成立（11/12），便笺类存在复述。

## 固化测试（不需要 key）

`apps/local-api/tests/voice-feedback.test.ts`（18 个用例）把上述可离线保证的部分固化：

- ① 5 条确定性语音指令各返回 envelope、动作数与卡片类型正确、且未调用模型；
- ③ 播报 ≤ 40 字且只有一句；
- ④ 用户细节全部落在卡片上、语音不含这些细节；`CountdownCard.displayProps` 为空契约、
  时间只在 `sourceData`；
- 合并信封的播报被截断到 180 字契约上限，181 字被 schema 拒绝。

## 未测项

- 真实麦克风 → ASR → `/api/intent` 的完整语音链路（本次从文本输入开始）；
- 浏览器 MSE 首帧"真正可听"延迟（`audio.onplaying`）与输出设备；
- 播报时长（按字速折算）与打断/继续行为；
- Android / 手机端；
- 线上部署环境（本次全部本机）。
