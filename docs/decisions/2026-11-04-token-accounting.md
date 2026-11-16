# 模型 token 计量与提示词前缀稳定（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `edd1009`。
- 范围：只改后端源码/测试/文档；**不部署、不碰服务器、不跑线上/本地 60 条**；单测本地跑。
- 结论：每个 `/api/intent` 请求现在会在 intent log 的一行 JSON 里写出
  `tokens: { input, output, cacheHit, cacheMiss, model, turns }`，工具轮、修复轮、
  lookup 回灌轮、主规划器轮都按响应里的 usage 累加；同时把工具系统提示词拆成
  "固定前缀 + 动态尾部"，图片提示从固定规则中间移到最末尾。只记录数字，不记录
  提示词、补全内容、图片或凭据。

## 1. 现状数字（本机实测，2026-11-04）

用 `buildToolSystemPrompt` + `TOOL_DEFINITIONS` 实测（`work/token-accounting/measure.ts`，
字符数；token 是按中文场景常用的 `chars / 1.5` 粗估，不是官方 tokenizer）：

| 部分 | 字符 | 粗估 token |
| --- | ---: | ---: |
| 固定规则（含 12 个工具说明、卡型字段、示例、语气块） | 11,776 | ~7,851 |
| 12 个工具定义 JSON（`TOOL_DEFINITIONS`） | 10,823 | ~7,215 |
| 空画布动态尾部（canvasId/stage/今天/最近聚焦） | 103 | ~69 |
| 6 张卡画布动态尾部 | 606 | ~404 |
| 27 张卡画布动态尾部 | 1,638 | ~1,092 |
| 图片提示段（仅带图请求） | 465 | ~310 |

因此一个 6 张卡的普通文本请求：系统提示 12,382 + 工具定义 10,823 = **23,205 字符
≈ 1.55 万 token**；27 张卡时系统提示 13,414，合计 **24,237 字符 ≈ 1.62 万 token**。
这与此前手工估计的 2.4 万字符 / 1.6 万 token 一致。修复轮/查询回灌轮会把这整包
再发一次（额外加一次工具结果或校验错误），所以 `turns` 是成本的第一现场。

改动前后的差别不是提示词变短：固定规则和工具定义一个字都没删。前端节省 token 要
靠后续研究（见第 6 节），本轮先把"能不能量、量得准不准"补上。

## 2. 计量字段与落点

### 2.1 一行 JSON

`apps/local-api/src/observability/intentLog.ts` 的 `IntentLogLine` 新增可选字段：

```json
{
  "requestId": "…",
  "path": "tool",
  "tools": ["create_card"],
  "cards": ["TodoCard"],
  "elapsedMs": 1234,
  "kind": "envelope",
  "provider": "deepseek",
  "tokens": { "input": 2200, "output": 100, "cacheHit": 1900, "cacheMiss": 300,
              "model": "deepseek-flash", "turns": 2 }
}
```

- `input`：所有轮次的 prompt token 之和（包含 cache hit 与 miss）。
- `output`：所有轮次的 completion token 之和。
- `cacheHit` / `cacheMiss`：prompt 侧命中/未命中缓存的 token。两者相加等于
  `input`；provider 没给 miss 字段时由 `input - cacheHit` 推导。
- `model`：本请求用到的模型 id；跨模型（例如工具用 DeepSeek、规划器用 GPT）时用
  `+` 连接，便于汇总脚本按模型分组。
- `turns`：真正报告了 usage 的模型轮数，包含首批工具调用、`tool-repair`、
  `tool-lookup` 回灌、`find_cards` 回灌和主规划器轮。provider 没给 usage 的轮次
  不计数，绝不编造 0。
- 没有 usage 的请求整行不写 `tokens`；写日志失败/缺字段都不会影响请求。

### 2.2 usage 映射

`apps/local-api/src/observability/tokenUsage.ts` 的 `normalizeTokenUsage` 负责把
provider 的原始 usage 归一成上面的 delta：

| provider 风格 | 原始字段 | 归一 |
| --- | --- | --- |
| DeepSeek / OpenAI 兼容 | `prompt_tokens`, `completion_tokens`, `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` | 直接取；`input = prompt_tokens` |
| OpenAI（嵌套缓存） | `prompt_tokens_details.cached_tokens` / 顶层 `cached_tokens` | `cacheHit = cached`，`cacheMiss = input - cacheHit` |
| Anthropic | `input_tokens`（不含缓存）、`output_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` | `input = input + read + creation`，`cacheMiss = input + creation` |
| Pi（GPT planner 的 SDK） | `input`（不含缓存）、`output`、`cacheRead`、`cacheWrite`、`totalTokens` | `input = input + cacheRead + cacheWrite`，`cacheHit = cacheRead` |
| 已归一 delta | `input`, `output`, `cacheHit`, `cacheMiss` | 原样接受（幂等） |

兼容映射只认数字；`undefined`、`null`、`{}`、数组、字符串都返回 `undefined`。

### 2.3 落点

- `stepfun.ts`：JSON 规划器的流式/非流式响应都取 `usage`；附加到成功的
  `StepfunResult.usage`。
- `intent/toolTransport.ts`：OpenAI 兼容工具轮的非流式 body 与流式最后一个
  usage-only frame 都取；DeepSeek 模型流式请求补 `stream_options.include_usage`
  （StepFun 的请求体保持原样）。
- `deepseek.ts`：官方 DeepSeek 快路径 JSON 响应取 `usage`。
- `gpt/provider.ts`：Pi SDK 的 `AssistantMessage.usage` 映射成同一 delta。
- `intent/pipeline.ts`：`recordUsage` 在每次成功返回后累加到
  `deps.intentLog.tokens`（`createTokenUsageMeter()`），覆盖 `generate()`、
  `requestToolTurn()`（流式失败回退非流式只记实际成功的那一次）和
  `summarizeEvidence` 的规划器调用。
- 用法是 side channel：`StepfunResult.usage` 是**不可枚举**属性，避免把
  "相同答案" 变成结构比较不同的对象（既有 provider/GPT 测试按整体相等断言）。

> 说明：`classifyDeletionConfirmation` 的删除确认小模型调用走同一条 `chatJson`，
> 但它不属于主回答链路的 intent turn，本轮没有把它注入请求级 meter；如需要可按
> 同样方式接入。

## 3. 提示词前缀结构

`buildToolSystemPrompt(ctx, { image })` 现在是明确的两段：

```
[固定前缀]
  工具面说明 + 规则 1–14 + 例子 + 卡型字段 + 语气块（replyStyleInstruction）
[动态尾部]
  画布：canvasId=…，stage=…，共 N 张卡
  今天：YYYY-MM-DD 周X（时区 …）
  画布卡片 …（卡片摘要/聚焦/条目预览）
  最近聚焦：…
  （仅带图）【本次请求带图】…    ← 现在永远在最后
```

- 固定前缀用 `TOOL_PROMPT_DYNAMIC_MARKER = "画布：canvasId="` 标出边界；测试
  `tests/prompt-prefix.test.ts` 对 0/3/27 张卡、不同 focus、带图/不带图分别计算
  `SHA-256(固定前缀 + JSON.stringify(TOOL_DEFINITIONS))`，要求完全一致。
- **原来破坏前缀的地方**：
  1. `options.image` 的带图提示段插在固定规则 `2c` 和 `3` 之间，带图与不带图请求
     从中间就开始分叉；现已移到动态尾部最后。
  2. `replyStyleInstruction()` 是固定内容，但原来排在动态画布字段之后，等于固定块
     被动态内容截断；现已并入固定前缀。
  3. 画布 id、日期、卡片列表本来就在尾部，保持不变；用户原话从不进入系统提示。
- 工具定义 JSON 在每个请求里都是同一份常量，和固定前缀一起构成 provider 可复用的
  最长前缀。日期/时区只在尾部，因此同一天内同一画布的后续请求能命中固定前缀。

## 4. 怎么验证缓存命中

1. 单测：`pnpm --filter @vivic/local-api exec vitest run tests/prompt-prefix.test.ts`
   证明固定前缀哈希在画布变化时不变、图片段在末尾。
2. 落盘后跑一天的汇总：

   ```bash
   pnpm --filter @vivic/local-api token:summary -- --dir <VIVIC_TELEMETRY_DIR> --date 2026-11-04
   pnpm --filter @vivic/local-api token:summary -- --file ./intent-2026-11-04.jsonl --json
   ```

   默认目录取 `VIVIC_TELEMETRY_DIR`（与写日志同一个变量），并同时读
   `intent-YYYY-MM-DD.jsonl` 与轮转的 `.1`。输出按 `path/model` 的请求数、
   input/output 总数、缓存命中率、每请求均值与 input 的 p50/p95。
3. 看 `path=tool`/`tool-repair`/`tool-lookup` 的 `cacheHitRate`：同一画布、同一天
   的第二次及以后请求应明显高于首次；第一次通常是 `cacheMiss`，后续固定前缀
   命中。DeepSeek 的命中数由其 `prompt_cache_hit_tokens` 返回，我们只做记录和
   比值，不推断 provider 的缓存策略。
4. 对比修复轮：`turns=2` 的请求 input 接近 `turns=1` 的两倍，正是"整包重发"的
   直接证据；后续上下文瘦身应让这条曲线下降。

## 5. 测试与验证

- `tests/token-usage.test.ts`：DeepSeek/OpenAI/Anthropic/Pi 四种映射；两轮 usage
  相加（1000+1200 等）；缺 usage 不报错、JSONL 不写 `tokens`；非流式/流式
  chatJson 与工具轮都能取到 usage；修复轮在 sink 上累加成 `turns=2`。
- `tests/token-summary.test.ts`：样例日志的按 path/model 汇总、命中率、均值、
  p50/p95；无 tokens / 坏行 / 空日不崩。
- `tests/prompt-prefix.test.ts`：固定前缀哈希稳定；动态字段与图片段只在尾部。
- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：2,640 passed，
  8 failed，与基线 `baseline-failures.json` 逐条一致（差集 0），均为既有失败。
- `typecheck`：只剩既有 `tests/helpers.ts` 的 `modelApiBaseUrl` 错误；
  `oxlint` 改动文件 0。

## 6. 未做项（等上下文瘦身/工具描述压缩研究结论）

- 不删固定规则、不压缩 12 个工具定义、不改卡片 schema 文案：这些需要先有实测
  收益/回归证据，本轮只做计量与顺序。
- 不把画布摘要挪到 user message、不做摘要分级或按需检索：会影响模型对 id 的
  可用性，等研究结论。
- 不做 token 预算/告警、不做按请求的费用估算、不接第三方 tokenizer：先积累
  一到两周的 `cacheHitRate`、p50/p95 和 `turns` 分布再定阈值。
- 不记录提示词、补全、图片、凭据或任何内容；日志只有数字和既有路由字段。
