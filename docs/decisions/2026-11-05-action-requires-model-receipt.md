# 画布动作必须由模型给一句回执（2026-11-05）

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `82a87a0`。
- 范围：`apps/local-api/src/intent/toolCalls.ts`（回执契约与校验）、
  `apps/local-api/src/intent/pipeline.ts`（修复轮标记、`sayFallback` 落日志、宿主操作口播）、
  `apps/local-api/src/observability/intentLog.ts`（`sayFallback` 字段）、
  `apps/local-api/tests/*`（测试辅助 + 12 条新用例）、本文档。
- 边界：没有部署、没有碰服务器、没有跑线上 60/48 验收；没有新增依赖、没有改前端、没有改卡契约。

## 1. 回退是什么

本地 60 条验收里，**口播首句达标从旧版 57/60 掉到 34/60**。掉下去的那部分不是模型说错话，
而是模型没说话：

| 来源 | 这一轮的口播 | 是否模型说的 |
| --- | --- | --- |
| 旧版逐卡话术 | 「记好了：明天交周报」 | 是（旧工具各自带一句） |
| 新版回落 | 「已创建 3 张卡片，请查看。」 | 否，宿主模板 |

代码位置就是 `confirmationOf()`：模型自己说的话优先；模型只调了建卡/改卡工具、一个字没说时，
退到宿主默认模板。**根因不是模板措辞不好听，而是"动作类工具没有回执话术这个必填输出"**：
我们删掉了旧版逐卡话术，却没有要求模型补一句，于是"模型不说"变成了合法状态，模板就成了常态。

## 2. 为什么默认模板是错的（而不是"还能再改好一点"）

1. **它把动作说成了结果，又没有信息。** 「已创建 3 张卡片，请查看。」对用户是零信息：哪三张、
   记了什么、要不要现在看。它只是宿主在报告自己执行了几条动作。
2. **它偷走了模型唯一该说的话。** 动作、对象、语气都来自用户这一句原话；模板一律是第三人称
   的完成时，用户听到的不是"你的清单建好了"，而是"系统创建了 3 条记录"。
3. **它掩盖了失败。** 模板永远说得像成功了：模型可能漏了子句、挑错了卡、编了参数，只要有一个
   动作落地，用户听到的还是同一句"已创建 N 张卡片"。可观测性也因此归零——日志里看不出模型
   这一轮到底有没有说话。
4. **它是协议缺口的症状，不是产品文案问题。** 继续在模板上改措辞（"搞定啦"/"已经放好了"）
   只是把同一个缺口换个说法；缺的是"动作必须配一句人话"这条输出要求。

所以这次做的是**协议级修复**：把"一句自然回执"变成动作批次的必填输出，宿主校验它，
并把"模型仍然不说"降级成可观测的兜底，而不是默认话术。

## 3. 协议：动作必须同批带回执

任何一轮只要执行了画布动作，就必须在同一批工具调用里返回 `chat(reply="…")`：

| 工具 | 是否要求回执 |
| --- | --- |
| `create_card` | 是（任意 kind，含追加条目） |
| `update_card` | 是（改标题/条目/暂停恢复倒计时） |
| `delete_card` | 是（提出待确认的删除也算） |
| `arrange` | 是（整理画布、移动/固定、传送到用户页/展示页） |
| `view` | 是，但**仅 focus/highlight**；`fit`/`restore` 只换镜头，豁免 |
| `history` | 是（撤销/重做） |
| `chat` / `clarify` / `unsupported` / `search` / `weather` / `read_url` / `metal_price` / `find_cards` | 本身不是动作，不需要 |

同批的 `chat(reply)` 就是这一轮的口播：`spokenText` 用它，不再拼宿主模板。写法要求（系统提示
规则 1b 与各工具描述一致）：

- ≤80 字，一句自然的确认，说清做了什么、对象是谁；
- 示例：「记好了：明天交周报」；「清单建好了，先列了打包、约搬家公司、改地址」；
- **禁止**：「已创建 N 张卡片，请查看」「已保存」「已完成」「搞定啦」，以及任何 JSON、卡型名
  （NoteCard/TodoCard…）或字段名。

落点：

- 系统提示：新增规则 `1b. 回执（硬性）…`，两个正例 + 禁止清单（`buildToolSystemPrompt`）。
- 工具描述：`create_card` / `update_card` / `delete_card` / `arrange` / `history` 共用
  `RECEIPT_CONTRACT` 那一条；`view` 用它自己的版本（说明 focus/highlight 要、fit/restore 不要）；
  `chat` 的描述点明"一批里有画布动作时，`chat(reply=…)` 就是那次动作的回执"。

## 4. 宿主校验：`missing-say` → 一次修复轮 → 兜底

`planFromToolCallsDraft()` 在动作已经构建完之后、返回计划之前判断：

1. 本轮执行了需要回执的动作，且 `spoken` 为空 → 返回 `kind: "invalid"` + 一条
   `code: "missing-say"` 的 issue：

   - message：`这一轮执行了画布动作，但没有任何模型文字：宿主不会替你说话，动作也不能静默完成`
   - hint：`为刚才的动作补一句自然回执，用 chat(reply=…)，不要复述「已创建 N 张卡片」`

   这一批的 `actions/created` 全部丢弃（与其它 `invalid` 一致），所以不会出现"卡建了、话没说"
   的半成品。
2. 走**既有的那一次修复轮**（`pipeline.ts` 的 `repairOnce`，`VIVIC_TOOL_REPAIR` 默认开）：
   模型看到自己的调用 + 这条 issue，补 `chat(reply=…)` 后重新校验，通过就正常提交，
   `spokenText` 是模型那句。
3. 修复轮仍然沉默 → 这时才用宿主兜底句（`卡片已经放到画布上了。`，占位语义就是"我说不出，
   但动作确实落地了"），并在 intent log 记 `sayFallback: true`。
   - 判据由 `planFromToolCalls(..., { sayFallback: true })` 传入：`pipeline` 在
     `deps.toolRepair === false` 或已经花过修复轮（`repairRound > 0`）时置位。也就是说
     "最后一次机会"是显式的，不是靠模型猜。
   - 关掉修复轮（`VIVIC_TOOL_REPAIR=off`）时，第一轮就是最后一次机会：直接兜底 + `sayFallback`，
     不会把整轮变成失败。
4. 旧的 `已创建 N 张卡片，请查看。` 模板**删除**：兜底句不再是数量模板，也不再出现"请查看"。

三处配套细节（不这样写就有缝）：

- **回执不算子句解释。** 同批 `chat` 的 `subtitle.show` 会记进 `chatSubtitles`，子句覆盖校验
  （`dropped-clause`）与条件句校验不再把它当成"模型已经解释过这一句"。否则协议本身会把 sc-52
  的回归又打开：模型建了便签、补一句"好了"，倒计时子句就被合法地丢掉。
- **回执不是第二个画布动作。** 当这一批还有别的真实效果时，`chat` 那条重复的
  `subtitle.show` 会被丢掉——信封自己的 `spokenText` 就是客户端口播与字幕的来源
  （`apps/web/src/sync/controlHost.ts` 的 `withSpokenSubtitle`）。不丢会多一条重复字幕，还会把
  "只做 arrange/history"的批次变成 `composite`，客户端拿到一个只有字幕的信封。
- **宿主操作也说模型那句。** `arrange`/`history`/暂停恢复这类 `host-operation` 计划的 `message`
  以前固定是"已整理布局/已撤销"，现在模型有回执就用模型那句，宿主那句只在兜底时出现；
  `pipeline` 也把 `plan.say ?? plan.message` 传进结果，否则模型说了也会被丢掉。

## 5. 可观测字段

intent log 每行一个 JSON（`docker logs` + `VIVIC_TELEMETRY_DIR` 的 JSONL）：

```json
{"requestId":"…","path":"tool-repair","tools":["create_card","chat"],"cards":["TodoCard"],
 "kind":"envelope","repairs":1,"repair":"fixed","sayFallback":true}
```

- `sayFallback: true` 只在"动作落地但模型（在最后一次机会里）仍然没说话"时出现，缺省不写
  `false`：**没有这个字段 = 这一轮是模型自己说的**。
- 和 `path`/`repairs` 一起看：`path: "tool-repair"` + `sayFallback: true` 是"退回过一次还是不说"；
  `sayFallback` 单独出现（`toolRepair` 关闭）是"没有修复轮，直接兜底"。
- 增长就说明模型在忽略回执契约——该修提示/工具描述/模型，而不是接受这句兜底当产品文案。

## 6. 测试

**测试辅助（只改 setup，不改既有用例的语义）**

- `tests/helpers.ts`：新增 `withReceipt(calls)`——脚本化的模型批次里只要带了画布动作
  （`create_card`/`update_card`/`delete_card`/`arrange`，或 `view` 的 focus/highlight）却没有
  `chat(reply=…)`，就补一条 `{name:"chat", args:{reply:"好了"}}`，模拟"合规模型"。
  两种脚本形状（`args` / `arguments`）都支持，`unsupported`/`clarify` 已算模型在说话。
- 各 `tests/*.test.ts` 的 fake transport 只改一行：`tool_calls: batch.map(…)` →
  `withReceipt(batch).map(…)`（`find-cards`/`relative-dates`/`tool-repair`/`tool-composite-lookup`/
  `weather-fallback`/`tool-surface-accept60`/`query-tools-read-only`/`metal-price`/
  `pipeline-rules-and-adapters`/`generic-card`/`image-tool-path`/`tool-read-url`/`tool-layer-online`）。
- 映射层的纯函数用例（`tool-calls.test.ts`、`clause-coverage.test.ts`、`scenes.test.ts` 等）不是
  "模型说没说"的用例，走 `{ sayFallback: true }`：测的是映射与校验，不是回执协议，因此不引入
  额外动作/路由，断言保持原样。
- 因此**没有**为了这次协议去改任何一条既有用例的语义；唯二跟着变的断言是遥测：
  `tool-layer-online` 的 `sink.tools` 多了 `chat`（模型确实调了它），
  `tool-calls.test.ts` 的 helper 改为 `sayFallback` 模式。

**新增 12 条**

- `tests/tool-calls.test.ts`（7 条，`describe("the action receipt")`）：动作无文字 → `invalid`
  + `missing-say`（hint 指 `chat(reply=…)`）；同批补 `chat` → 提交且 `spokenText` 是模型那句、
  动作里没有多余字幕；`arrange`/`history` 同样要求且保留模型那句；focus/highlight 要、fit/restore
  不要；`sayFallback` 模式才用兜底句并置标记、兜底句不含"已创建"；同批回执不能豁免
  `dropped-clause`；纯 chat / 纯 clarify 不受影响。
- `tests/tool-repair.test.ts`（4 条，`describe("action receipt")`）：动作无文字 → 第一轮
  `missing-say`、修复轮补 `chat` 后成功（`spokenText` = 模型那句，修复提示里有 `missing-say` 与
  `chat(reply=…)`，且不再警告"已创建 N 张卡片"）；修复轮仍沉默 → 兜底句 + `sayFallback: true`
  （并断言 `intentLogLine` 里带这个字段）；关闭修复轮 → 第一轮直接兜底 + 标记；纯 chat 不花修复轮。
- `tests/intent-log.test.ts`（1 条）：`sayFallback` 只在沉默兜底那轮出现，正常轮没有该字段。

## 7. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：
  `Test Files 5 failed | 127 passed | 2 skipped (134)`、
  `Tests 8 failed | 2842 passed | 3 skipped (2853)`；
  HEAD 基线是 `8 failed | 2830 passed | 3 skipped (2841)`。
  8 条失败逐条比对（`FAIL` 行做集合差）**差集为 0**，与 HEAD 完全一致
  （`command-matrix` 1、`deepseek` 1、`provider-main-transport` 3、`stepfun-stream` 1、
  `weekly-plan-grounding` 2，均为既有失败）。测试总数 2841 → 2853（+12）。
- `pnpm --filter @vivic/local-api typecheck`：只有改动前就存在的
  `tests/helpers.ts(8,23) TS2322`（`testConfig` 与 `LocalApiConfig.mainProvider` 的可选性），
  没有新增错误。
- `oxlint` 改动文件：0 warning / 0 error。

## 8. 没做的事

- 没跑线上/本地 60 条与 48 条验收，也没部署：这一条修的是协议与宿主校验，真实达标率要在验收里
  重测（关注 `sayFallback` 的条数与口播首句）。
- 没给模型加"重试到说出话为止"的循环：只有一次修复轮，之后是兜底 + 可观测标记。
- 没动卡契约、前端口播通道和 `view(fit|restore)` 的既有行为。
