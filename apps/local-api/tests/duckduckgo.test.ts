import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchClient } from "../src/search/client.js";
import { DUCKDUCKGO_HTML_ENDPOINT, DUCKDUCKGO_PROVIDER, parseDuckDuckGoHtml } from "../src/search/duckduckgo.js";
import { SearchError } from "../src/search/errors.js";
import { requestPublicHttps, type HttpsReply } from "../src/search/transport.js";

// Synthetic fixtures only: no live DuckDuckGo/Bing/Exa request, no socket.
vi.mock("../src/search/transport.js", async original => ({
  ...await original<typeof import("../src/search/transport.js")>(), requestPublicHttps: vi.fn(),
}));
const direct = vi.mocked(requestPublicHttps);

const AT = "2026-11-04T00:00:00.000Z";
const ddgUrl = (query: string) => `${DUCKDUCKGO_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`;
const wrapped = (target: string) => `//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}&rut=fixture`;

const result = (title: string, href: string, snippet: string) => `
  <div class="result results_links results_links_deep web-result">
    <div class="links_main links_deep result__body">
      <h2 class="result__title">
        <a rel="nofollow" class="result__a" href="${href}">${title}</a>
      </h2>
      <a class="result__snippet" href="${href}">${snippet}</a>
    </div>
  </div>`;

/** One page mixing every link shape DDG emits, including unsafe targets. */
const fixture = `<!DOCTYPE html><html><body><div id="links" class="results">
  ${result("深层 <b>结果</b>", wrapped("https://example.com/deep?a=1&b=2").replace(/&/g, "&amp;"), "摘要 &amp; 更多 &lt;文本&gt;")}
  ${result("相对链接", "/l/?uddg=" + encodeURIComponent("https://example.org/relative"), "相对摘要")}
  ${result("明文 HTTP", wrapped("http://insecure.example/page"), "不应出现")}
  ${result("内网地址", wrapped("https://127.0.0.1/admin"), "不应出现")}
  ${result("直接链接", "https://direct.example/path", "直接摘要")}
  ${result("重复结果", wrapped("https://example.com/deep?a=1&b=2").replace(/&/g, "&amp;"), "重复摘要")}
  ${result("站内链接", "/settings", "不应出现")}
</div></body></html>`;

const ddgReply = (html = fixture, status = 200) => ({ status, contentType: "text/html", body: Buffer.from(html) });
const isDdg = (url: string) => url.startsWith(DUCKDUCKGO_HTML_ENDPOINT);

/** DuckDuckGo is now the explicit `ddg` route for networks outside mainland China. */
function harness(config: { attemptTimeoutMs?: number; timeoutMs?: number } = {}) {
  const client = createSearchClient({
    provider: "ddg",
    config: { attemptTimeoutMs: 40, timeoutMs: 2_000, ...config },
  });
  return { client };
}

beforeEach(() => {
  direct.mockReset();
  direct.mockImplementation(async url => isDdg(url) ? ddgReply() : Promise.reject(new Error(`unexpected ${url}`)));
});

describe("DuckDuckGo HTML parsing", () => {
  it("decodes uddg redirects, keeps only public HTTPS results and de-duplicates", () => {
    const results = parseDuckDuckGoHtml(fixture, 10, AT);
    expect(results.map(row => row.url)).toEqual([
      "https://example.com/deep?a=1&b=2",
      "https://example.org/relative",
      "https://direct.example/path",
    ]);
    expect(results[0]).toMatchObject({
      title: "深层 结果", url: "https://example.com/deep?a=1&b=2", snippet: "摘要 & 更多 <文本>",
      fetchedAt: AT, provider: DUCKDUCKGO_PROVIDER, readFullPage: false,
    });
    expect(results[1]!.title).toBe("相对链接");
    expect(results[2]).toMatchObject({ title: "直接链接", snippet: "直接摘要" });
  });

  it("caps the result count and returns an empty list for a page with no hits", () => {
    expect(parseDuckDuckGoHtml(fixture, 2, AT)).toHaveLength(2);
    expect(parseDuckDuckGoHtml("<html><body><p>No results.</p></body></html>", 5, AT)).toEqual([]);
  });

  it("reads excerpts from a non-anchor snippet element and falls back to the hostname", () => {
    const html = `<div class="result"><h2><a class="result__a" href="${wrapped("https://example.net/article")}"></a></h2>
      <td class="result__snippet">切片 <b>摘要</b></td></div>`;
    expect(parseDuckDuckGoHtml(html, 5, AT)).toMatchObject([
      { title: "example.net", url: "https://example.net/article", snippet: "切片 摘要" },
    ]);
  });
});

describe("DuckDuckGo explicit route", () => {
  it("answers from DuckDuckGo in ddg mode, with a browser UA and no key", async () => {
    const { client } = harness();
    const results = await client.webSearch("React 画布");
    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ provider: DUCKDUCKGO_PROVIDER, url: "https://example.com/deep?a=1&b=2" });
    expect(direct).toHaveBeenCalledTimes(1);
    const [url, options] = direct.mock.calls[0]!;
    expect(url).toBe(ddgUrl("React 画布"));
    expect(options).toMatchObject({ publicDnsFallback: false });
    expect(options).not.toHaveProperty("body");
    expect(options).not.toHaveProperty("method");
    expect(options.headers!["User-Agent"]).toMatch(/^Mozilla\/5\.0 /);
    expect(JSON.stringify(options)).not.toMatch(/authorization|cookie/i);
    expect(client.expectedProvider!()).toBe("ddg");
  });

  it.each([
    ["429 rate limited", ddgReply("", 429), "search-rate-limited"],
    ["202 accepted", ddgReply("", 202), "search-rate-limited"],
    ["200 challenge page", ddgReply('<html><body><form class="challenge-form" id="challenge-form">bots use DuckDuckGo too</form></body></html>'), "search-rate-limited"],
    ["500 unavailable", ddgReply("", 500), "search-unavailable"],
    ["garbled body", { status: 200, contentType: "text/html", body: Buffer.from([0xff, 0xfe, 0xfd]) }, "search-invalid-response"],
  ] as [string, HttpsReply, string][])("a DuckDuckGo %s is an honest failure, never an Exa or Bing request", async (_name, reply, code) => {
    direct.mockResolvedValue(reply);
    await expect(harness().client.webSearch("ddg-only")).rejects.toMatchObject({ code });
    // `ddg` pins the free route: it never falls back to Exa or Bing.
    expect(direct.mock.calls.map(([url]) => url)).toEqual([ddgUrl("ddg-only")]);
  });

  it("maps a timeout to the existing timeout code without a fallback", async () => {
    direct.mockRejectedValue(new SearchError("search-timeout", "联网查询超时，请稍后重试。", 504));
    await expect(harness().client.webSearch("timeout")).rejects.toMatchObject({ code: "search-timeout" });
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("never parses a challenge page as results", async () => {
    direct.mockResolvedValue(ddgReply(`<html><body><div class="anomaly-modal">unusual traffic</div>${result("已损坏", wrapped("https://example.com/x"), "x")}</body></html>`));
    await expect(harness().client.webSearch("challenge")).rejects.toMatchObject({ code: "search-rate-limited" });
    expect(JSON.stringify(direct.mock.calls)).not.toContain("example.com/x");
  });

  it("returns an empty list for a genuine empty page instead of inventing a route", async () => {
    direct.mockResolvedValue(ddgReply("<html><body>No results.</body></html>"));
    expect(await harness().client.webSearch("no-hits")).toEqual([]);
    expect(direct).toHaveBeenCalledTimes(1);
  });

  it("does not ask a connected GPT account in ddg mode", async () => {
    const gptSearch = vi.fn(async () => [{ title: "GPT", url: "https://example.net/gpt", snippet: "gpt",
      fetchedAt: AT, provider: "pi-web-access/gpt-oauth" as const, readFullPage: false as const }]);
    const client = createSearchClient({
      provider: "ddg",
      config: { attemptTimeoutMs: 40, timeoutMs: 2_000 },
      gpt: { connected: () => true, preferred: () => true, search: gptSearch },
    });
    const results = await client.webSearch("ddg first");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(row => row.provider === DUCKDUCKGO_PROVIDER)).toBe(true);
    expect(gptSearch).not.toHaveBeenCalled();
  });

  it("caches a successful query for ten minutes and never caches a failure", async () => {
    const { client } = harness();
    await client.webSearch("Same query");
    await client.webSearch("  Same query  ");
    expect(direct).toHaveBeenCalledTimes(1);

    direct.mockResolvedValue(ddgReply("", 429));
    await expect(client.webSearch("fresh query")).rejects.toBeDefined();
    direct.mockImplementation(async () => ddgReply());
    expect(await client.webSearch("fresh query")).toHaveLength(3);
  });

  it("validates the query before any request", async () => {
    const { client } = harness();
    await expect(client.webSearch("   ")).rejects.toMatchObject({ code: "search-invalid-input" });
    await expect(client.webSearch("x".repeat(501))).rejects.toMatchObject({ code: "search-invalid-input" });
    expect(direct).not.toHaveBeenCalled();
  });
});
