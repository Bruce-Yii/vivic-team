import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { createIntentLogSink, intentPathOf } from "../src/observability/intentLog.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { handleDataIntent } from "../src/data/index.js";
import type { WeatherEvidence } from "../src/data/weather.js";
import { withReceipt } from "./helpers.js";

/**
 * A query is read-only and solo.
 *
 * The old protocol let one response carry a lookup *and* card tools, so the host
 * ran the query first and committed provider cards itself. That made the output
 * shape the host's decision. Now the query must stand alone; its verified facts
 * reach the model in exactly one follow-up turn, and *that* turn may answer and/or
 * build cards (including the query card from this turn's evidence).
 *
 * The provider is a scripted tool transport; no live model or network.
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-tool-composite", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const credential = { apiKey: "TEST-tool-composite-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }> }

/** OpenAI-compatible `tool_calls`: one scripted batch per model turn. */
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
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, generate, fetchImpl, calls };
};

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];
const creates = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];

const evidence = [{
  title: "AI 新闻综述", url: "https://example.com/ai-news", snippet: "本周发布的新模型与算力进展。",
  fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
}];

const weatherEvidence = (): WeatherEvidence => ({
  kind: "weather", tempC: 9, conditionIcon: "cloud",
  location: { id: 1799963, name: "南京", latitude: 32.06, longitude: 118.78, country: "中国",
    country_code: "CN", admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA" },
  observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), weatherCode: 3, isDay: true,
  intervalSeconds: 900, modelGrid: { latitude: 32.06, longitude: 118.78 }, sources: [],
  day: 1,
  forecastDay: { date: "2026-11-05", tempMaxC: 12, tempMinC: 5, weatherCode: 3, conditionIcon: "cloud",
    precipitationProbability: 30 },
});

const weatherClient = (weather = vi.fn(async () => weatherEvidence())): NonNullable<PipelineDeps["data"]> => ({
  handleDataIntent: (text, context) => handleDataIntent(text, context, undefined, { weather }),
});

describe("a query and a card cannot share one response any more", () => {
  it("rejects search + todo in one batch and asks for the query alone first", async () => {
    const mixed: ToolReply[] = [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } },
      { name: "create_card", args: { kind: "todo", fields: { items: ["跟进 AI 新闻"] } } }];
    const f = setup([mixed, mixed]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "查一下最近的 AI 大新闻，顺便加个待办跟进", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    expect(webSearch).not.toHaveBeenCalled();
    expect(result.kind).toBe("clarify");
    expect(result.message ?? "").toContain("必须单独调用");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // No card is committed from the rejected batch.
    expect(result.envelope).toBeUndefined();
  });
});

describe("the follow-up turn owns both effects", () => {
  it("runs the search once, then publishes the result card and the todo together", async () => {
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "create_card", args: { kind: "search_results", fields: {} } },
        { name: "create_card", args: { kind: "todo", fields: { items: ["跟进 AI 新闻"] } } }],
    ]);
    const webSearch = vi.fn(async () => evidence);
    const sink = createIntentLogSink();
    const result = await runIntent({ text: "查一下最近的 AI 大新闻，顺便加个待办跟进", canvasContext: canvas() },
      { ...f.deps, search: { webSearch }, intentLog: sink });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(cards(result)).toEqual(["SearchResultCard", "TodoCard"]);
    expect(creates(result)[0]?.sources[0]?.url).toBe("https://example.com/ai-news");
    expect(intentPathOf(result, sink)).toBe("tool-lookup");
    expect(sink.repairs).toBeUndefined();
  });

  it("fills a card argument from the verified facts, never by the host", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: 1 } }],
      [{ name: "create_card", args: { kind: "todo", fields: { items: ["明天南京降温，备一件外套"] } } },
        { name: "create_card", args: { kind: "weather", fields: {} } }],
    ]);
    const weather = vi.fn(async () => weatherEvidence());
    const result = await runIntent({ text: "查一下明天南京天气，顺便加个待办提醒我带外套", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(weather) });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(weather).toHaveBeenCalledTimes(1);
    expect(cards(result)).toEqual(["TodoCard", "WeatherCard"]);
    // The follow-up request carries the verified facts as data.
    const followUp = f.calls[1]!.messages.at(-1)!;
    expect(followUp.role).toBe("user");
    expect(followUp.content).toContain("南京");
    expect(followUp.content).toContain("5~12°C");
    expect(followUp.content).toContain("不要重复查询");
    // The card content is the model's own words, not the evidence copied by the host.
    const todo = creates(result).find(card => card.type === "TodoCard");
    expect(todo?.displayProps).toMatchObject({ items: [{ text: "明天南京降温，备一件外套" }] });
    expect(JSON.stringify(todo)).not.toContain("降水概率");
  });

  it("does not run the query twice when the follow-up asks for it again", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: 1 } }],
      [{ name: "weather", args: { city: "南京", day: 1 } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } }],
    ]);
    const weather = vi.fn(async () => weatherEvidence());
    const result = await runIntent({ text: "查一下明天南京天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(weather) });
    expect(weather).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["WeatherCard"]);
    // The repair prompt says the query already ran; it is never executed again.
    expect(f.calls[2]!.messages.at(-1)!.content).toContain("不要重复查询");
  });
});
