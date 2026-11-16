# 联网搜索改为免费 DuckDuckGo，read_url 只用本地抓取（2026-11-04）

> **已更新（2026-11-04）**：生产服务器（阿里云杭州）实测 `html.duckduckgo.com` 12 s 超时不可达；
> `cn.bing.com/search` 200/0.35 s 可解析。默认免费首路已改为 Bing 中国站 HTML，DuckDuckGo 退为显式 `ddg` 选项。
> 本文件保留 DDG 适配器与 `read_url` 决策的历史依据，现行链路见
> [2026-11-04-free-search-bing.md](2026-11-04-free-search-bing.md)。

- worktree：`work/backend-merge`（分支 `codex/live-backend-20261103`），基线 `9b35b7c`，工作树干净。
- 背景：同日上一轮把 `auto` 的搜索首路改成 DeepSeek 官方 Search/Fetch API，并让 `read_url` 先走 DeepSeek Fetch。
  **用户明确拒绝付费接口**（按次计费、不划算），要求只用免费链路。本决策撤销那条付费路径，改为免费替代：
  DuckDuckGo HTML 搜索 + 现有本地 HTTPS 抓取器。
- 结论：`VIVIC_SEARCH_PROVIDER` 只保留 `ddg|exa|auto`；`auto` = DuckDuckGo → Exa；`read_url` 只走本地抓取器。
  全链路**免费、无额度、无 key**。只改后端源码/测试/文档，不部署、不碰服务器、不跑 60/48；单测本地运行。

## 1. Provider 链与开关

| 配置 | 实际顺序 | 说明 |
|---|---|---|
| `VIVIC_SEARCH_PROVIDER=auto`（默认，未设置/拼错也回到 auto） | DuckDuckGo HTML → GPT 搜索（已连接且被选中时）/ StepSearch（有 StepFun key 时）→ Exa | 免费首路；原有账号链路排序不变；Exa 永远最后 |
| `VIVIC_SEARCH_PROVIDER=ddg` | 仅 DuckDuckGo HTML | 显式只要免费首路；失败如实报错，不回退 Exa |
| `VIVIC_SEARCH_PROVIDER=exa` | 仅 Exa | 显式只要这个免 key 端点；不请求 DuckDuckGo |

- 原 `deepseek` 模式删除：现在写 `VIVIC_SEARCH_PROVIDER=deepseek` 会落到 `auto`（免费首路），不会再触发任何付费调用。
- `src/search/deepseek.ts` 与其测试整文件删除；`app.ts` 里的 `deepseekSearchKey()`（读主 provider/key 的付费路径）一并删除。
  DeepSeek 仍是可选的主规划模型（`VIVIC_MAIN_PROVIDER=deepseek` / `DEEPSEEK_API_KEY`），只是**不再有任何搜索/抓取接口消费它**。

## 2. DuckDuckGo HTML 适配器

- 新增 `src/search/duckduckgo.ts`：`callDuckDuckGoSearch()` + 纯解析函数 `parseDuckDuckGoHtml()`，
  provider 标注 `duckduckgo/html`。
- 请求：`GET https://html.duckduckgo.com/html/?q=<encodeURIComponent(query)>`，走既有 `requestPublicHttps`
  （固定 endpoint，不是用户/模型给的 URL；DNS 只解析公网地址后固定 IP 连接；不跟随重定向；`Accept-Encoding: identity`；
  响应受 `maxResponseBytes` 限制）。
- UA：普通桌面浏览器串（`Mozilla/5.0 … Chrome/128 Safari/537.36`）+ `Accept: text/html` + `Accept-Language`。
  不发送 cookie、referer 或任何凭据；请求里只有 query。
- 解析（纯字符串，不执行 JS、不加载子资源）：
  - 标题与链接取自 `a.result__a`，摘要取自紧随其后的 `.result__snippet`（`<a>` 或 `<div>/<td>/<span>/<p>` 两种变体都支持）；
  - DDG 的结果链接是点击跳转壳：`//duckduckgo.com/l/?uddg=<urlencoded>`（也见过绝对形式）。
    解析时先做 HTML 实体解码，协议相对链接补 `https:`，再取 `uddg` 参数解码成真实 URL；
    相对链接（如 `/settings`）与站内链接直接丢弃；
  - 真实 URL 必须再过 `publicHttpsUrl`：只保留公开 **https** 结果，`http://`、内网/回环/保留地址、带端口、带 userinfo 全部丢弃；
  - 标题/摘要去标签、解实体、压空白，分别截 300 / 700 字；按 URL 去重，最多 `maxResults`（默认 5）条；
  - 映射到既有 `SearchEvidence`：`{ title, url, snippet, fetchedAt, provider: "duckduckgo/html", readFullPage: false }`。
- 失败语义（交给下一路，不伪造结果）：
  - 超时 / 非 200 / 3xx：`search-unavailable`（或既有超时错误）；
  - `202`、`429`：`search-rate-limited`；
  - 200 但页面是验证码/反爬页（`anomaly-modal`、`challenge-form`、`g-recaptcha`、"unusual traffic"、
    "bots use DuckDuckGo" 等标记）：同样按 `search-rate-limited` 处理，**绝不把验证码页当结果**；
  - 200 且页面没有 `result__a`（真的没结果）：返回空列表，由 provider 链继续下一路（与 Exa/StepSearch 的空结果一致）。
- 隐私：不记录 query 之外的数据，不写日志（与既有搜索一致，只有事件名）。

## 3. `read_url` 只走本地抓取器

- 工具面不变（`read_url(url)`，与 `search`/`weather` 互斥、必须单独调用）；变的是执行路径：
  `deps.search.readUrl()` = `fetchContent(url, signal, article=true)` = **只有**本地 `fetchBounded`。
- 本地抓取器保留全部安全边界：
  - `publicHttpsUrl`：只允许 `https:`、443、公开 hostname/IP；拒绝 userinfo、非 443 端口、localhost、
    内网/回环/链路本地/组播/保留地址、`http://`、非法主机名；
  - `requestPublicHttps`：DNS 解析 + 公网地址校验 + 固定 IP 连接（保留 TLS/SNI），不继承代理/cookie/凭据，不跟重定向；
  - 重定向逐跳校验：最多 3 次，每一跳的 `Location` 都重新过 `publicHttpsUrl`，越界直接 `search-blocked-url`；
  - 大小上限 `maxResponseBytes`（默认 256 KiB，声明长度与流式读取都检查）；只接受文本类型；
  - 正文用既有 jsdom + Readability 抽正文（不执行脚本、不加载子资源、元素数上限），按 `maxTextChars`
    （默认 20 000 字）截断并标 `truncated` / `readFullPage`，`trust: "untrusted-web-data"`，原始 HTML 从不进模型。
- `FetchEvidence.provider` 现在只有 `"vivic-bounded-https"`；`/api/fetch` 的 raw 视图行为不变。
- 付费路径删除后，`read_url` 失败不再有"已依次尝试 DeepSeek 抓取、直接抓取…"这种复合错误，直接给本地抓取器的诚实错误。

## 4. 缓存（不变）

- 搜索：key 为 trim 后的 query，TTL **10 分钟**（`searchCacheTtlMs`），上限 **100 条**（`searchCacheMaxEntries`）；
  只缓存非空成功结果，失败/空结果不缓存。
- `read_url` / 文章读取：key 为 `article:<规范化 href>`，TTL **20 分钟**（`readCacheTtlMs`），上限 **100 条**；
  `/api/fetch` raw 视图不缓存；失败不缓存。
- 缓存按 `createSearchClient` 实例隔离，进程内、无磁盘。

## 5. 测试（全部 mock，不打真实网络）

新增/重写：

| 文件 | 覆盖 |
|---|---|
| `tests/duckduckgo.test.ts`（新） | fixture 解析（`uddg` 跳转壳、相对链接、`http://`、内网、站内链接、重复）；条数上限；非 anchor 摘要；UA/无凭据；免费首路先于已连接 GPT；`auto` 顺序 ddg→exa；429/202/验证码页/500/乱码/超时 → 回退 Exa；两路都失败 → 诚实错误（含两路名称、无上游正文）；空结果继续下一路；`exa` 不请求 DDG；`ddg` 不回退；10 分钟缓存与失败不缓存；query 校验 |
| `tests/read-url.test.ts`（重写） | 只调用本地抓取器（断言没有 `authorization`/付费 endpoint、注入的 fetch 一次都没被调用）；非 https/内网/端口/userinfo 拒绝；截断；字节上限；纯文本；缓存与失败不缓存；逐跳重定向；失败如实报错 |
| `tests/search-free-only.test.ts`（新） | 源码扫描：`src/` 里不再出现付费 Search/Fetch 的 endpoint 常量、适配器名或 provider 标记；`VIVIC_SEARCH_PROVIDER` 只认 `ddg|exa|auto`（`deepseek` 落回 `auto`）；决策文档无按次价格 |
| `tests/search-deepseek.test.ts`、`tests/search-deepseek-app.test.ts`（删） | 付费适配器与其 app 装配已不存在 |

既有测试的调整（行为变化导致，非降低断言）：
- `tests/search-fallback.test.ts`、`tests/stepsearch.test.ts`、`tests/search.routes.test.ts`：这些文件验的是账号链路或 Exa 适配器，
  用 `createSearchClient({ duckduckgo: false })` 把免费首路移出链路（`false` = 不请求公共 HTML），断言内容不变；
- `tests/gpt-http.test.ts`：GPT 搜索成功路径现在会先打一次免费首路，断言从"没调用 `requestPublicHttps`"改为
  "只调用了免费首路，没有调用 Exa"，并把失败链路的错误文案更新为 `DuckDuckGo 搜索、StepSearch、公共搜索`；
- `tests/tool-read-url.test.ts`：证据 provider 从 `deepseek/fetch` 改为 `vivic-bounded-https`。

## 6. 验证

- `pnpm --filter @vivic/local-api test -- --maxWorkers=4`：失败集合与 HEAD（`9b35b7c`）差集 0（见第 7 节实测数字）。
- `pnpm --filter @vivic/local-api typecheck`：只剩既有 `tests/helpers.ts` 的 `LocalApiConfig` 错误。
- `oxlint` 改动文件：0 warning / 0 error。
- 未引入新依赖。

## 7. 未验证项

- **真实 DuckDuckGo 调用未跑**：本轮所有用例都用 `requestPublicHttps` 的 mock 和合成 HTML fixture。
  真实站点 2026-11-04 用浏览器 UA 实测 `html.duckduckgo.com/html/?q=…` 返回 200 且约 10 条结果，但以下未观测：
  真实页面的类名/markup 漂移、`uddg` 参数格式变化、不同地区/网络下的 202/429 触发频率、
  中文 query 的结果质量、真实限速恢复时间。
- 真实联网诊断 `VIVIC_SEARCH_LIVE=1` 未运行（不碰线上、不产生外网请求）；限速回退到 Exa 的真实时序未观测。
- 未给 DuckDuckGo 走用户的代理（`VIVIC_SEARCH_PROXY` 目前只作用于 Exa 固定端点）；在只能经代理出网的网络里，
  免费首路会失败并回退 Exa —— 这是有意的保守选择，代价是少一路免费来源。
- 真实模型是否按新工具描述稳定地"先 read_url、再建卡"未做在线 evals；单测只覆盖假 transport 的确定性路径。
- 缓存命中率、真实 TTL 体感、Exa 429 恢复情况未做线上统计。
