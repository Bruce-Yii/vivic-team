import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { handleDataIntent } from "../src/data/index.js";
import { DataError } from "../src/data/transport.js";
import type { WeatherResult } from "../src/data/weather.js";
import { withReceipt } from "./helpers.js";

/**
 * Weather is a *result* capability, not a service. The public surface is still
 * one `weather` tool; internally:
 *
 *  - adapter failure (timeout / unavailable / 5xx / bad payload) → the verified
 *    search chain answers, with a SearchResultCard and a spoken note saying so;
 *  - adapter clarify (missing / ambiguous city) → a real question, never a
 *    search that papers over what the user must answer;
 *  - both layers fail → both reasons are named, nothing is invented.
 *
 * The provider is a scripted tool transport and the adapters are mocked; no live
 * model or network is used.
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-weather-fallback", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const credential = { apiKey: "TEST-weather-fallback-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }> }

const scriptedToolFetch = (replies: ToolReply[][]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const batch = replies[Math.min(calls.length - 1, replies.length - 1)]!;
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

const evidence = [{
  title: "南京明天天气", url: "https://example.com/weather/nanjing", snippet: "明天多云，5~12°C。",
  fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
}];

/** The real data adapter with a scripted weather provider: a thrown DataError is
 *  exactly the "adapter failed" path (timeout/unavailable/5xx). */
const weatherClient = (weather: () => Promise<WeatherResult>): NonNullable<PipelineDeps["data"]> => ({
  handleDataIntent: (text, context, signal) => handleDataIntent(text, context, signal, { weather }),
});

describe("weather adapter failure falls back to the verified search chain", () => {
  it("feeds the search facts back and lets the model publish a result card", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: 1 } }],
      [{ name: "create_card", args: { kind: "search_results", fields: {} } }],
    ]);
    const webSearch = vi.fn(async (_query: string) => evidence);
    const result = await runIntent({ text: "查一下明天南京天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => { throw new DataError("timeout"); }), search: { webSearch } });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(String(webSearch.mock.calls[0]![0])).toContain("南京");
    expect(String(webSearch.mock.calls[0]![0])).toContain("天气");
    expect(cards(result)).toEqual(["SearchResultCard"]);
    // The fallback is a *fact source*, not an auto-card: the model is told which
    // layer produced the facts, and no host template line is committed.
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("天气服务暂时不可用");
    expect(result.envelope?.spokenText ?? "").not.toContain("已整理");
    expect(result.envelope?.actions.some(action => action.type === "subtitle.show"
      && action.text.includes("天气服务暂时不可用"))).toBe(false);
  });

  it("lets the same follow-up answer and publish the result card", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "南京", day: 1 } }],
      [{ name: "chat", args: { reply: "天气服务没取到预报，检索到明天多云 5~12°C。" } },
        { name: "create_card", args: { kind: "search_results", fields: {} } }],
    ]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "查一下明天南京天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => { throw new DataError("unavailable"); }), search: { webSearch } });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["SearchResultCard"]);
    expect(result.envelope?.spokenText).toContain("5~12°C");
  });
});

describe("a weather clarify is a question, not a fallback trigger", () => {
  it("asks which city the user meant and never calls search", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "新城", day: 1 } }],
      [{ name: "clarify", args: { missing: "other", question: "你说的是哪个新城？请补省州或国家。" } }],
    ]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "查一下明天新城天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => ({ kind: "clarify",
        message: "地点匹配过多，请补充省州或国家。", candidates: [] })), search: { webSearch } });
    expect(webSearch).not.toHaveBeenCalled();
    expect(result.kind).toBe("clarify");
    expect(result.message ?? "").toContain("新城");
  });
});

describe("both layers failing is reported honestly", () => {
  it("names the weather failure and the search failure", async () => {
    const f = setup([[{ name: "weather", args: { city: "南京", day: 1 } }]]);
    const webSearch = vi.fn(async () => { throw new Error("network down"); });
    const result = await runIntent({ text: "查一下明天南京天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => { throw new DataError("timeout"); }), search: { webSearch } });
    expect(result.kind).toBe("error");
    expect(result.message ?? "").toContain("天气查询超时");
    expect(result.message ?? "").toContain("联网查询暂不可用");
    expect(result.envelope).toBeUndefined();
  });

  it("names the missing search configuration when there is no search chain", async () => {
    const f = setup([[{ name: "weather", args: { city: "南京", day: 1 } }]]);
    const result = await runIntent({ text: "查一下明天南京天气", canvasContext: canvas() },
      { ...f.deps, data: weatherClient(async () => { throw new DataError("unavailable"); }) });
    expect(result.kind).toBe("error");
    expect(result.message ?? "").toContain("天气服务暂不可用");
    expect(result.message ?? "").toContain("联网搜索也没有配置");
  });
});
