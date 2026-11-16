# 免费搜索默认改为 Bing 中国站 HTML，DuckDuckGo 退为境外选项（2026-11-04）

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `30ef070`。
- 前序决策：[2026-11-04-free-search-duckduckgo.md](2026-11-04-free-search-duckduckgo.md) 把 `auto` 的免费首路定为
  DuckDuckGo HTML，并保留 Exa/MCP 兜底。本决策只替换**默认免费首路**，不改缓存、不改 `read_url`、不改账号链路。
- 只改后端源码/测试/文档；不部署、不碰服务器写入、不跑真实外网诊断；单测全部 mock。

## 1. 为什么弃用 DuckDuckGo 作默认

2026-11-04 在**生产服务器（阿里云杭州）**用 curl 实测（不是本机、不是浏览器）：

| 端点 | 实测结果 |
|---|---|
| `https://html.duckduckgo.com/html/?q=test` | **连不上**：12 s 无响应后 timeout，符合境内网络不可达 |
| `https://cn.bing.com/search?q=…` | **200，约 0.35 s**，HTML 中可解析出 10 个 `li.b_algo` 结果块 |
| `https://mcp.exa.ai/mcp` | 可达（GET 405，POST 可用），但免 key 共享额度会 429 |

因此把默认免费首路改成 **Bing 中国站 HTML**：境内网络可达、无 key、无按次计费、返回服务端渲染结果。
DuckDuckGo 仍保留代码与显式开关，供境外部署使用；它在境内生产环境不是可用默认值。

## 2. Provider 链与开关

| 配置 | 实际顺序 | 说明 |
|---|---|---|
| `VIVIC_SEARCH_PROVIDER=auto`（默认，未设置/拼错也回到 auto） | **Bing HTML** → GPT 搜索（已连接且被选中时）/ StepSearch（有 StepFun key 时）→ Exa | 免费首路；账号链路排序不变；Exa 永远最后 |
| `VIVIC_SEARCH_PROVIDER=bing` | 仅 Bing HTML | 显式只要免费首路；失败如实报错，不回退 Exa |
| `VIVIC_SEARCH_PROVIDER=ddg` | 仅 DuckDuckGo HTML | 境外/可访问 DDG 的部署使用；**不再默认**，也不请求 Bing |
| `VIVIC_SEARCH_PROVIDER=exa` | 仅 Exa | 显式只要这个免 key 端点；不请求任何免费 HTML 源 |

- `auto` 的第一路固定是 Bing；DDG 不在 `auto` 链里，避免境内先等 10 s 超时。
- `expectedProvider()` 随模式返回 `bing` / `ddg` / `exa`，回退提示按实际回答的路由命名（如“Bing 搜索不可用，已改用公共搜索”）。
- 没有新增依赖；Exa 仍是 keyless MCP，账号链仍只使用后端内存凭据。

## 3. Bing HTML 适配器

- 新增 `apps/local-api/src/search/bing.ts`：`callBingSearch()` + 纯解析函数 `parseBingHtml()`，provider 标注 `bing/html`。
- 请求：`GET https://cn.bing.com/search?q=<encodeURIComponent(query)>`，走既有 `requestPublicHttps`
  （固定 endpoint，不是用户/模型给的 URL；DNS 只解析公网地址后固定 IP 连接；不跟随重定向；`Accept-Encoding: identity`；
  响应受 `maxResponseBytes` 限制；UTF-8 严格解码）。
- 头：普通桌面 Chrome UA（`Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/128 … Safari/537.36`）、
  `Accept: text/html`、`Accept-Language: zh-CN,zh;q=0.9`。不发送 cookie、referer 或任何凭据；请求里只有 query。
- 解析（纯字符串，不执行 JS、不加载子资源）：
  - 按 `li.b_algo` 切块；标题和链接取块内第一个 `h2 a` 的文本与 `href`；
  - 链接有两种形态：直链 `https://…`，或 Bing 点击壳
    `https://www.bing.com/ck/a?…&u=a1<base64url>`（`cn.bing.com` 同形）。`u` 去掉 `a1` 前缀后按 base64url 解码，
    严格 UTF-8 解码并确认是 `http(s)://`；前缀缺失、字符非法、长度非法或解码失败**直接丢弃该条**，不猜目标；
  - 相对链接按 endpoint 解析；落在 `bing.com` 站内、又不是可解码 `ck/a` 壳的链接丢弃；
  - 摘要优先取 `.b_caption p`，其次 `.b_algoSlug` / `.b_lineclamp*` 元素文本；没有摘要就留空字符串，不伪造；
  - 标题/摘要去标签、解 HTML 实体、压空白，分别截 300 / 700 字；标题为空时用 hostname；
  - 真实 URL 必须再过 `publicHttpsUrl`：只保留公开 **https** 结果，`http://`、内网/回环/保留地址、带端口、
    带 userinfo、非法主机名全部丢弃；按 URL 去重，最多 `maxResults`（默认 5）条；
  - 映射到既有 `SearchEvidence`：`{ title, url, snippet, fetchedAt, provider: "bing/html", readFullPage: false }`。
- 失败语义（交给下一路，不伪造结果）：
  - 超时 / 非 200 / 3xx：既有超时错误或 `search-unavailable`；
  - `202`、`429`：`search-rate-limited`；
  - 200 但命中反爬/验证码标记（`unusual traffic`、`verify you are human`、`are you a robot`、`showcaptcha`、
    `g-recaptcha`、`challenge-form`、`captcha`、`验证码`）：同样按 `search-rate-limited` 处理，**绝不把验证码页当结果**；
  - 200、没有任何 `li.b_algo`、但页面带 `b_no` 标记：视为限流/反爬，`search-rate-limited`（不当作“真的没结果”）；
  - 200 且确实无结果且无 `b_no`：返回空列表，由 provider 链继续下一路（与 Exa/StepSearch 的空结果一致）。
- 隐私：不记录 query 之外的数据，不写日志（与既有搜索一致，只有事件名）。

## 4. DuckDuckGo 现在的定位

- 代码（`src/search/duckduckgo.ts`）与解析测试保留，`VIVIC_SEARCH_PROVIDER=ddg` 仍可用；它不再出现在 `auto` 链里，
  也不再是任何默认值。
- 适用场景：部署在能访问 `html.duckduckgo.com` 的境外网络；境内生产环境实测不可达，继续设为默认会把每次搜索拖到 10 s 超时。
- `ddg` 模式失败不回退 Exa（与 `bing` 模式一致），只有 `auto` 才继续账号链和 Exa。

## 5. 缓存（不变）

- 搜索：key 为 trim 后的 query，TTL **10 分钟**（`searchCacheTtlMs`），上限 **100 条**（`searchCacheMaxEntries`）；
  只缓存非空成功结果，失败/空结果不缓存。
- `read_url` / 文章读取：key 为 `article:<规范化 href>`，TTL **20 分钟**（`readCacheTtlMs`），上限 **100 条**；
  `/api/fetch` raw 视图不缓存；失败不缓存。
- 缓存按 `createSearchClient` 实例隔离，进程内、无磁盘。

## 6. 测试（全部 mock，不打真实网络）

| 文件 | 覆盖 |
|---|---|
| `tests/bing.test.ts`（新） | fixture：直链、`ck/a` base64url 跳转壳、`http://`、相对/站内链接、重复、无摘要、空标题、坏壳、内网；只留公开 https、去重、条数/标题/摘要上限；UA/Accept/Accept-Language/无 cookie/无凭据；`auto` 先 Bing 再 Exa；Bing 先于已连接且被选中的 GPT；429/202/验证码页/unusual traffic/`b_no` 无结果/500/乱码/超时 → 回退 Exa；Bing+Exa 都失败 → 诚实错误（含两路名称、无上游正文）；空结果继续 Exa；`exa` 不请求免费源；`bing` 不回退；10 分钟缓存与失败不缓存；query 校验 |
| `tests/duckduckgo.test.ts`（改） | DDG 解析 fixture 保留；改为显式 `ddg` 模式：UA/无凭据、失败不回退 Exa/Bing、不请求已连接 GPT、空页返回空列表、缓存、query 校验 |
| `tests/search-fallback.test.ts`（改） | 用 `freeSearch: false` 把免费首路移出账号链路；回退提示覆盖 Bing |
| `tests/search.routes.test.ts`、`tests/stepsearch.test.ts`、`tests/gpt-http.test.ts`（改） | 同一 `freeSearch: false` 替换；GPT/StepSearch 的免费探针与错误文案更新为 Bing |
| `tests/search-free-only.test.ts`（改） | `VIVIC_SEARCH_PROVIDER` 接受 `bing|ddg|exa|auto`；默认 `expectedProvider()` 是 Bing；源码扫描确认默认值不再写 `"ddg"`；决策文档记录 Bing/DDG/免费链；付费 endpoint 仍不存在 |
| `tests/search.live.test.ts`（改） | 可选真实诊断接受 `bing/html` / `duckduckgo/html` / Exa provider；默认跳过，本轮未运行 |

## 7. 验证

- 全量 `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：**5 failed / 120 passed / 2 skipped（127 文件）**，
  **8 failed / 2733 passed / 3 skipped（2744 用例）**；失败集合与 HEAD（`30ef070`）逐条一致（8/8，差集 0），
  全部为既有失败（command-matrix、weekly-plan-grounding、provider-main-transport、deepseek、stepfun-stream）。
  基线为 5 failed / 119 passed（126 文件）、8 failed / 2714 passed（2725 用例）。
- `pnpm --filter @vivic/local-api typecheck`：仅既有 `tests/helpers.ts` 的 `LocalApiConfig` 错误。
- `oxlint` 改动文件：0 warning / 0 error。
- 未引入新依赖。

## 8. 未验证项

- **应用内真实 Bing 调用未跑**：服务器侧只做过上述 curl 探测；本轮所有用例都用 `requestPublicHttps` 的 mock 和合成 HTML
  fixture。真实 Bing 的 markup 漂移、`ck/a` 参数变体、不同网络下的验证码/429 触发频率、中文 query 的结果质量、限速恢复时间均未观测。
- 反爬标记（尤其宽泛的 `captcha`）在真实 Bing 正常页面的误报率未验证。实现已先剥掉 `<script>`/`<style>` 再匹配，
  降低脚本文本误报，但正常页面可见文案里出现这些词时仍可能被误判为限流。
- 真实联网诊断 `VIVIC_SEARCH_LIVE=1` 未运行（不碰线上、不产生外网请求）；Bing 限流回退 Exa 的真实时序未观测。
- Bing 不走用户的 `VIVIC_SEARCH_PROXY`（该代理目前只作用于 Exa 固定端点）；只能经代理出网的网络里，Bing 首路会失败并回退 Exa。
- 缓存命中率、真实 TTL 体感、Exa 429 恢复情况未做线上统计。
- 真实模型是否按工具描述稳定地“先 read_url、再建卡”未做在线 evals；单测只覆盖假 transport 的确定性路径。
