import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { handleDataIntent } from "../src/data/index.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { createIntentLogSink } from "../src/observability/intentLog.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { emptyContext, withReceipt } from "./helpers.js";

/**
 * The two boundaries this round locks:
 *
 *  1. the rule fast paths no longer answer for the model — the deleted branches
 *     are gone, so their sentences reach the tool layer / planner (this file
 *     asserts *who* got the turn, not the model's wording);
 *  2. with the tool surface on, a weather/numeric/search adapter is reachable
 *     only through the model's `lookup` tool (`adapterOnly`); a keyword never
 *     opens it, and an adapter failure is handed back as `invalid` + `issues`.
 */

interface ToolReply { name: string; args: Record<string, unknown> }

const card = (id: string, title: string, type: string): CanvasContext["cards"][number] => ({
  id, type, aliases: [title],
  displayProps: type === "CountdownCard" ? { totalSeconds: 300 } : { text: title },
  sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160 },
});

const canvas = (): CanvasContext => ({
  ...emptyContext([card("todo_week", "本周待办", "TodoCard"), card("note_meeting", "会议记录", "NoteCard")]),
  timeZone: "Asia/Shanghai",
});

const credential = { apiKey: "TEST-rules-and-adapters", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

const scriptedToolFetch = (replies: ToolReply[][]) => {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    calls.push(body);
    const batch = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(batch).map((reply, index) => ({
      index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

function setup(replies: ToolReply[][], overrides: Partial<PipelineDeps> = {}) {
  const credentials = new CredentialStore();
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { clarify: "planner asked" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = {
    credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides,
  };
  return { deps, generate, fetchImpl, calls };
}

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];

const weatherEvidence = (name: string) => ({
  kind: "weather" as const, tempC: 18, conditionIcon: "cloud" as const,
  location: { id: 1799962, name, latitude: 32.06, longitude: 118.78, country: "中国",
    country_code: "CN", admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA" },
  observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), weatherCode: 3, isDay: true,
  intervalSeconds: 900, modelGrid: { latitude: 32.06, longitude: 118.78 }, sources: [],
});

describe("deleted rule branches no longer intercept the turn", () => {
  it("a destructive sentence reaches the tool layer instead of a rule delete + host confirmation", async () => {
    const f = setup([[{ name: "clarify", args: { missing: "target", question: "要清空哪几张卡片？" } }]]);
    const result = await runIntent({ text: "清空画布", canvasContext: canvas() }, f.deps);
    // The old path returned a rule envelope, or a host "删除/清空需要确认" question,
    // without ever asking the model. Now the model owns the proposal.
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.usedProvider).toBe("deepseek");
    expect(result.source).toBe("model");
    expect(result.message).toBe("要清空哪几张卡片？");
    expect(result.envelope).toBeUndefined();
  });

  it("a live-fact sentence is not searched by keyword when the model chooses chat", async () => {
    const data = vi.fn(async () => { throw new Error("the adapter must not run before the model chooses it"); });
    const f = setup([[{ name: "chat", args: {} }]], { data: { handleDataIntent: data as never } });
    const result = await runIntent({ text: "南京明天天气怎么样", canvasContext: canvas() }, f.deps);
    expect(data).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalled();
    expect(result.usedProvider).not.toBe("rules");
  });

  it("keeps the deterministic direct outputs (countdown) without a model turn", async () => {
    const f = setup([[{ name: "chat", args: {} }]]);
    const result = await runIntent({ text: "倒计时5分钟", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.usedProvider).toBe("rules");
    expect(cards(result)).toEqual(["CountdownCard"]);
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

});

describe("adapters are model tools while the tool surface is on", () => {
  it("only the model's weather lookup opens the Open-Meteo adapter", async () => {
    const weather = vi.fn(async () => weatherEvidence("南京"));
    const data = vi.fn((text: string, context: CanvasContext, signal?: AbortSignal) =>
      handleDataIntent(text, context, signal, { weather } as never));
    const f = setup([
      [{ name: "weather", args: { city: "南京" } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } }],
    ], { data: { handleDataIntent: data as never } });
    const result = await runIntent({ text: "南京今天天气", canvasContext: canvas() }, f.deps);
    // One query turn + one evidence turn: the adapter ran once, from the model's
    // own arguments, and the card is built only because the model asked for it.
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(data).toHaveBeenCalledTimes(1);
    expect(data.mock.calls[0]![0]).toBe("南京天气");
    expect(weather).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["WeatherCard"]);
  });

  it("hands an adapter refusal back as issues instead of speaking it", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "火星" } }],
      [{ name: "clarify", args: { missing: "content", question: "要查哪个城市的天气？" } }],
    ], { data: { handleDataIntent: async () => ({ kind: "clarify", message: "找到多个同名或近似地点", suggestions: ["南京,江苏天气"] }) } });
    const result = await runIntent({ text: "火星天气", canvasContext: canvas() }, f.deps);
    // Initial call + one repair turn: the adapter's words were the issue, not the answer.
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("model");
    expect(result.message).toContain("要查哪个城市");
    expect(result.message).not.toContain("找到多个同名");
    expect(JSON.stringify(result)).not.toContain("找到多个同名");
  });

  it("hands a search adapter error back as issues instead of ending the turn", async () => {
    // Weather has its own fallback chain now (see weather-fallback.test.ts); a
    // search adapter failure still goes back to the model as issues with one
    // repair turn, never straight to the user as a dead end.
    const f = setup([
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "clarify", args: { missing: "other", question: "联网查询暂时不可用，要稍后再试吗？" } }],
    ]);
    const webSearch = vi.fn(async () => { throw new Error("network down"); });
    const result = await runIntent({ text: "查一下最近的 AI 大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.source).toBe("model");
    expect(result.message).toContain("稍后再试");
    expect(result.interrupt).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("network down");
  });

  it("keeps the legacy planner off by default when the tool turn fails", async () => {
    const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { clarify: "planner asked" } }));
    const failing = vi.fn(async () => new Response("upstream down", { status: 500 }));
    const sink = createIntentLogSink();
    const deps: PipelineDeps = {
      credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: failing as unknown as typeof fetch },
      planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
      mainProvider: "deepseek", toolCalls: true, toolCredential: credential, intentLog: sink,
    };
    const result = await runIntent({ text: "帮我随便做点什么", canvasContext: canvas() }, deps);
    // No `VIVIC_LEGACY_FALLBACK=on`: the silent old-planner fallback never runs.
    expect(generate).not.toHaveBeenCalled();
    expect(result.source).toBe("host");
    expect(result.interrupt?.reason).toBe("vendor-unavailable");
    expect(sink.path).not.toBe("legacy");
  });
});
