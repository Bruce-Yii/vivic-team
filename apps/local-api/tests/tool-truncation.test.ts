import { describe, expect, it } from "vitest";

import { requestToolCalls, streamToolCalls } from "../src/intent/toolTransport.js";

/**
 * A tool turn that runs out of output tokens is NOT "the model chose no tool":
 * bytes were produced and thrown away. The transport must say so, so the pipeline
 * can repair (and so sc-44's empty-looking turn is diagnosable) instead of
 * reporting a generic "no tool call".
 */
const credential = { apiKey: "TEST-token-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };
const deps = (fetchImpl: typeof fetch) => ({ fetchImpl, baseUrl: "http://provider.test", timeoutMs: 5_000 });
const tools = [{ type: "function" as const, function: { name: "chat", description: "say", parameters: { type: "object", properties: {} } } }];
const messages = [{ role: "user" as const, content: "hi" }];

const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

describe("a truncated tool turn is reported, not treated as silence", () => {
  it("non-streaming: finish_reason=length", async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [{ finish_reason: "length", message: { content: null } }] })) as unknown as typeof fetch;
    const result = await requestToolCalls(credential as never, messages, deps(fetchImpl), tools);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("截断");
  });

  it("streaming: finish_reason=length", async () => {
    const sse = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "thinking" } }] })}`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] })}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
    const fetchImpl = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    const result = await streamToolCalls(credential as never, messages, deps(fetchImpl), tools, undefined, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("截断");
  });

  it("a normal tool call still passes", async () => {
    const body = { choices: [{ finish_reason: "tool_calls",
      message: { tool_calls: [{ id: "c1", type: "function", function: { name: "chat", arguments: "{\"reply\":\"好\"}" } }] } }] };
    const fetchImpl = (async () => jsonResponse(body)) as unknown as typeof fetch;
    const result = await requestToolCalls(credential as never, messages, deps(fetchImpl), tools);
    expect(result.ok).toBe(true);
  });
});
