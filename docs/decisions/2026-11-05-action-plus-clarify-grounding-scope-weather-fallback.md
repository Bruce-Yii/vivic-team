# 动作 + 追问同批、事实/建议分域、天气兜底（2026-11-05）

> **2026-11-05 更新（天气兜底的输出形态已被取代）**：本文 §3 里「兜底成功 → 宿主直接提交
> SearchResultCard + 说明口播」不再成立；兜底结果只作为**检索事实**回灌，由模型回答或
> `create_card(kind="search_results")` 决定是否展示。
> 见 `2026-11-05-query-tools-are-read-only.md`。§1（动作 + clarify 同批）与 §2（事实/建议分域）仍有效。

- 分支：`codex/live-backend-20261103`（工作树 `work/backend-merge`），起点 `285c353`。
- 范围：`apps/local-api/src/intent/toolCalls.ts`、`apps/local-api/src/intent/pipeline.ts`、
  测试 `tests/tool-calls.test.ts`、`tests/clause-coverage.test.ts`、`tests/pipeline-rules-and-adapters.test.ts`、
  新增 `tests/todo-suggestions.test.ts`、`tests/weather-fallback.test.ts`、本文档。
  另同步了主仓 `work/` 下**未跟踪**的验收脚手架（`work/scenarios/scenarios-20261031.json`、
  `work/real-browser/accept60-final/accept60-rules.mjs`、`judge.mjs`）；它们不在本 worktree 的提交范围。
- 边界：没有部署、没有碰服务器、没有跑线上 60/48；没有新增依赖；没有改前端契约。

三件事都是**协议/契约**变化，不是再加一层提示词规则：

1. `clarify` 允许与动作同批（sc-52 的根因是协议 fork，不是模型不听话）；
2. 「内容必须来自原话」按字段分成**事实**与**建议**两类（sc-07 的根因是一刀切）；
3. `weather` 对外仍是一个工具，内部改成**结果能力**：适配器失败走搜索，城市歧义仍澄清。

---

## 1. 动作 + clarify 同批（sc-52）

### 1.1 旧协议为什么是 fork

`toolCalls.ts` 里有一条宿主规则：`clarify` 不能与任何其他工具同批，否则整批 `invalid`。
面对「记个便签明天交周报，然后设个倒计时（没说多久）」模型只有两个合法出口：

- 单独 `clarify`：问题问到了，但已经确定的便签也被丢掉；
- 只建便签：便签保住了，倒计时子句静默消失（随后被 `dropped-clause` 校验打回，再走修复轮）。

这不是提示词能解决的：协议本身要求二选一。

### 1.2 新契约

`planFromToolCalls` 不再因「同批出现 clarify」而拒绝；`clarify` 被当作批内的一个问题：

| 输入 | 输出 |
| --- | --- |
| 只有 `clarify` | 与旧行为完全一致：`kind: "clarify"`，零动作、零卡，`message` 是问题 |
| 动作（或宿主操作/查询）+ `clarify` | `kind: "envelope"`（有宿主操作时 `composite`）：已确定的动作照常执行，末尾追加一条 `subtitle.show`（问题，≤120 字），`spokenText` = 问题 |
| 两个 `clarify` | `invalid-param`（「一次只能问一个问题」），仍走既有修复轮 |
| `clarify` + `chat` 且无其他动作 | 仍是 `kind: "clarify"`（没有已确定的动作可执行） |

实现要点（`toolCalls.ts`）：

- 批内 `clarify` 在循环前解析一次：校验 `missing`/`question`，`missing=target` 仍生成候选
  （`targetCandidates`），问题仍按 `clarifyWithCandidates` 补齐候选名。
- `clarifyRejection`（「宿主已能推导的事实不许追问」）只在**单独 clarify** 时应用。批内不应用：
  一句话有两个子句时，「明天」可能属于便签而不是倒计时，宿主无法可靠归因；已确定的动作仍完整校验。
- 循环后：没有已确定动作 → 退回纯 `clarify`；有动作 → 追加 `subtitle.show` 并令
  `spokenText`/`say` = 问题。`subtitle.show` 也让既有的 `dropped-clause` 守卫把「缺参数的那一项」
  视为已说明，不再把整批打回。
- plan 上带 `missing`（有候选时带 `targetCandidates`），`pipeline.ts` 的 envelope 分支据此写
  `intentLog.clarifyMissing`，遥测口径与单独 `clarify` 一致。

### 1.3 工具描述 / 系统提示

- `clarify` 工具描述：删掉「不要和其他工具同批」，改为「可以与其他工具同批：同一句里已经能确定的
  动作先做完，再用 clarify 只问缺的那一项；不许因为一件缺参数就把另一件丢掉」。
- 系统提示 12b：普通复合句缺参数时，从「要么补齐参数，要么整体 clarify」改为「把已确定的动作照常
  返回，再用 clarify 只问缺的那一项；动作和 clarify 可以同批，宿主先执行动作再问」；只有整句都无法
  确定时才单独 clarify。
- `dropped-clause` 的修复提示同步：「确实缺信息就用 clarify(missing=…) 只问缺的那一项，已经能确定
  的动作可以和 clarify 同批返回」。

### 1.4 测试与数据集（产品变化）

- `tests/tool-calls.test.ts`：原来的「rejects clarify mixed with a create」改写为新契约
  （`NoteCard` + `subtitle.show` + `say` = 问题）；新增「单独 clarify 不变」和「两个 clarify 被拒」。
- `tests/clause-coverage.test.ts`：新增 pipeline 级用例——`[note, clarify(time)]` 一批、零修复轮，
  输出 `NoteCard` + `spokenText`「倒计时设多长时间？」+ `subtitle.show`，不建 `CountdownCard`。
  原「修复轮后整句澄清、零卡」的用例保留：模型自己选择单独澄清时行为不变。
- **sc-52 数据集期望改为产品变化**（`work/scenarios/scenarios-20261031.json`）：
  `expected_card_types: ["NoteCard"]`，notes 明写旧期望「整句澄清、零卡」已废弃；
  `accept60-rules.mjs` 与 `judge.mjs` 的 `CLARIFY_EXPECTED` 移除 `sc-52`。
  新口径下：便签 + 追问 = 通过；只建便签不问、或整句澄清零卡 = 失败。

---

## 2. 事实 / 建议分域（sc-07）

### 2.1 旧规则为什么一刀切

系统提示原来只有一句「只填用户说过的事实；没说的钟点、日期、数量不要编」。它把「建议事项」也当成
事实：用户说「准备搬家」，模型不敢给出「打包、约搬家公司、改地址」，只能反问，于是 sc-07 零卡。

### 2.2 字段分类表

| 类别 | 字段/内容 | 允许来源 | 宿主校验 |
| --- | --- | --- | --- |
| **事实** | 日期、时间、钟点、数字、价格、来源、链接、引用、人名/机构名、已有卡片内容 | 用户原话、工具结果、画布已有内容；相对日期可由宿主换算 | scene/chart/habit/schedule 的 grounding；todo 条目里的显式日期/钟点/价格/链接（见下）；note 原文 |
| **建议 / 规划 / 摘要** | 待办清单的建议事项、计划步骤、摘要的组织方式、卡片标题的概括 | 模型可以生成 | 不要求逐字来自原话；但不得写成「用户说…」，必要时用「建议」措辞 |

系统提示第 5 条替换为这张表的两类表述；第 7b 条保留便笺「每个字都必须来自用户原话」，
并注明「这条是便笺的原文记录语义；待办的常规建议事项不受此限」。

### 2.3 `create_card(kind=todo)`

- 允许模型为用户目标生成常规建议事项：
  「准备搬家」→ `title=搬家清单` + `items=[打包物品, 预约搬家公司, 变更收货地址]`。
- 工具描述（`CREATE_KIND_LINES` 的 `kind=todo`、`CREATE_CARD_DESCRIPTION`）与系统提示
  「建清单不等于加条目」同步：可以补建议事项，但不得伪装成用户原话；用户明确说条目时照原话。
- 删掉 fail hint 里的「items 必须都是用户说过的条目」：
  - 空 items → 「items 至少放一条具体待办（可以是常规建议事项）；日期/数字/价格/链接必须来自原话」；
  - 追加无条目 → 「在 items 里放要追加的具体条目（可以是建议事项）」；
  - builder 失败 → 「检查 items 是否都是非空条目；日期/数字/价格/链接必须来自原话，普通建议事项可以保留」。
- 新增**只针对事实字段**的校验 `inventedFactIn`（追加路径同样生效）：条目文本里的
  - ISO 日期、`M月D日`、钟点（`9:30`/`9点`）、价格（`5000元`/`¥5000`）、URL
  必须在原话里出现，或（日期）能由原话的相对日期唯一推导；否则 `ungrounded` 退回。
  - 普通建议文字、没有单位/日期的数字不校验——它们是规划，不是事实声明。
- 便笺（note）语义不变：`text`/`sections` 仍是用户原文的记录，工具层不生成、不改写、不截断。

### 2.4 测试

新增 `tests/todo-suggestions.test.ts`（8 条）：

- 生成的建议事项通过，且是真实 `TodoCard`（走 `todoContract.build`）；
- 编造 ISO 日期 / 价格 / 链接 → `invalid` + `ungrounded`，零卡；
- 用户真的说过的日期通过；追加路径同样受事实校验；
- note 仍逐字记录原文；系统提示含「事实与建议分开」「待办清单的建议事项」「不得伪装成用户说过的事实」，
  且不再含旧的一刀切句子。

---

## 3. 天气做成「结果能力」

对外仍是同一个 `weather` 工具（描述、参数不变）；内部把「天气服务」降级为第一层证据源。

### 3.1 兜底链

```
weather 工具
  └─ 已验证天气适配器（Open-Meteo + GeoNames/Photon）
       ├─ 成功            → WeatherCard（行为不变）
       ├─ clarify（缺城市/歧义）→ 交给模型澄清；不触发搜索
       └─ 失败（超时/服务不可用/5xx/数据不可解析）
            └─ 已验证搜索链（query = 城市 + 天 + 天气；没城市时用原话）
                 ├─ 成功 → SearchResultCard + subtitle/spokenText
                 │         「天气服务暂时不可用，已改用联网搜索」
                 └─ 失败 → kind: "error"，一句话里同时给出
                           天气失败原因 + 搜索失败原因（两层各自的原因）
```

- **失败判定**：适配器错误在内部被标记为 `source: "adapter"` + `interrupt.reason:
  "vendor-unavailable"`；城市澄清没有这个标记。工具循环据此区分「该问的」和「该兜底的」。
- **不掩盖澄清**：`clarify`（缺城市、同名地点歧义）仍按原路径回传模型，走修复轮/追问，绝不拿搜索
  兜底。
- **单批与混批一致**：单独 `weather` 和「weather + 建卡」都走同一条兜底；搜索成功的 envelope 与
  同批卡片用既有 `mergeEnvelopes` 合并（查询结果在前），并保留「已改用联网搜索」说明。
- **不改提示词分工**：模型仍只选 `weather` 工具；搜索是宿主内部的第二层，模型不需要知道。
- 兼容旧 planner 的 `lookup` 路径：同一兜底链也接在 `lookup.kind=weather` 的适配器重入上。

### 3.2 测试

新增 `tests/weather-fallback.test.ts`（5 条，全部 mock，无真实网络）：

- 天气适配器超时 → 搜索被调用（query 含城市与「天气」）→ `SearchResultCard` +
  `spokenText`/`subtitle.show` 说明「天气服务暂时不可用，已改用联网搜索」；
- 同批还有待办 → `SearchResultCard` + `TodoCard` 都在，说明与卡片话术都在；
- 城市歧义（适配器 clarify）→ 搜索 **0 次**，结果是澄清；
- 两层都失败 → `kind: "error"`，消息同时含「天气查询超时」与「联网查询暂不可用」；
- 没有搜索链 → 消息含天气失败原因 + 「联网搜索也没有配置」。

既有 `tests/pipeline-rules-and-adapters.test.ts` 里「adapter error 回传 issues」的用例改用
**search** 适配器失败（天气错误已改为走兜底链），保留「搜索失败仍给模型一次修复轮」的契约。

---

## 4. 验证

- 全量：`pnpm --filter @vivic/local-api test -- --maxWorkers=4`
  - 改动前 HEAD `285c353`：**8 failed / 2780 passed / 3 skipped（2791）**；
  - 改动后：**8 failed / 2796 passed / 3 skipped（2807）**；
  - 失败集合逐条比对（`work/verify/backend-merge-20261105/baseline-failures.txt` 与
    `after-failures.txt`，`Compare-Object`）：**差集 0**，8 条都是既有失败
    （command-matrix / deepseek / provider-main-transport ×3 / stepfun-stream / weekly-plan-grounding ×2）。
  - 新增 16 条通过：`todo-suggestions` 8、`weather-fallback` 5、`clause-coverage` +1、
    `tool-calls` 净 +2。
- 类型：`pnpm --filter @vivic/local-api typecheck`（`tsc -b`）仅既有 `tests/helpers.ts:8`
  （`modelApiBaseUrl` 可选性），无新增。
- Lint：`pnpm exec oxlint` 改动/新增的 7 个源码与测试文件：**0 warnings / 0 errors**。
- 定向：`tool-calls` 193、`clause-coverage` 36、`todo-suggestions` 8、`weather-fallback` 5、
  `pipeline-rules-and-adapters` 7，全部通过。

## 5. 未做 / 只能线上验证的

- **模型是否真的这样调用**：本地单测锁定的是宿主契约（同批允许、执行动作、说出问题；todo 建议事项
  通过、事实退回；天气失败走搜索）。真实模型是否在 sc-52 选择「便签 + 追问」而不是又只做一半，
  需要下一轮线上跑批验证。
- **搜索兜底的召回质量**：兜底查询是「城市 + 天 + 天气」，搜索命中的结果是否足以回答「要不要带伞」
  取决于搜索源，不在宿主保证范围内；两层都失败时只保证如实说明。
- **线上 60/48**：按约束未跑；sc-52 的判分口径已同步到 `accept60-rules.mjs` / `judge.mjs`。
- 主仓 `work/` 下的数据集与判分脚本是未跟踪的评测脚手架，改动不进入本 worktree 的提交。
