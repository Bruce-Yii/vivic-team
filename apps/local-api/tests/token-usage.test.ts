import { describe, expect, it, vi } from "vitest";

import { CredentialStore } from "../src/credentials.js";
import { requestToolCalls, streamToolCalls } from "../src/intent/toolTransport.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { createIntentLogSink, intentLogLine } from "../src/observability/intentLog.js";
import { createTokenUsageMeter, normalizeTokenUsage } from "../src/observability/tokenUsage.js";
import type { CanvasContext } from "../src/schemas.js";
import { chatJson } from "../src/stepfun.js";

/**
 * Token accounting: usage is provider-shaped, so the normalizer is pinned for
 * every documented shape; the per-request meter must add repair/feed-back turns
 * instead of overwriting them; a provider that omits usage must not break the
 * turn, the log line, or the CLI.
 */

const credential = { apiKey: "TEST-token-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

const canvas = (): CanvasContext => ({ canvasId: "TEST-token", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

describe("normalizeTokenUsage", () => {
  it("maps DeepSeek's prompt/cache fields", () => {
    expect(normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 40,
      prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }, "deepseek-flash"))
      .toEqual({ input: 1000, output: 40, cacheHit: 800, cacheMiss: 200, model: "deepseek-flash" });
  });

  it("maps OpenAI's nested cached_tokens and derives the miss from the prompt total", () => {
    expect(normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 640 } }))
      .toEqual({ input: 1000, output: 40, cacheHit: 640, cacheMiss: 360 });
    expect(normalizeTokenUsage({ prompt_tokens: 500, completion_tokens: 10, cached_tokens: 300 }))
      .toEqual({ input: 500, output: 10, cacheHit: 300, cacheMiss: 200 });
  });

  it("maps Anthropic's input_tokens plus cache read/creation counters", () => {
    expect(normalizeTokenUsage({ input_tokens: 200, output_tokens: 40,
      cache_read_input_tokens: 700, cache_creation_input_tokens: 100 }))
      .toEqual({ input: 1000, output: 40, cacheHit: 700, cacheMiss: 300 });
  });

  it("maps the Pi usage shape used by the GPT planner", () => {
    expect(normalizeTokenUsage({ input: 200, output: 40, cacheRead: 700, cacheWrite: 100, totalTokens: 1040 }))
      .toEqual({ input: 1000, output: 40, cacheHit: 700, cacheMiss: 300 });
  });

  it("accepts an already-normalized delta unchanged", () => {
    expect(normalizeTokenUsage({ input: 100, output: 10, cacheHit: 80, cacheMiss: 20 }))
      .toEqual({ input: 100, output: 10, cacheHit: 80, cacheMiss: 20 });
  });

  it("returns undefined when the response carried no usage", () => {
    for (const value of [undefined, null, {}, "usage", [], { choices: [] }]) {
      expect(normalizeTokenUsage(value)).toBeUndefined();
    }
  });
});

describe("per-request token meter", () => {
  it("adds two model turns instead of overwriting the first", () => {
    const meter = createTokenUsageMeter();
    meter.record(normalizeTokenUsage({ prompt_tokens: 1000, completion_tokens: 40,
      prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }, "deepseek-flash"));
    meter.record(normalizeTokenUsage({ prompt_tokens: 1200, completion_tokens: 60,
      prompt_cache_hit_tokens: 1100, prompt_cache_miss_tokens: 100 }, "deepseek-flash"));
    expect(meter.summary()).toEqual({ input: 2200, output: 100, cacheHit: 1900, cacheMiss: 300,
      model: "deepseek-flash", turns: 2 });
  });

  it("ignores missing usage and reports nothing until a turn reports some", () => {
    const meter = createTokenUsageMeter();
    expect(() => meter.record(undefined)).not.toThrow();
    expect(meter.summary()).toBeUndefined();
    meter.record(normalizeTokenUsage({ prompt_tokens: 10, completion_tokens: 1 }));
    expect(meter.summary()).toEqual({ input: 10, output: 1, cacheHit: 0, cacheMiss: 10, model: "unknown", turns: 1 });
  });
});

describe("usage extraction at the provider boundary", () => {
  it("returns usage from a non-streaming chatJson response", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ choices: [{ finish_reason: "stop",
      message: { content: "{\"reply\":\"ok\"}" } }],
    usage: { prompt_tokens: 900, completion_tokens: 30, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 200 } }));
    const result = await chatJson(credential, [{ role: "user", content: "hi" }],
      { baseUrl: "https://provider.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(true);
    expect(result.ok && result.usage).toEqual({ input: 900, output: 30, cacheHit: 700, cacheMiss: 200, model: "deepseek-flash" });
  });

  it("returns usage from a streaming chatJson response's final usage frame", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "{\"reply\":" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "\"ok\"}" }, finish_reason: "stop" }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 20,
        prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 200 } })}`,
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl = vi.fn(async () => new Response(`${frames}\n\n`, {
      status: 200, headers: { "content-type": "text/event-stream" } }));
    const result = await chatJson(credential, [{ role: "user", content: "hi" }],
      { baseUrl: "https://provider.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
      { onTextDelta: () => undefined });
    expect(result.ok).toBe(true);
    expect(result.ok && result.usage).toEqual({ input: 800, output: 20, cacheHit: 600, cacheMiss: 200, model: "deepseek-flash" });
  });

  it("returns usage from a non-streaming tool turn and tolerates its absence", async () => {
    const withUsage = vi.fn(async () => jsonResponse({
      choices: [{ message: { tool_calls: [{ index: 0, type: "function",
        function: { name: "view", arguments: "{\"mode\":\"fit\"}" } }] } }],
      usage: { prompt_tokens: 500, completion_tokens: 12, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 100 } }));
    const first = await requestToolCalls(credential, [{ role: "user", content: "显示全部" }],
      { baseUrl: "https://provider.invalid/v1", fetchImpl: withUsage as unknown as typeof fetch }, []);
    expect(first.ok && first.usage).toEqual({ input: 500, output: 12, cacheHit: 400, cacheMiss: 100, model: "deepseek-flash" });

    const withoutUsage = vi.fn(async () => jsonResponse({
      choices: [{ message: { tool_calls: [{ index: 0, type: "function",
        function: { name: "view", arguments: "{\"mode\":\"fit\"}" } }] } }] }));
    const second = await requestToolCalls(credential, [{ role: "user", content: "显示全部" }],
      { baseUrl: "https://provider.invalid/v1", fetchImpl: withoutUsage as unknown as typeof fetch }, []);
    expect(second.ok).toBe(true);
    expect(second.ok && second.usage).toBeUndefined();
  });

  it("returns usage from a streamed tool turn's final usage-only frame", async () => {
    const frames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, function: { name: "view", arguments: "{\"mode\":\"fit\"}" } }] } }] })}`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 700, completion_tokens: 9,
        prompt_cache_hit_tokens: 500, prompt_cache_miss_tokens: 200 } })}`,
      "data: [DONE]",
    ].join("\n\n");
    const fetchImpl = vi.fn(async () => new Response(`${frames}\n\n`, {
      status: 200, headers: { "content-type": "text/event-stream" } }));
    const result = await streamToolCalls(credential, [{ role: "user", content: "显示全部" }],
      { baseUrl: "https://provider.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch }, [], undefined, {});
    expect(result.ok).toBe(true);
    expect(result.ok && result.usage).toEqual({ input: 700, output: 9, cacheHit: 500, cacheMiss: 200, model: "deepseek-flash" });
  });
});

describe("intent log accumulates every model turn", () => {
  /** OpenAI-compatible tool_calls with a provider usage block per turn. */
  const scripted = (replies: Array<{ name: string; args: Record<string, unknown> }>,
    usage: Array<Record<string, number>>) => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      const reply = replies[Math.min(call, replies.length - 1)]!;
      const counts = usage[Math.min(call, usage.length - 1)]!;
      call += 1;
      return jsonResponse({ choices: [{ message: { tool_calls: [{ index: 0, type: "function",
        function: { name: reply.name, arguments: JSON.stringify(reply.args) } }] } }], usage: counts });
    });
    return fetchImpl;
  };
  const setup = (fetchImpl: typeof fetch): PipelineDeps => ({
    credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true,
      generate: async () => ({ ok: true, value: { reply: "planner answered" } }) },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential,
  });

  it("sums the first turn and the repair turn on the intent-log sink", async () => {
    const fetchImpl = scripted([
      { name: "create_card", args: { kind: "todo", fields: { items: [] } } },
      { name: "create_card", args: { kind: "template", fields: { template_id: "meeting_minutes",
        fields: { topics: ["Q4预算评审"], decisions: ["下周一定稿"] } } } },
    ], [
      { prompt_tokens: 1000, completion_tokens: 40, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 },
      { prompt_tokens: 1200, completion_tokens: 60, prompt_cache_hit_tokens: 1100, prompt_cache_miss_tokens: 100 },
    ]);
    const sink = createIntentLogSink();
    const deps = { ...setup(fetchImpl as unknown as typeof fetch), intentLog: sink };
    const result = await runIntent({ text: "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿", canvasContext: canvas() }, deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(sink.repairs).toBe(1);
    expect(sink.tokens?.summary()).toEqual({ input: 2200, output: 100, cacheHit: 1900,
      cacheMiss: 300, model: "deepseek-flash", turns: 2 });
    const line = intentLogLine(result, sink, "req_tokens", performance.now());
    expect(line.tokens).toEqual({ input: 2200, output: 100, cacheHit: 1900,
      cacheMiss: 300, model: "deepseek-flash", turns: 2 });
  });

  it("omits tokens and does not throw when the provider reports none", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({
      choices: [{ message: { tool_calls: [{ index: 0, type: "function",
        function: { name: "create_card", arguments: JSON.stringify({ kind: "template",
          fields: { template_id: "meeting_minutes", fields: { topics: ["Q4预算评审"] } } }) } }] } }] }));
    const sink = createIntentLogSink();
    const deps = { ...setup(fetchImpl as unknown as typeof fetch), intentLog: sink };
    const result = await runIntent({ text: "帮我整理一份会议纪要：议题是Q4预算评审", canvasContext: canvas() }, deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(sink.tokens?.summary()).toBeUndefined();
    expect(intentLogLine(result, sink, "req_no_usage", performance.now())).not.toHaveProperty("tokens");
  });
});
