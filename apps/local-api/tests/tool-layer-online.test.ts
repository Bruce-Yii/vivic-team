import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { createIntentLogSink } from "../src/observability/intentLog.js";
import type { StepfunResult } from "../src/stepfun.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * The tool layer must be reachable in the deployed (online) wiring, where the
 * main planner can be served by the provider registry (DeepSeek official) and
 * `deps.credentials` therefore holds no StepFun key at all. These tests pin the
 * two switches that decide reachability:
 *
 *  - `toolCalls` on  -> one tool-calling turn (no planner call) whenever a tool
 *    credential exists, including the host-supplied `toolCredential`;
 *  - `toolCalls` off -> exactly today's window: rules, then the planner. No
 *    tool transport request is ever made.
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-tool-layer-online", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

/** OpenAI-compatible `tool_calls` response (a gateway that ignores `stream`). */
const toolFetch = (name: string, args: Record<string, unknown>, calls = { count: 0 }) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    calls.count += 1;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls:
      withReceipt([{ name, arguments: args }]).map((call, index) => ({ index, type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });

const deepseekCredential = { apiKey: "TEST-tool-layer-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

function setup(overrides: Partial<PipelineDeps> = {}, fetchCalls = { count: 0 }) {
  const credentials = new CredentialStore();
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const fetchImpl = toolFetch("create_card", { kind: "note", fields: { text: "会议纪要：议题Q4预算、结论下周一定稿" } }, fetchCalls);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", ...overrides };
  return { deps, generate, fetchImpl, fetchCalls };
}

const text = "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿";
const cards = (result: Awaited<ReturnType<typeof runIntent>>) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];

describe("online wiring: the tool layer is reachable only when VIVIC_TOOL_CALLS=on", () => {
  it("on + host tool credential (DeepSeek official main, no StepFun key) runs the tool turn, not the planner", async () => {
    const f = setup({ toolCalls: true, toolCredential: deepseekCredential });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(cards(result)).toEqual(["NoteCard"]);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.fetchCalls.count).toBeGreaterThan(0);
  });

  it("on + StepFun main keeps using deps.credentials for the tool transport", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-stepfun-key", models: ["step-5-preview"],
      defaultModel: "step-5-preview", checkedAt: new Date().toISOString() });
    const f = setup({ toolCalls: true, credentials });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.toolCalls).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("on but no usable credential falls back to the planner (no tool request, same turn)", async () => {
    const f = setup({ toolCalls: true });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.toolCalls).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.fetchCalls.count).toBe(0);
  });

  it("off keeps today's window even when both credentials exist (planner only, zero tool requests)", async () => {
    const f = setup({ toolCalls: false, toolCredential: deepseekCredential });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.toolCalls).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.fetchCalls.count).toBe(0);
  });
});

/** The tool turn runs, then fails; the old planner must stay silent by default. */
const withFetch = (fetchImpl: unknown, overrides: Partial<PipelineDeps> = {}) =>
  setup({ toolCalls: true, toolCredential: deepseekCredential,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as typeof fetch }, ...overrides });

const failingFetch = () => vi.fn(async () => new Response("upstream down", { status: 500 }));

describe("a failed tool turn answers honestly instead of silently replanning", () => {
  it("asks the user to rephrase when the tool plan cannot be mapped", async () => {
    const f = withFetch(toolFetch("create_card", { kind: "scene", fields: { scene_id: "nope", data: {} } }));
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.toolCalls).toBe(true);
    expect(result.message).toContain("没能形成可靠动作");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("restores the old planner fallback only when VIVIC_LEGACY_FALLBACK is on", async () => {
    const f = withFetch(toolFetch("create_card", { kind: "scene", fields: { scene_id: "nope", data: {} } }), { legacyFallback: true });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.toolCalls).toBeUndefined();
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(result.envelope).toBeDefined();
  });

  it("does not hide a tool transport failure behind the planner", async () => {
    const f = withFetch(failingFetch());
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.toolCalls).toBe(true);
    expect(result.message).toContain("没有给出可执行的动作");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("keeps the chat answer path: chat still reaches the planner", async () => {
    const f = withFetch(toolFetch("chat", {}));
    const result = await runIntent({ text: "讲个笑话", canvasContext: canvas() }, f.deps);
    // Chat is a deliberate non-card route, not a failure: the planner answers.
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toBeUndefined();
    expect(result.kind).toBe("envelope");
  });

  it("records the tool names and the failure in the telemetry sink", async () => {
    const sink = createIntentLogSink();
    const f = withFetch(toolFetch("create_card", { kind: "scene", fields: { scene_id: "nope", data: {} } }), { intentLog: sink });
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.toolCalls).toBe(true);
    // The model also spent the receipt line on this batch (`chat`), so the sink
    // names both tools it actually asked for.
    expect(sink.tools).toEqual(["create_card", "chat"]);
    expect(sink.error).toContain("create_card");
    // A rejected call is now repaired once before the honest clarification, so
    // the sink marks the repair path and how many model turns it cost.
    expect(sink.path).toBe("tool-repair");
    expect(sink.repairs).toBe(1);
  });

  it("marks the legacy path in the sink when the old fallback is enabled", async () => {
    const sink = createIntentLogSink();
    const f = withFetch(toolFetch("create_card", { kind: "scene", fields: { scene_id: "nope", data: {} } }), { legacyFallback: true, intentLog: sink });
    await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(sink.path).toBe("legacy");
  });
});
