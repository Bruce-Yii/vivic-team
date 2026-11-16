# MOSS-Live 接入评估报告

> 评估日期：2026-11-14  
> 范围：MOSS-Live 公开实时 API 与 VIVIC 当前业务架构的兼容性。  

## 结论

**MOSS-Live 可以作为独立实时语音聊天层评估，但按本次验证的公开 API 行为，不能直接接入 VIVIC 的卡片与工具执行闭环。**

阻断点不是 WebSocket 连接或音频传输，而是公开 API 未能完成工具结果回灌与文本输入。VIVIC 的业务链路需要：

`用户输入 → 模型决策 → VIVIC Host 执行工具 → 结果回灌 → 模型基于真实结果回复 / 建卡`

而本次验证的 MOSS-Live 公开 API 能发出工具调用，但 `function_call_output` 回传和文本输入请求被拒绝。因此不能把“模型发出了 function_call”视为工具调用闭环已打通。

## 1. 已验证的连接与音频能力

探测端点：

`wss://api.mosi.cn/v1/realtime?model=moss-live-1.0&user=<id>`

认证方式：服务端 WebSocket 请求使用 Bearer Token。真实 Token 不应出现在浏览器、仓库、日志、截图或客户端 bundle 中。

| 能力 | 本次结果 | 备注 |
|---|---|---|
| WebSocket 连接 | 通过 | 实测连接延迟约 400–700ms |
| Session attach | 通过 | 返回 session、delegation、memory scope 等信息 |
| Session update | 通过 | 可设置 persona / instructions / tools |
| PCM 音频输入 | 通过 | 16kHz，20ms 帧 |
| ASR final transcript | 通过 | speech stop 后约 164ms 返回 |
| 音频输出 | 通过 | chunked audio |
| 首次语音响应 | 通过 | 实测约 0.6s |
| 语义打断 | 未充分验证 | 官方宣称支持，本轮未完成真实打断验证 |

以上是 2026-11-14 的探测结果，不代表供应商当前所有版本或企业 API 的能力承诺。

## 2. 工具与文本接口兼容性

| 能力 | 本次结果 | 对 VIVIC 的影响 |
|---|---|---|
| 注册工具 | 通过 | 可以向 Session 注册工具描述 |
| 模型发出 function call | 通过 | 可收到工具名、参数和 call ID |
| 回传 function_call_output | 被拒绝 | 无法把 VIVIC Host 的真实执行结果交回模型 |
| response.create | 被拒绝 | 无法按预期触发基于工具结果的后续生成 |
| 文本消息输入 | 被拒绝 | 无法可靠发送文本指令或结构化上下文 |
| 结构化 JSON 输出 | 未验证 / 当前公开接口不满足需求 | 无法作为 VIVIC 卡片数据的可信来源 |

### 关键差异

MOSS-Live 本次验证到的工具调用更接近“发起调用后继续语音输出”；VIVIC 需要“调用 → Host 执行 → 结果回灌 → 基于结果继续回复”。缺少结果回灌时，模型不能可靠地基于真实工具结果完成多步任务或生成卡片。

## 3. 对 VIVIC 的适配判断

### 可行方向：独立语音聊天层

可以把 MOSS-Live 作为独立语音聊天体验进行进一步验证：

- 前端麦克风与 PCM 音频传输；
- 服务端 WebSocket 代理；
- 实时语音输出与播放；
- Session 生命周期与连接恢复；
- 服务端持有 Provider Key。

该方向不应宣称已打通 VIVIC 工具调用、卡片生成或后台 Agent 闭环。

### 当前不建议：直接替代 VIVIC Agent / Host

在供应商公开 API 未支持工具结果回灌和文本输入前，不应将 MOSS-Live 直接接入 VIVIC 的业务工具管道，也不应另造一套平行业务任务系统。

## 4. 后续验证条件

重新评估完整集成前，先向供应商确认并实测：

1. 是否支持将工具执行结果作为 `function_call_output` 回传；
2. 是否支持文本输入或等价的结构化上下文注入；
3. 是否支持工具执行后由模型继续生成；
4. 是否有企业版 / 私有化 API 提供公开 API 当前缺失的能力；
5. 语义打断、重连恢复和多轮上下文的真实行为及边界。

只有真实探针验证通过，才更新兼容性结论。

## 5. 最终结论

截至本报告探测日期：

**MOSS-Live 的实时语音链路具备进一步试验价值；但其公开 API 尚不能满足 VIVIC 的工具结果回灌和文本输入要求。** 当前应保留其架构研究与探测结论，不把它描述为已完成的 VIVIC 生产集成。
