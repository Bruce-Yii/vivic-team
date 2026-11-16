import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { planFromToolCalls } from "../src/intent/toolCalls.js";
import { handleDataIntent } from "../src/data/index.js";
import { createIntentLogSink, intentPathOf } from "../src/observability/intentLog.js";
import { SearchError } from "../src/search/errors.js";
import type { FetchEvidence } from "../src/search/client.js";
import type { WeatherResult } from "../src/data/weather.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * Query tools are read-only.
 *
 * `weather` / `search` / `read_url` return verified *facts* once; the host builds
 * no card, writes no template line and commits no envelope for them. The model's
 * next turn decides the output shape:
 *
 *  - answer only            → `chat(reply=…)`, zero cards;
 *  - answer + card          → `chat(reply=…)` + `create_card(kind=weather|
 *                              search_results|article)`;
 *  - card only              → the `create_card` call.
 *
 * Publishing a query card is only allowed with this turn's evidence: no query →
 * the call is refused with `invalid-param` and a hint. Repeating the query in the
 * follow-up turn never executes it twice.
 *
 * The tool provider and the adapters are scripted; no live model or network.
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-query-read-only", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const credential = { apiKey: "TEST-query-read-only-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }

/** One scripted batch per model turn; running out throws instead of looping. */
const scriptedToolFetch = (replies: ToolReply[][]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const batch = replies.shift();
    if (!batch) throw new Error("unexpected extra model turn");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(batch).map((reply, index) => ({
      index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

const setup = (replies: ToolReply[][], overrides: Partial<PipelineDeps> = {}) => {
  const credentials = new CredentialStore();
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true,
      generate: async () => ({ ok: true, value: { reply: "unused planner" } }) },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, fetchImpl, calls };
};

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];
const cardTypes = (result: IntentResult) => cards(result).map(card => card.type);

const weatherEvidence = (): WeatherResult => ({
  kind: "weather", tempC: 9, conditionIcon: "cloud",
  location: { id: 1799963, name: "南京", latitude: 32.06, longitude: 118.78, country: "中国",
    country_code: "CN", admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA" },
  observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), weatherCode: 61, isDay: true,
  intervalSeconds: 900, modelGrid: { latitude: 32.06, longitude: 118.78 }, sources: [],
  day: 1,
  forecastDay: { date: "2026-11-05", tempMaxC: 15, tempMinC: 8, weatherCode: 61, conditionIcon: "rain",
    precipitationProbability: 80 },
});

const weatherClient = (weather: () => Promise<WeatherResult> = async () => weatherEvidence()): NonNullable<PipelineDeps["data"]> => ({
  handleDataIntent: (text, context, signal) => handleDataIntent(text, context, signal, { weather }),
});

const searchRows = [{
  title: "AI 新闻综述", url: "https://example.com/ai-news", snippet: "本周发布的多模态模型与推理成本进展。",
  fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
}, {
  title: "AI 算力投资", url: "https://example.com/ai-compute", snippet: "算力投资继续增长，推理成本下降。",
  fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
}];

const page = (): FetchEvidence => ({ url: "https://example.com/a", title: "示例文章",
  text: "第一段正文。第二段正文。", contentType: "text/markdown", format: "extracted-text",
  fetchedAt: new Date().toISOString(), provider: "vivic-bounded-https", readFullPage: true,
  truncated: false, trust: "untrusted-web-data" });

const readUrlSearch = (readUrl: (url: string) => Promise<FetchEvidence> = async () => page()) => ({
  webSearch: async () => searchRows, fetchContent: async () => { throw new Error("unused"); }, readUrl,
});

describe("a weather question: the model answers the question, not the card", () => {
  it("feeds tomorrow's verified numbers back and answers with zero cards", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: "明天" } }],
      [{ name: "chat", args: { reply: "明天南京 8~15℃，有雨，早晚偏凉，建议穿外套。" } }],
    ]);
    const weather = vi.fn(async () => weatherEvidence());
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(weather) });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cardTypes(result)).toEqual([]);
    expect(result.envelope?.spokenText ?? "").toContain("15");
    expect(result.envelope?.spokenText ?? "").toContain("外套");
    // Never the old card template.
    expect(result.envelope?.spokenText ?? "").not.toContain("已显示");
    // One query, one feed-back turn: the adapter ran exactly once.
    expect(weather).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // The second turn really saw the verified facts, not the card label.
    const fed = f.calls[1]!.messages.at(-1)!.content;
    expect(fed).toContain("南京");
    expect(fed).toContain("8~15°C");
    expect(fed).toContain("降水概率：80%");
    expect(fed).toContain("不要重复查询");
  });

  it("answers and publishes the WeatherCard in the same follow-up batch", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: "明天" } }],
      [{ name: "chat", args: { reply: "明天南京 8~15℃，有雨，建议穿外套。" } },
        { name: "create_card", args: { kind: "weather", fields: {} } }],
    ]);
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, data: weatherClient() });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cardTypes(result)).toEqual(["WeatherCard"]);
    const card = cards(result)[0]!;
    expect(card.type === "WeatherCard" ? card.displayProps : {}).toEqual({ tempC: 15, conditionIcon: "rain" });
    expect(card.type === "WeatherCard" ? card.sourceData : {}).toMatchObject({
      requestedCity: "南京", forecastDay: { date: "2026-11-05", tempMaxC: 15, tempMinC: 8, precipitationProbability: 80 },
    });
    // The model's answer is the spoken line; the card is not described by a host template.
    expect(result.envelope?.spokenText).toBe("明天南京 8~15℃，有雨，建议穿外套。");
  });

  it("does not spend a second query when the follow-up asks for the same weather again", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: "明天" } }],
      [{ name: "weather", args: { city: "南京", day: "明天" } }],
      [{ name: "chat", args: { reply: "明天南京 8~15℃，有雨，建议穿外套。" } }],
    ]);
    const weather = vi.fn(async () => weatherEvidence());
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(weather) });
    expect(weather).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("envelope");
    expect(cardTypes(result)).toEqual([]);
    // The repair prompt names the one rule: the query already ran.
    expect(f.calls[2]!.messages.at(-1)!.content).toContain("不要重复查询");
  });
});

describe("a search question: the model decides between a result card and an answer", () => {
  it("publishes a SearchResultCard with sources from this turn's search", async () => {
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "create_card", args: { kind: "search_results", fields: {} } }],
    ]);
    const webSearch = vi.fn(async () => searchRows);
    const result = await runIntent({ text: "最近有什么 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cardTypes(result)).toEqual(["SearchResultCard", "SearchResultCard"]);
    expect(cards(result).map(card => card.sources[0]?.url)).toEqual([
      "https://example.com/ai-news", "https://example.com/ai-compute",
    ]);
    expect(webSearch).toHaveBeenCalledTimes(1);
    // No host template line: the model did not answer, so the batch names its card.
    expect(result.envelope?.spokenText ?? "").not.toContain("已整理");
  });

  it("can cap how many of this turn's results are published", async () => {
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "create_card", args: { kind: "search_results", fields: { limit: 1 } } }],
    ]);
    const result = await runIntent({ text: "最近有什么 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch: async () => searchRows } });
    expect(cardTypes(result)).toEqual(["SearchResultCard"]);
    expect(cards(result)[0]!.sources[0]?.url).toBe("https://example.com/ai-news");
  });

  it("answers from the verified summaries with zero cards", async () => {
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "chat", args: { reply: "最近两条：多模态模型发布，推理成本继续下降。" } }],
    ]);
    const result = await runIntent({ text: "最近有什么 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch: async () => searchRows } });
    expect(result.kind).toBe("envelope");
    expect(cardTypes(result)).toEqual([]);
    expect(result.envelope?.spokenText).toContain("多模态模型");
    expect(result.envelope?.spokenText).not.toContain("已整理");
  });
});

describe("a user-supplied page: the model decides whether to publish the article card", () => {
  it("publishes kind=article with the read page as its body", async () => {
    const f = setup([
      [{ name: "read_url", args: { url: "https://example.com/a" } }],
      [{ name: "create_card", args: { kind: "article", fields: {} } }],
    ]);
    const readUrl = vi.fn(async () => page());
    const result = await runIntent({ text: "读一下这个链接 https://example.com/a", canvasContext: canvas() },
      { ...f.deps, search: readUrlSearch(readUrl) });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cardTypes(result)).toEqual(["SearchResultCard"]);
    expect(readUrl).toHaveBeenCalledTimes(1);
    const card = cards(result)[0]!;
    expect(card.displayProps).toMatchObject({ title: "示例文章" });
    expect(card.sourceData).toMatchObject({ provenance: "fetched-webpage", articleText: "第一段正文。第二段正文。" });
  });

  it("answers the page with zero cards when the model only says something", async () => {
    const f = setup([
      [{ name: "read_url", args: { url: "https://example.com/a" } }],
      [{ name: "chat", args: { reply: "这篇讲的是两段示例正文。" } }],
    ]);
    const result = await runIntent({ text: "读一下这个链接 https://example.com/a", canvasContext: canvas() },
      { ...f.deps, search: readUrlSearch() });
    expect(result.kind).toBe("envelope");
    expect(cardTypes(result)).toEqual([]);
    expect(result.envelope?.spokenText).toBe("这篇讲的是两段示例正文。");
  });

  it("reports a failed read honestly instead of publishing a page card", async () => {
    const f = setup([[{ name: "read_url", args: { url: "https://example.com/a" } }]]);
    const result = await runIntent({ text: "读一下这个链接 https://example.com/a", canvasContext: canvas() },
      { ...f.deps, search: readUrlSearch(async () => { throw new SearchError("search-blocked-url", "仅可读取公开 HTTPS 网页。", 400); }) });
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("网页没读成");
    expect(cardTypes(result)).toEqual([]);
  });
});

describe("query cards need this turn's evidence", () => {
  it("refuses create_card(kind=weather) with no weather evidence and names the next step", async () => {
    const plan = await planFromToolCalls([{ name: "create_card", arguments: { kind: "weather", fields: {} } }],
      canvas(), Date.now(), "明天南京要穿外套吗");
    expect(plan.kind).toBe("invalid");
    expect(plan.issues[0]!.code).toBe("invalid-param");
    expect(String(plan.issues[0])).toContain("weather");
    expect(plan.issues[0]!.hint).toContain("weather(city=");
    expect(plan.actions).toEqual([]);
  });

  it("refuses search_results and article without their evidence", async () => {
    for (const [kind, hint] of [["search_results", "search(query="], ["article", "read_url(url="]] as const) {
      const plan = await planFromToolCalls([{ name: "create_card", arguments: { kind, fields: {} } }],
        canvas(), Date.now(), "查一下最近的新闻");
      expect(plan.kind, kind).toBe("invalid");
      expect(plan.issues[0]!.code).toBe("invalid-param");
      expect(plan.issues[0]!.hint).toContain(hint);
    }
  });

  it("does not let a successful search be published as a weather card (fallback is search evidence)", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: "明天" } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } }],
      [{ name: "create_card", args: { kind: "search_results", fields: {} } }],
    ]);
    const webSearch = vi.fn(async () => searchRows);
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => { throw new Error("adapter down"); }), search: { webSearch } });
    // The weather tool failed, the verified search chain answered, and the
    // evidence that reached the model is search evidence, not weather evidence.
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cardTypes(result)).toEqual(["SearchResultCard", "SearchResultCard"]);
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("天气服务暂时不可用");
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("AI 新闻综述");
  });

  it("rejects a query mixed with other tools instead of guessing what used the facts", async () => {
    const plan = await planFromToolCalls([
      { name: "search", arguments: { query: "AI 行业新闻 2026年11月" } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["跟进 AI 新闻"] } } },
    ], canvas(), Date.now(), "查一下最近的 AI 大新闻，顺便加个待办跟进");
    expect(plan.kind).toBe("invalid");
    expect(String(plan.issues[0])).toContain("必须单独调用");
  });
});

describe("query telemetry and single feed-back", () => {
  it("removes the read tools from the surface once the facts are in hand", async () => {
    // Advice ("do not repeat the query") is not a guarantee; the follow-up turn
    // simply does not offer search/weather/read_url/metal_price/find_cards.
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "chat", args: { reply: "最近两条 AI 进展。" } }],
    ]);
    await runIntent({ text: "最近有什么 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch: async () => searchRows } });
    const followUpNames = (f.calls[1]!.tools ?? []).map(tool => tool.function.name);
    expect(followUpNames).not.toContain("search");
    expect(followUpNames).not.toContain("weather");
    expect(followUpNames).not.toContain("read_url");
    expect(followUpNames).not.toContain("metal_price");
    expect(followUpNames).not.toContain("find_cards");
    expect(followUpNames).toContain("chat");
    expect(followUpNames).toContain("create_card");
  });

  it("marks the tool-lookup path and the capability, with no repair", async () => {
    const sink = createIntentLogSink();
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "chat", args: { reply: "最近两条 AI 进展。" } }],
    ], { intentLog: sink });
    const result = await runIntent({ text: "最近有什么 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch: async () => searchRows } });
    expect(sink.path).toBe("tool-lookup");
    expect(sink.lookup).toEqual({ tool: "search", outcome: "ok" });
    expect(intentPathOf(result, sink)).toBe("tool-lookup");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });
});
