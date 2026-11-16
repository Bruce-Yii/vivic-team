import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { createIntentLogSink, intentLogLine } from "../src/observability/intentLog.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { withReceipt } from "./helpers.js";

/**
 * Tool-layer validation repair (`VIVIC_TOOL_REPAIR`, default on).
 *
 * The model already picked a tool; only its arguments failed host validation.
 * Instead of asking the user a basic question ("书名是什么/哪张卡"), the
 * pipeline hands the rejected call plus the host issues back to the model once
 * and accepts only a fully re-validated corrected call. These tests pin the
 * four boundaries:
 *
 *  - invalid/validation-clarify -> exactly one extra model turn, then a card;
 *  - first call valid           -> no extra turn at all;
 *  - both calls invalid         -> the existing honest clarification, no throw;
 *  - model-chosen `clarify`     -> never retried (it is a decision, not a bug).
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-tool-repair", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }>; stream?: boolean }

/** OpenAI-compatible `tool_calls`: one scripted reply per model turn. */
const scriptedToolFetch = (replies: ToolReply[]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt([reply]).map((call, index) => ({
      index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

/** The same transport for a model that never volunteers the receipt: exactly the
 *  scripted batch per turn, so `missing-say` (and its fallback) can be pinned. */
const silentToolFetch = (batches: ToolReply[][]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body ?? "{}")) as ChatBody);
    const batch = batches.shift();
    if (!batch) throw new Error("unexpected extra model turn");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: batch.map((reply, index) => ({
      index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

const depsOf = (fetchImpl: typeof fetch, overrides: Partial<PipelineDeps>) => {
  const credential = { apiKey: "TEST-tool-repair-key", models: ["deepseek-flash"],
    defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const deps: PipelineDeps = { credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, generate };
};

const setup = (replies: ToolReply[], overrides: Partial<PipelineDeps> = {}) => {
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const built = depsOf(fetchImpl as unknown as typeof fetch, overrides);
  return { ...built, fetchImpl, calls };
};

const silentSetup = (batches: ToolReply[][], overrides: Partial<PipelineDeps> = {}) => {
  const { fetchImpl, calls } = silentToolFetch(batches);
  const built = depsOf(fetchImpl as unknown as typeof fetch, overrides);
  return { ...built, fetchImpl, calls };
};

const cards = (result: Awaited<ReturnType<typeof runIntent>>) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];

const meeting = "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿";
const template = (fields: Record<string, unknown>): ToolReply =>
  ({ name: "create_card", args: { kind: "template", fields: { template_id: "meeting_minutes", fields } } });
/** `items` is required and non-empty: the mapper rejects this as invalid. */
const invalidTodo: ToolReply = { name: "create_card", args: { kind: "todo", fields: { items: [] } } };

describe("tool validation repair", () => {
  it("repairs a schema-invalid tool call once and commits the corrected card", async () => {
    const f = setup([invalidTodo, template({ topics: ["Q4预算评审"], decisions: ["下周一定稿"] })]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(cards(result)).toEqual(["NoteCard"]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.generate).not.toHaveBeenCalled();
    // The second request carries the rejected call and the exact host issue,
    // plus the "corrected tool call only" instruction.
    const repair = f.calls[1]!.messages.at(-1)!;
    expect(repair.role).toBe("user");
    expect(repair.content).toContain("create_card");
    expect(repair.content).toContain('"kind":"todo"');
    // An empty list names the gap instead of a bare "参数不合法".
    expect(repair.content).toContain("待办条目不能为空");
    expect(repair.content).toContain("只返回修正后的工具调用，不要解释");
    expect(sink.path).toBe("tool-repair");
    expect(sink.repairs).toBe(1);
  });

  it("repairs a validation clarification that has issues and no executable actions", async () => {
    const f = setup([template({ title: "Q4预算评审" }), template({ topics: ["Q4预算评审"], decisions: ["下周一定稿"] })]);
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)).toEqual(["NoteCard"]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("topics");
  });

  it("hands a missing required parameter to the model instead of asking the user", async () => {
    // `need()` used to return a host clarification ("要记哪些待办？"). The host no
    // longer asks: the rejected call travels back as missing-param + a concrete
    // hint, and the model either fills it or decides to clarify itself.
    // The example is `countdown` (minutes required): a todo list now accepts a
    // title alone, so "no items" is an argument error, not a missing parameter.
    const f = setup([{ name: "create_card", args: { kind: "countdown", fields: {} } },
      { name: "create_card", args: { kind: "todo", fields: { items: ["跟进合同"] } } }]);
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["TodoCard"]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const repair = f.calls[1]!.messages.at(-1)!;
    expect(repair.role).toBe("user");
    expect(repair.content).toContain("missing-param");
    expect(repair.content).toContain("补齐参数后重试");
    expect(repair.content).toContain("clarify(missing=...)");
  });

  it("does not retry a call that already validated", async () => {
    const f = setup([template({ topics: ["Q4预算评审"], decisions: ["下周一定稿"] })]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.path).toBeUndefined();
    expect(sink.repairs).toBeUndefined();
  });

  it("asks honestly when both attempts fail validation, without throwing", async () => {
    const f = setup([invalidTodo, invalidTodo]);
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("没能形成可靠动作");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("does not retry when VIVIC_TOOL_REPAIR is off", async () => {
    const f = setup([invalidTodo, template({ topics: ["Q4预算评审"] })], { toolRepair: false });
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("never retries a model-chosen clarify", async () => {
    const f = setup([{ name: "clarify", args: { missing: "target", question: "是哪一次会议的纪要？" } }]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: meeting, canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("是哪一次会议的纪要？");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.path).toBeUndefined();
  });
});

/**
 * The action-receipt protocol (`docs/decisions/2026-11-05-action-requires-model-
 * receipt.md`). A canvas action with no model words is a `missing-say` rejection
 * and spends the same single repair turn every other invalid call uses; only the
 * turn after that falls back to the host's line, and it is recorded as
 * `sayFallback` so a silent model can never look like a working default.
 */
describe("action receipt", () => {
  const note: ToolReply = { name: "create_card", args: { kind: "note", fields: { text: "明天交周报" } } };
  const said: ToolReply = { name: "chat", args: { reply: "记好了：明天交周报。" } };

  it("keeps the action and the model's line when both arrive together", async () => {
    const f = silentSetup([[note, said]]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: "记个便签明天交周报", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.spokenText).toBe("记好了：明天交周报。");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.repairs ?? 0).toBe(0);
    expect(sink.sayFallback).toBeUndefined();
  });

  it("turns the execution receipt into the model's own final line", async () => {
    // act → observe → speak: the first batch commits the card silently, then one
    // more turn receives the receipt and produces the sentence the user hears.
    const f = silentSetup([[note], [said]]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: "记个便签明天交周报", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.spokenText).toBe("记好了：明天交周报。");
    expect(result.envelope?.actions.some(action => action.type === "card.create")).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // The speaking turn is told what actually happened, not how many cards exist.
    const speaking = f.calls[1]!.messages.at(-1)!;
    expect(speaking.content).toContain("动作已经执行完成");
    expect(speaking.content).toContain("新建");
    expect(sink.sayFallback).toBeUndefined();
    expect(sink.saySource).toBe("synthesized");
  });

  it("falls back to the neutral line only when the speaking turn fails too", async () => {
    const f = silentSetup([[note], [note]]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: "记个便签明天交周报", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.spokenText).toBe("卡片已经放到画布上了。");
    expect(result.envelope?.actions.some(action => action.type === "card.create")).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(sink.sayFallback).toBe(true);
    expect(sink.saySource).toBeUndefined();
  });

  it("uses the fallback immediately when the repair turn is switched off", async () => {
    const f = silentSetup([[note]], { toolRepair: false });
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: "记个便签明天交周报", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.spokenText).toBe("卡片已经放到画布上了。");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.sayFallback).toBe(true);
  });

  it("never spends a repair turn on a pure chat turn", async () => {
    const f = silentSetup([[said]]);
    const sink = createIntentLogSink();
    f.deps.intentLog = sink;
    const result = await runIntent({ text: "你好", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(sink.repairs).toBeUndefined();
    expect(sink.sayFallback).toBeUndefined();
  });
});

describe("VIVIC_TOOL_REPAIR switch", () => {
  const config = (env: NodeJS.ProcessEnv) => {
    const dir = mkdtempSync(path.join(tmpdir(), "vivic-tool-repair-"));
    try { return loadConfig({ VIVIC_LOCAL_TOKEN: "test-token-0123456789", ...env }, dir); }
    finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it("defaults on and turns off only for `off`", () => {
    expect(config({}).toolRepair).toBe(true);
    expect(config({ VIVIC_TOOL_REPAIR: "on" }).toolRepair).toBe(true);
    expect(config({ VIVIC_TOOL_REPAIR: "off" }).toolRepair).toBe(false);
  });
});
