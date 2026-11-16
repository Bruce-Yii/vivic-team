import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSearchClient } from "../src/search/client.js";
import { SearchError } from "../src/search/errors.js";
import { requestPublicHttps } from "../src/search/transport.js";

// Synthetic fixtures only: the bounded local reader is the only network path.
vi.mock("../src/search/transport.js", async original => ({
  ...await original<typeof import("../src/search/transport.js")>(), requestPublicHttps: vi.fn(),
}));
const direct = vi.mocked(requestPublicHttps);

const article = (title: string, text: string) =>
  `<html><head><title>${title}</title></head><body><article><p>${text}</p></article></body></html>`;
const html = (body: string, title = "示例文章") => ({
  status: 200, contentType: "text/html", body: Buffer.from(article(title, body)),
});
const longText = "Public article text that is long enough for readability. ".repeat(6);

function harness(options: { maxTextChars?: number; provider?: "auto" | "bing" | "ddg" | "exa" } = {}) {
  const fetchImpl = vi.fn();
  const client = createSearchClient({
    provider: options.provider ?? "auto",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    config: { maxTextChars: options.maxTextChars ?? 20_000, attemptTimeoutMs: 40, fetchTimeoutMs: 2_000 },
  });
  return { client, fetchImpl };
}

beforeEach(() => { direct.mockReset(); });

describe("read_url / local bounded reader", () => {
  it("reads a public HTTPS page into FetchEvidence without any paid endpoint or injected fetch", async () => {
    direct.mockResolvedValue(html(`<p>${longText}</p><p>第二段正文。</p>`));
    const { client, fetchImpl } = harness();
    const page = await client.readUrl!("https://example.com/article");
    expect(page).toMatchObject({ url: "https://example.com/article", title: "示例文章",
      contentType: "text/html", format: "extracted-text", provider: "vivic-bounded-https",
      readFullPage: true, truncated: false, trust: "untrusted-web-data" });
    expect(page.text).toContain("Public article text");
    expect(page.text).not.toContain("<html");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(direct).toHaveBeenCalledTimes(1);
    const [url] = direct.mock.calls[0]!;
    expect(url).toBe("https://example.com/article");
    expect(JSON.stringify(direct.mock.calls)).not.toContain("api.deepseek.com");
  });

  it.each([
    "http://example.com/article",
    "https://127.0.0.1/article",
    "https://192.168.1.10/article",
    "https://localhost/article",
    "https://example.com:8443/article",
    "https://user:pass@example.com/article",
    "https://[::1]/article",
  ])("never calls the network for a non-public or non-HTTPS URL: %s", async url => {
    const { client, fetchImpl } = harness();
    await expect(client.readUrl!(url)).rejects.toMatchObject({ code: "search-blocked-url" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(direct).not.toHaveBeenCalled();
  });

  it("reads a public deepseek.com page through the local reader, not a paid tools endpoint", async () => {
    direct.mockResolvedValue(html(longText));
    const { client, fetchImpl } = harness();
    expect((await client.readUrl!("https://api.deepseek.com/v1/tools/fetch")).provider).toBe("vivic-bounded-https");
    expect(direct.mock.calls.map(([target]) => target)).toEqual(["https://api.deepseek.com/v1/tools/fetch"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("truncates an oversized body to maxTextChars and marks it", async () => {
    direct.mockResolvedValue(html(longText));
    const { client } = harness({ maxTextChars: 40 });
    const page = await client.readUrl!("https://example.com/long");
    expect(page.text).toHaveLength(40);
    expect(page.truncated).toBe(true);
    expect(page.readFullPage).toBe(false);
  });

  it("propagates the byte cap from the bounded transport", async () => {
    direct.mockRejectedValue(new SearchError("search-too-large", "网页响应超过大小限制。", 413));
    await expect(harness().client.readUrl!("https://example.com/huge")).rejects.toMatchObject({ code: "search-too-large" });
  });

  it("keeps plain text pages readable and titles them by host name", async () => {
    direct.mockResolvedValue({ status: 200, contentType: "text/plain", body: Buffer.from("plain page text") });
    const page = await harness().client.readUrl!("https://example.com/plain.txt");
    expect(page).toMatchObject({ text: "plain page text", contentType: "text/plain",
      format: "extracted-text", title: "example.com" });
  });

  it("caches a successful URL for twenty minutes and does not cache failures", async () => {
    direct.mockResolvedValue(html(longText));
    const { client } = harness();
    await client.readUrl!("https://example.com/cache");
    await client.readUrl!("https://example.com/cache");
    expect(direct).toHaveBeenCalledTimes(1);

    direct.mockRejectedValueOnce(new SearchError("search-unavailable", "网页不可读取。", 502));
    await expect(client.readUrl!("https://example.com/retry")).rejects.toBeDefined();
    direct.mockResolvedValueOnce(html(longText, "第二次成功"));
    expect((await client.readUrl!("https://example.com/retry")).title).toBe("第二次成功");
    expect(direct).toHaveBeenCalledTimes(3);
  });

  it("follows a public redirect hop by hop and reports the final URL", async () => {
    direct.mockResolvedValueOnce({ status: 302, contentType: "", location: "/moved", body: Buffer.alloc(0) })
      .mockResolvedValueOnce(html(longText));
    const page = await harness().client.readUrl!("https://example.com/old");
    expect(page.url).toBe("https://example.com/moved");
    expect(direct.mock.calls.map(([target]) => target)).toEqual(["https://example.com/old", "https://example.com/moved"]);
  });

  it("never substitutes another provider for a failed read", async () => {
    direct.mockRejectedValue(new Error("PRIVATE network detail"));
    const error = await harness().client.readUrl!("https://example.com/broken").catch(value => value);
    expect(error).toMatchObject({ code: "search-unavailable" });
    expect(String(error.message)).not.toContain("PRIVATE");
    expect(String(error.message)).not.toContain("deepseek");
    expect(direct).toHaveBeenCalledTimes(1);
  });
});
