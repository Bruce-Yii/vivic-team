# 通用卡：`create_card(kind="note")` 的标题 + 区块（2026-11-04）

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `5162fe0`。
- 范围：`apps/local-api/src/cards/note.ts`、`apps/local-api/src/intent/toolCalls.ts`、
  新测试 `tests/generic-card.test.ts`、`tests/tool-calls.test.ts`（一条既有断言随契约更新）、本文档。
- 契约来源：`docs/decisions/2026-11-04-generic-and-style-cards.md`（在仓库根的 main 工作区，
  本 worktree 未跟踪该文件）。
- 边界：没有部署、没有碰服务器、没有跑线上验收；没有新增卡型、没有改 `packages/contracts`、
  没有改前端。`NoteCard.sections` 契约本来就有，本轮只补工具面入口与 `style` 落点。

## 1. 断点

线上前端已经支持 `NoteCard.sections`，后端 `cards/note.ts` 的槽位也能构建分区便笺，但**模型
调不到**：工具面 `create_card(kind="note")` 的字段只有 `text`（`strictObject({text})`），没有
`sections`、没有 `title`、没有 `style`。于是「27 种卡型之外」的用户内容只有三条路：硬凑一个近似
卡型、塞进 `text` 变成一大段、或者干脆不建卡。

## 2. 契约（工具面）

`create_card(kind="note", fields)` 的字段：

| 字段 | 形状 | 说明 |
| --- | --- | --- |
| `text?` | string 1–500 | 一整段原文 |
| `sections?` | 1–4 个 `{title 1–40, items 1–6 × 1–180}` | 标题 + 区块 |
| `title?` | string ≤60 | 卡片总标题（区块各有自己的标题） |
| `style?` | `{tone?: neutral\|warm\|focus, accent?: default\|blue\|green\|amber\|rose}` | 表现层 |

- `text` 与 `sections` **二选一**：两个都给 → `invalid-param`；两个都不给（只给 `title`/`style`
  也算）→ `invalid-param`。两种情况都不建卡，并回传可执行的 issue。
- 超限一律**拒绝**，不截断：5 个区块、某区块 7 条、区块标题 41 字、条目 181 字、`text` 501 字、
  `title` 61 字、枚举外的 `tone`/`accent`。issue 里带出错字段路径（`sections.0.items` 等），
  模型据此合并同类或缩短后重试。
- 空 `style: {}` 当作没给：不写进卡片。

## 3. 落地方式

| 位置 | 值 | 理由 |
| --- | --- | --- |
| `displayProps.text` / `.bullets` / `.sections` | 模型给的内容 | 既有 `NoteCard` 契约，前端可直接渲染 |
| `sourceData.vicicStyle` | `style`（缺省不写） | `displayProps` 是**严格** schema，多一个未知字段会让线上整张卡被拒，所以表现层只能走 `sourceData` |
| `sourceData.vicicTitle` | `title`（缺省不写） | 同上；`NoteCard.displayProps` 本来就没有标题字段，契约不在本轮改动范围内 |

- 构建仍然只经过 `cards/note.ts` 的 `noteContract.build`：工具层不手写 `CardRecord`，`NoteSlotsSchema`
  在 builder 里再校验一次，`createCardActions` 负责 id/布局/时间戳。工具层的参数 schema
  （`NoteArgsSchema`）就定义在 `cards/note.ts`，工具面与构建器不会漂移。
- 分区便笺仍走 `standard` 变体、宽 340、高 220–420；`text`/`bullets` 仍是 `minimal`/320×120。
- `style` 只影响外观（语气、强调色），不改内容；前端支持后从 `sourceData.vicicStyle` 读取。
- 顺带修的两处可寻址性（同一文件内，行为只增不减）：画布摘要的卡片标签在 `text` 缺失时用
  `sourceData.vicicTitle` 或首个区块标题兜底，`find_cards` 也能按区块标题/条目命中——否则一张纯
  分区卡在摘要里没有名字，模型后面无法指代它。

## 4. prompt 与 issue

- `create_card` 的逐 kind 字段行改成通用卡的完整契约（二选一、上限、`title`、`style`、内容来自原话）。
- 系统提示新增第 7b 条：27 种卡型之外的用户内容用 `kind="note"` 表达成「标题 + 1–4 个区块」，
  **不要硬凑别的卡、也不要因为"没有卡型"就不建卡**；超过上限就合并同类或
  `clarify(missing="content")`，绝不丢内容；`style` 用户没提就不填。
- 删掉了原来那句自相矛盾的「不要走 `create_card(kind="note")`」：现在它只禁止**用便笺假装事情
  已经办了**，并保留「有对应卡型时不要用 `kind=note` 顶替」。

## 5. 测试

新增 `apps/local-api/tests/generic-card.test.ts`（23 条）：

| 用例 | 断言 |
| --- | --- |
| `text` only | NoteCard、`displayProps` 只有 `text`、`sourceData` 为空、`minimal`/320×120、契约通过 |
| `sections` only | `displayProps.sections` 与输入一致、`standard`/340、高 220–420、`NoteCardSchema.parse` 通过 |
| `title` + `sections` | 标题只进 `sourceData.vicicTitle`，`displayProps` 里没有；画布摘要用它当卡片名 |
| `text` 与 `sections` 同时给 | `invalid`、无动作、`invalid-param`、issue 说"只能给一个" |
| 两个都不给（含只给 `title`） | `invalid`、无动作、`invalid-param`、issue 提 `便笺`/`sections` |
| 超限 9 种（5 区块/7 条目/41 字标题/181 字条目/501 字 text/61 字 title/非法 tone/非法 accent/空区块） | 全部 `invalid-param`、不建卡、issue 带出错字段 |
| 一句里一条合法一条超限 | 整批回退，issue 标 `#2 create_card(note)` |
| `find_cards` | 纯分区卡（没有 `text`）也能按卡片标题、区块标题、条目文字命中 |
| `style` | 只进 `sourceData.vicicStyle`，`displayProps` 里搜不到 `style`/`amber`，`NoteCardSchema` 通过 |
| 不给 `style` / 给空 `style` | `sourceData` 里没有 `vicicStyle`（后者整体为空） |
| 工具描述与系统提示 | 含"通用卡"、`sections`、1–4、1–6、"不要为了凑卡型"、"每个字都必须来自用户原话"、不再含旧的反向禁令 |
| 管线（假 provider）带 `sections` on | 工具轮被调用、planner 未被调用、提交的 NoteCard 区块完整、`sourceData.vicicTitle` 在 |
| 管线 `sections` off | 同一句话仍然落卡：区块被兼容层压成 `text`，渲染不空 |

既有 `tests/tool-calls.test.ts` 的一条断言随契约更新：`create_card(kind="note", fields={})` 的
issue 从 `missing-param` 改为 `invalid-param`（内容现在是"`text` 与 `sections` 二选一"的规则，
不是某一个必填键缺失），提示语仍然包含"便笺"。

## 6. 验证（本机，`work/backend-merge`）

- `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：**8 failed / 2609 passed / 3 skipped**
  （2620 条）。失败集合与 HEAD（`5162fe0`，8 failed / 2586 passed / 3 skipped，2597 条）逐条一致，
  差集 0。测试数 2597 → 2620（新增 23 条）。
- `pnpm --filter @vivic/local-api typecheck`：只剩既有的 `tests/helpers.ts(8,23)`。
- `pnpm exec oxlint apps/local-api/src apps/local-api/tests`：改动文件 0 error。

## 7. 已知边界（本轮没做）

1. **前端渲染**：`sourceData.vicicStyle` 目前没有任何渲染方读取；`vicicTitle` 同理。前端要按
   设计文档 §4 读 `sourceData` 并映射到 CSS 变量，那时通用卡才会看起来和普通便笺不一样。
2. **布局维度**（`layout: stacked|two-column`）没进契约：等前端支持后再加，避免给模型一个
   前端会忽略的字段。
3. **`title` 的位置是临时方案**：`NoteCard.displayProps` 没有标题字段，所以先放
   `sourceData.vicicTitle`。若以后在 `packages/contracts` 里给 `NoteCard` 正式加 `title`，这里要
   跟着迁到 `displayProps` 并同步前端。
4. **`bullets`** 仍是便笺的第三条形状（契约早就有，工具面不暴露），本轮没动；通用卡只讲
   `text` 与 `sections`。
5. 没有新增工具、没有放宽任何既有 kind 的校验：`note` 之外的 10 个 kind 一字未改。
