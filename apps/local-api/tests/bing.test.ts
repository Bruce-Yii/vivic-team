import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchClient, SEARCH_PROVIDER } from "../src/search/client.js";
import { BING_HTML_ENDPOINT, BING_PROVIDER, parseBingHtml } from "../src/search/bing.js";
import { SearchError } from "../src/search/errors.js";
import { requestPublicHttps, type HttpsReply } from "../src/search/transport.js";
import { EXA_MCP_URL } from "../src/search/upstream/exa.js";

// Synthetic fixtures only: no live Bing/Exa request, no socket.
vi.mock("../src/search/transport.js", async original => ({
  ...await original<typeof import("../src/search/transport.js")>(), requestPublicHttps: vi.fn(),
}));
const direct = vi.mocked(requestPublicHttps);

const AT = "2026-11-04T00:00:00.000Z";
const bingUrl = (query: string) => `${BING_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
const isBing = (url: string) => url.startsWith(BING_HTML_ENDPOINT);
const shell = (target: string) => `https://www.bing.com/ck/a?!&amp;&amp;p=fixture&amp;ptn=3&amp;u=a1${
  Buffer.from(target, "utf8").toString("base64url")}&amp;ntb=1`;

const block = (title: string, href: string, snippet?: string) => `
  <li class="b_algo" data-id="fixture">
    <h2><a href="${href}" h="ID=SERP">${title}</a></h2>
    ${snippet === undefined ? "" : `<div class="b_caption"><p class="b_lineclamp4 b_algoSlug">${snippet}</p></div>`}
  </li>`;

/** One page mixing every link shape Bing emits, including unsafe targets. */
const fixture = `<html><body><ol id="b_results">
  ${block("深层 <strong>结果</strong> &amp; 实体", "https://example.com/direct?a=1&amp;b=2", "摘要 &amp; 更多 &lt;文本&gt; <strong>重点</strong>")}
  ${block("跳转壳", shell("https://example.org/decoded/path"), "壳摘要")}
  ${block("明文 HTTP", "http://insecure.example/page", "不应出现")}
  ${block("相对链接", "/search?q=internal", "不应出现")}
  ${block("重复结果", "https://example.com/direct?a=1&amp;b=2", "重复摘要")}
  ${block("无摘要", "https://no-snippet.example/x")}
  ${block("内网地址", "https://127.0.0.1/admin", "不应出现")}
  ${block("坏跳转壳", "https://www.bing.com/ck/a?u=a1!!!!", "不应出现")}
  ${block("", "https://fallback.example/a")}
</ol></body></html>`;

const bingReply = (html = fixture, status = 200): HttpsReply => ({ status, contentType: "text/html", body: Buffer.from(html) });
const exaReply = (url = "https://example.org/exa"): HttpsReply => ({ status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({
  jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Exa", url, text: "Keyless." }] }) }] },
})) });

function harness(options: { provider?: "auto" | "bing" | "ddg" | "exa"; config?: { attemptTimeoutMs?: number; timeoutMs?: number } } = {}) {
  const client = createSearchClient({
    provider: options.provider ?? "auto",
    config: { attemptTimeoutMs: 40, timeoutMs: 2_000, ...options.config },
  });
  return { client };
}

beforeEach(() => {
  direct.mockReset();
  direct.mockImplementation(async url => isBing(url) ? bingReply() : exaReply());
});

describe("Bing HTML parsing", () => {
  it("decodes ck/a shells, keeps only public HTTPS results, de-duplicates and drops unsafe links", () => {
    const results = parseBingHtml(fixture, 10, AT);
    expect(results.map(row => row.url)).toEqual([
      "https://example.com/direct?a=1&b=2",
      "https://example.org/decoded/path",
      "https://no-snippet.example/x",
      "https://fallback.example/a",
    ]);
    expect(results[0]).toMatchObject({
      title: "深层 结果 & 实体", url: "https://example.com/direct?a=1&b=2", snippet: "摘要 & 更多 <文本> 重点",
      fetchedAt: AT, provider: BING_PROVIDER, readFullPage: false,
    });
    expect(results[1]).toMatchObject({ title: "跳转壳", snippet: "壳摘要" });
    expect(results[2]).toMatchObject({ title: "无摘要", snippet: "" });
    // An empty title falls back to the public hostname.
    expect(results[3]).toMatchObject({ title: "fallback.example" });
  });

  it("caps the result count, title/snippet length and returns [] for a page with no hits", () => {
    expect(parseBingHtml(fixture, 2, AT)).toHaveLength(2);
    expect(parseBingHtml("<html><body>No results.</body></html>", 5, AT)).toEqual([]);
    const long = `<li class="b_algo"><h2><a href="https://example.com/long">${"题".repeat(400)}</a></h2>
      <p class="b_algoSlug">${"摘".repeat(900)}</p></li>`;
    const [row] = parseBingHtml(long, 5, AT);
    expect(row!.title).toHaveLength(300);
    expect(row!.snippet).toHaveLength(700);
  });

  it("accepts absolute and relative bing links only when they decode to a public HTTPS target", () => {
    const html = [
      block("直链", "https://example.com/a", "A"),
      block("协议相对", "//example.net/b", "B"),
      block("壳", `https://cn.bing.com/ck/a?u=a1${Buffer.from("https://example.org/c", "utf8").toString("base64url")}`, "C"),
      block("壳无前缀", `https://www.bing.com/ck/a?u=${Buffer.from("https://example.org/d", "utf8").toString("base64url")}`, "D"),
      block("壳坏 UTF-8", "https://www.bing.com/ck/a?u=a1___", "E"),
    ].join("");
    expect(parseBingHtml(html, 10, AT).map(row => row.url)).toEqual([
      "https://example.com/a", "https://example.net/b", "https://example.org/c",
    ]);
  });
});

describe("Bing search route", () => {
  it("is the default auto first route, with a browser UA, zh-CN Accept-Language and no credentials", async () => {
    const { client } = harness();
    const results = await client.webSearch("React 画布");
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ provider: BING_PROVIDER, url: "https://example.com/direct?a=1&b=2" });
    expect(direct).toHaveBeenCalledTimes(1);
    const [url, options] = direct.mock.calls[0]!;
    expect(url).toBe(bingUrl("React 画布"));
    expect(options).toMatchObject({ publicDnsFallback: false });
    expect(options).not.toHaveProperty("body");
    expect(options).not.toHaveProperty("method");
    expect(options.headers).toMatchObject({
      "User-Agent": expect.stringMatching(/^Mozilla\/5\.0 .*Chrome\/\d+/),
      Accept: "text/html",
      "Accept-Language": "zh-CN,zh;q=0.9",
    });
    expect(JSON.stringify(options)).not.toMatch(/authorization|cookie/i);
    expect(client.expectedProvider!()).toBe("bing");
  });

  it.each([
    ["429 rate limited", bingReply("", 429), "search-rate-limited"],
    ["202 accepted", bingReply("", 202), "search-rate-limited"],
    ["captcha page", bingReply(`<html><body><form action="/showcaptcha"><div class="captcha">请输入验证码</div></form>${block("不应解析", "https://example.com/x", "x")}</body></html>`), "search-rate-limited"],
    ["unusual traffic page", bingReply(`<html><body><p>Our systems detected unusual traffic from your network.</p>${block("不应解析", "https://example.com/x", "x")}</body></html>`), "search-rate-limited"],
    ["b_no without results", bingReply('<html><body><ol id="b_results"><li class="b_no">没有找到结果</li></ol></body></html>'), "search-rate-limited"],
    ["500 unavailable", bingReply("", 500), "search-unavailable"],
    ["garbled body", { status: 200, contentType: "text/html", body: Buffer.from([0xff, 0xfe, 0xfd]) }, "search-invalid-response"],
  ] as [string, HttpsReply, string][])("a Bing %s fails over to Exa", async (_name, reply, _code) => {
    direct.mockImplementation(async url => isBing(url) ? reply : exaReply());
    const { client } = harness();
    expect(await client.webSearch("fallback")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(direct.mock.calls.map(([url]) => url)).toEqual([bingUrl("fallback"), EXA_MCP_URL]);
  });

  it("a Bing timeout fails over to Exa", async () => {
    direct.mockImplementation(async url => {
      if (!isBing(url)) return exaReply();
      throw new SearchError("search-timeout", "联网查询超时，请稍后重试。", 504);
    });
    expect(await harness().client.webSearch("timeout")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(direct.mock.calls.map(([url]) => url)).toEqual([bingUrl("timeout"), EXA_MCP_URL]);
  });

  it("never parses a challenge page as results", async () => {
    direct.mockImplementation(async url => isBing(url)
      ? bingReply(`<html><body><div class="captcha">unusual traffic</div>${block("已损坏", "https://example.com/x", "x")}</body></html>`)
      : { status: 500, contentType: "application/json", body: Buffer.alloc(0) });
    await expect(harness().client.webSearch("challenge")).rejects.toMatchObject({ code: "search-rate-limited" });
    expect(JSON.stringify(direct.mock.calls)).not.toContain("example.com/x");
  });

  it("keeps real results even when the page also carries the b_no marker", () => {
    const html = `<html><body><ol>${block("真实结果", "https://example.com/real", "真实摘要")}<li class="b_no">no other results</li></ol></body></html>`;
    expect(parseBingHtml(html, 5, AT)).toMatchObject([{ url: "https://example.com/real" }]);
  });

  it("reports an honest error naming every route when Bing and Exa both fail", async () => {
    direct.mockRejectedValue(new Error("PRIVATE socket detail"));
    const error = await harness().client.webSearch("both-fail").catch(value => value);
    expect(error).toMatchObject({ code: "search-unavailable" });
    expect(String(error.message)).toContain("Bing 搜索、公共搜索");
    expect(String(error.message)).not.toMatch(/PRIVATE/);
  });

  it("treats an empty Bing page as no answer and asks Exa next", async () => {
    direct.mockImplementation(async url => isBing(url)
      ? bingReply("<html><body>Nothing here.</body></html>") : exaReply());
    expect(await harness().client.webSearch("no-hits")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(direct.mock.calls.map(([url]) => url)).toEqual([bingUrl("no-hits"), EXA_MCP_URL]);
  });

  it("is asked before a connected, preferred GPT account route in auto mode", async () => {
    const gptSearch = vi.fn(async () => [{ title: "GPT", url: "https://example.net/gpt", snippet: "gpt",
      fetchedAt: AT, provider: "pi-web-access/gpt-oauth" as const, readFullPage: false as const }]);
    const client = createSearchClient({
      config: { attemptTimeoutMs: 40, timeoutMs: 2_000 },
      gpt: { connected: () => true, preferred: () => true, search: gptSearch },
    });
    const results = await client.webSearch("free first");
    expect(results.every(row => row.provider === BING_PROVIDER)).toBe(true);
    expect(gptSearch).not.toHaveBeenCalled();
    expect(direct.mock.calls.map(([url]) => url)).toEqual([bingUrl("free first")]);
  });

  it("keeps the explicit modes: exa asks no free source, bing never falls back", async () => {
    direct.mockClear();
    expect(await harness({ provider: "exa" }).client.webSearch("only-exa")).toMatchObject([{ provider: SEARCH_PROVIDER }]);
    expect(direct.mock.calls.map(([url]) => url)).toEqual([EXA_MCP_URL]);
    expect(harness({ provider: "exa" }).client.expectedProvider!()).toBe("exa");

    direct.mockClear();
    direct.mockImplementation(async url => isBing(url) ? bingReply("", 429) : exaReply());
    const pinned = harness({ provider: "bing" });
    await expect(pinned.client.webSearch("only-bing")).rejects.toMatchObject({ code: "search-rate-limited" });
    expect(direct.mock.calls.map(([url]) => url)).toEqual([bingUrl("only-bing")]);
    expect(pinned.client.expectedProvider!()).toBe("bing");
  });

  it("caches a successful query for ten minutes and never caches a failure", async () => {
    const { client } = harness();
    await client.webSearch("Same query");
    await client.webSearch("  Same query  ");
    expect(direct).toHaveBeenCalledTimes(1);

    direct.mockImplementation(async url => isBing(url) ? bingReply("", 429) : Promise.reject(new Error("down")));
    await expect(client.webSearch("fresh query")).rejects.toBeDefined();
    direct.mockImplementation(async url => isBing(url) ? bingReply() : exaReply());
    expect(await client.webSearch("fresh query")).toHaveLength(4);
  });

  it("validates the query before any request", async () => {
    const { client } = harness();
    await expect(client.webSearch("   ")).rejects.toMatchObject({ code: "search-invalid-input" });
    await expect(client.webSearch("x".repeat(501))).rejects.toMatchObject({ code: "search-invalid-input" });
    expect(direct).not.toHaveBeenCalled();
  });
});
