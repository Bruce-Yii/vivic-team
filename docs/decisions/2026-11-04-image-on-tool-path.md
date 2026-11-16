# 图片分析卡回到模型 + 工具面（2026-11-04）

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `8b764dd`。
- 范围：`apps/local-api/src/cards/imageAnalysis.ts`、`intent/toolCalls.ts`、`intent/pipeline.ts`、
  `intent/toolTransport.ts`、`stepfun.ts`（只抽出一个共用的 messages 序列化函数）、
  新测试 `tests/image-tool-path.test.ts`、本文档。
- 边界：没有部署、没有碰服务器、没有跑线上验收；没有新增模型可调用的工具，也没有恢复
  槽位规划器。

## 1. 断点

删除第二套决策系统时，`cards/imageAnalysis.ts` 的 `image_analysis` 契约只剩槽位规划器
一个调用者。规划器删除后：

- `pipeline.ts` 的工具面条件是 `!hasImages`，带图请求根本进不到工具轮；
- 带图请求走规划器（视觉），规划器的场景/回答路径没有任何地方会写
  `displayProps.image`；
- 宿主其实**已经**把本次图片留存成 `media:image_<sha256>` 并通过
  `x-vivic-intent-image-ref` 交给本地 API（`hosted/service.ts` → `app.ts` →
  `IntentRequest.trustedImageRef`），只是没人消费它。

所以断点不是「缺一个工具」，而是：**唯一剩下的理解路径（模型 + 工具面）被 `hasImages`
关掉了，而模型也没有任何字段可以表达这张图。**

## 2. 恢复方式

一句话：**图片是宿主的事实，文字是模型的判断。** 不新增 `analyze_image` 工具，仍然只有
`create_card`；模型选择「图片相关卡」，宿主把自己手里的引用填进去。

### 2.1 入口

`pipeline.ts` 的工具轮条件从 `!hasImages` 改成 `(!hasImages || imageToolTurn)`，其中

```ts
const trustedImage = hasImages && isTrustedImageRef(req.trustedImageRef) ? req.trustedImageRef : undefined;
const imageToolTurn = Boolean(trustedImage) && deps.planner?.provider !== "gpt";
```

- 带图但**没有**宿主引用（本地无留存、或引用形状不对）：不进工具轮，保持原来的视觉规划器；
- 带图 + 有引用：进工具轮，图片以 OpenAI 兼容的 `image_url` content part 随 user 消息发给
  模型（`stepfun.providerMessages`，规划器与工具传输共用同一份序列化）；
- 主规划器是 GPT 时图片仍留在规划器：工具传输走的是 StepFun/DeepSeek 的兼容端点，
  那是另一个模型，app 的视觉能力校验校验的不是它。

工具轮的 system prompt 追加一段「本次请求带图」规则：可以分析图片、可以建 `news_summary`
/ `photo_story` / `photo_gallery` / `photo_memory` / `answer`，**图片字段一律不要填**，
看不清就 `clarify(missing="image")`，只回答文字、不建卡也可以。

### 2.2 建卡

`planFromToolCalls(calls, ctx, now, utterance, { trustedImageRef })`：宿主引用只经这个参数
进入映射器，从不从工具参数里读。

| 模型选择 | 构建方式 | 结果 |
| --- | --- | --- |
| `create_card(kind="answer")` | `imageAnalysisContract.build({headline, summary, keyPoints}, ctx)` | NewsCard，`displayProps.image = trustedImageRef`、`summaryBy:"ai"` |
| `create_card(kind="scene", scene_id="news_summary")` | 先按场景 payload 校验 `headline/summary/keyPoints`，再走 `imageAnalysisContract` | NewsCard + 宿主图片 |
| `scene_id="photo_story"` / `"photo_gallery"` / `"photo_memory"` | 先用原场景 builder 构建（`buildSceneActions`），再由 `attachTrustedImage` 合并宿主图片 | StoryCarouselCard 每张 slide、GalleryCard 首图、PhotoCoverCard 封面 |
| 其它 kind | 不变 | 不变 |

`news_summary` 交给图片契约而不是场景 builder，是因为「分析一张图」没有可摘要的原文：
`scenes/build.ts` 要求 `hasSource` 且摘要与语料重合 ≥30%，带图时永远过不了；而
`imageAnalysisContract` 本来就要求「本次请求已留存的可信图片」，正好是这个场景。

`attachTrustedImage` 只改媒体的那一个字段，其余（id/layout/metadata/sources/文字）保持
builder 的产物，合并后用共享的 `CardRecordSchema` 再校验一次——不手写 CardRecord。
模型选了什么卡就还是什么卡；模型没选卡、只回答文字时宿主不会替它建卡（`chat`/`clarify`
路径完全没动）。

### 2.3 prompt 与 issue

- 系统提示词里有 `【本次请求带图】` 段（只在带图时出现），明确「图片字段一律不要填」；
  `media:image_…` 从不进入发给模型的任何消息（测试断言整份请求体里没有它）。
- 模型自己写 `imageUrl`（`news_summary`、`photo_story.slides`、`photo_memory`）→
  `create_card` 直接失败并回传 issue：`本次请求的图片由宿主注入，不能自己填 imageUrl`，
  hint 让模型去掉该字段重试。这是**拒绝**，不是静默覆盖，也不是静默保留。
- 模型自己编 `media:image_<hash>` 同样过不了：场景 payload 的 `imageUrl` 只接受 https，
  `answer` 的参数是 strictObject，图片契约的 slots 也是 strictObject。

## 3. 安全边界（与删除前一致）

1. **只有本次请求上传的图片。** `trustedImageRef` 由 `hosted/assets.ts` 的
   `persistIntentImage` 生成（账号 + 空间 + 设备作用域，内容 sha256），经 hosted 代理的
   header 注入本地 API；`app.ts` 只在 `online` 模式读这个 header，浏览器请求带不进来。
2. **模型不能编引用。** 引用只作为 `planFromToolCalls` 的宿主参数存在，不进入工具 schema、
   不进入 prompt、不进入发给模型的消息；模型对图片字段的任何输入都会被拒。
3. **跨账号/跨空间不可用。** 即使有人把别的账号的 `media:image_<hash>` 塞进卡片，
   `HostedSpaceStore.applyEnvelope` 会按本空间的资产索引校验（原件不存在 / 只能使用已上传），
   提交失败、画布不变。新测试用既有的 store + assets fixture 复现了这条。
4. **不带图/不带引用不注入。** 没有 `attachments` 时 `trustedImage` 一定是 `undefined`；
   引用形状不符（https、`media:file_…`、`media:image_short`）一律忽略。

## 4. 测试

新增 `apps/local-api/tests/image-tool-path.test.ts`（12 条）：

| 用例 | 断言 |
| --- | --- |
| 带图 + 模型建 `news_summary` | `displayProps.image === trustedImageRef`、`summaryBy:"ai"`、NewsCardSchema 通过、没有 `imageUrl` |
| 带图 + `kind=answer` | 同样是 NewsCard + 宿主图片 |
| 带图 + `photo_story` | 每张 slide 的 `image` 都是同一个 ref，文字保持 builder 的产物 |
| 模型自填 `imageUrl`（新闻/照片故事） | `kind:"invalid"`、无动作、issue 指出字段与「宿主注入」；去掉后同一调用能建卡 |
| 模型自编 `media:image_<hash>` | 同样被拒，产物里没有这个值 |
| 模型只聊天 / 只说做不到 | 不建卡（`chat` 无动作；`unsupported` 只有一句 subtitle），图片不会拉着一张卡出来 |
| prompt | 含「本次请求带图」，不含 `media:` 与任何 ref |
| 无引用 | 同样两张卡都没有 `image` 字段，prompt 没有带图段 |
| 非法引用（https/file/短串） | 忽略，不注入 |
| 管线带图 + 引用 | 工具轮被调用、planner 未被调用；请求体里有 `data:image/png;base64,…`，没有 ref |
| 管线带图无引用 | 不走工具轮（视觉规划器不变） |
| 管线只有引用没有附件 | 工具轮照常，但请求体没有 `image_url`、卡片没有 `image` |
| GPT 主规划器 + 带图 | 留在规划器，不把图发给未校验视觉能力的工具模型 |
| 跨账号/跨空间 | 同一个 envelope 在别的账号/空间提交抛错，画布不变；本账号本空间成功 |

验证（本机，`work/backend-merge`）：

- `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：**8 failed / 2586 passed**（2597 条），
  失败集合与 `8b764dd` 逐条一致（差集 0；这 8 条是既有的 command-matrix/deepseek/
  provider-main-transport×3/stepfun-stream/weekly-plan-grounding×2）。测试数 2585 → 2597。
- `pnpm --filter @vivic/local-api typecheck`：只剩既有的 `tests/helpers.ts(8,23)`。
- `pnpm exec oxlint apps/local-api/src apps/local-api/tests`：0 error（50 条既有 warning）。

## 5. 已知边界（没有在本轮扩大）

1. **任务管理器里的带图请求**本轮曾走 `decision/taskV2.ts` 的
   `fallback("vision_requires_planner", true)`，即视觉规划器，而不是工具轮。
   **同日后续轮已修复**：该特判被删除，带 `task` 的图片请求与普通请求走同一条
   `deps.legacy` → `runIntent` 模型路径（工具面或视觉规划器由模型/配置决定，宿主不改道），
   见 [删除原生任务决策器](2026-11-04-remove-native-task-decider.md)。
2. **GPT 主规划器**的带图请求留在规划器（见 §2.1）。要让它也走工具面，需要先校验工具
   传输那个模型的视觉能力，这属于模型选择/连接层，不在本轮范围。
3. `photo_gallery` 的 `images` 仍然接受用户原话里的 https 链接（宿主把本次上传图放在首位），
   这是数据字段不是封面字段；`imageUrl` 这类「卡片的图」才被拒绝。
