import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { clauseDemandOf, droppedClauses, splitActionClauses, type PlanOutcomes } from "../src/intent/clauseCoverage.js";
import { planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * sc-52 — "帮我记个便签明天交周报，然后设一个倒计时". The note was built and the
 * countdown clause vanished: its duration was missing, so the model simply
 * answered the half it could build. Only conditional sentences had a
 * dropped-clause guard; an ordinary compound sentence had none.
 *
 * The tool layer now checks every clause that carries a request against what
 * the batch produced. A clause with no result is an issue (`dropped-clause`),
 * which uses the existing one-shot repair turn: the model either fills the
 * missing argument or asks about the whole sentence itself. The host writes
 * neither the explanation nor the argument.
 */

const SC52 = "帮我记个便签明天交周报，然后设一个倒计时";
const NOW = Date.parse("2026-11-01T02:00:00+08:00");

const canvas = (): CanvasContext => ({ canvasId: "TEST-clause-coverage", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const plan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, canvas(), NOW, utterance, { sayFallback: true });

/* ------------------------------------------------------------------------- *
 * The pure mapping: which clauses ask for something, and does the batch show *
 * a result for them.                                                        *
 * ------------------------------------------------------------------------- */

const outcomes = (overrides: Partial<PlanOutcomes> = {}): PlanOutcomes => ({
  cardTypes: [], actionTypes: [], hasLookup: false, hasHostOperation: false, recorded: "", ...overrides,
});

describe("splitActionClauses: the clauses a user asked for", () => {
  it("splits on sentence ends and on sequencing words", () => {
    expect(splitActionClauses("帮我记个便签明天交周报，然后设一个倒计时")).toEqual(["帮我记个便签明天交周报", "设一个倒计时"]);
    expect(splitActionClauses("记个便签。设个倒计时。")).toEqual(["记个便签", "设个倒计时"]);
    expect(splitActionClauses("记个便签，再设个倒计时")).toEqual(["记个便签", "设个倒计时"]);
    expect(splitActionClauses("记个便签，另外设个倒计时")).toEqual(["记个便签", "设个倒计时"]);
  });

  it("keeps a conditional sentence whole: that verdict belongs to its own guard", () => {
    const text = "查一下明天上海天气，要是下雨就提醒我带伞";
    expect(splitActionClauses(text)).toEqual([text]);
  });

  it("does not tear a bare 再 out of its clause", () => {
    expect(splitActionClauses("再快一点")).toEqual(["再快一点"]);
    expect(splitActionClauses("显示全部再整理")).toEqual(["显示全部再整理"]);
  });
});

describe("clauseDemandOf: the request a clause carries", () => {
  it.each([
    ["设一个倒计时", "countdown"],
    ["设个10分钟倒计时", "countdown"],
    ["加个待办跟进", "todo"],
    ["帮我建个便签：明天交周报", "note"],
    ["查一下明天南京天气", "lookup"],
    ["查一下最近的 AI 大新闻", "lookup"],
    ["顺便加个待办跟进", "todo"],
    ["另外设个倒计时", "countdown"],
    ["把购物清单固定住", "op"],
    ["把买牛奶标成完成", "op"],
    ["把购物清单放回用户页", "op"],
    ["显示全部", "op"],
    ["聚焦购物清单", "op"],
    ["提醒我明天交周报", "reminder"],
    ["记个买牛奶", "record"],
    ["记一下明天的会议安排", "record"],
  ])("%s → %s", (clause, demand) => {
    expect(clauseDemandOf(clause)).toBe(demand);
  });

  it("ignores greetings, hedges, content and modifiers", () => {
    for (const text of ["谢谢", "哈哈好的", "明天也要交", "顺便", "另外", "然后再看吧"]) {
      expect(clauseDemandOf(text), text).toBeUndefined();
    }
  });
});

describe("droppedClauses: which clauses the batch left out", () => {
  it("names the countdown clause when only the note was built (sc-52)", () => {
    expect(droppedClauses(SC52, outcomes({ cardTypes: ["NoteCard"] }))).toEqual(["设一个倒计时"]);
  });

  it("accepts the sentence once both cards exist", () => {
    expect(droppedClauses(SC52, outcomes({ cardTypes: ["NoteCard", "CountdownCard"] }))).toEqual([]);
  });

  it("accepts a lookup clause when a lookup ran", () => {
    const text = "查一下最近的 AI 大新闻，顺便加个待办跟进";
    expect(droppedClauses(text, outcomes({ cardTypes: ["TodoCard"] }))).toEqual(["查一下最近的 AI 大新闻"]);
    expect(droppedClauses(text, outcomes({ cardTypes: ["TodoCard"], hasLookup: true }))).toEqual([]);
    expect(droppedClauses(text, outcomes({ cardTypes: ["SearchResultCard", "TodoCard"] }))).toEqual([]);
  });

  it("accepts an operation clause when the batch carries that operation", () => {
    const text = "把购物清单固定住，再记个便签明天交周报";
    expect(droppedClauses(text, outcomes({ cardTypes: ["NoteCard"] }))).toEqual(["把购物清单固定住"]);
    expect(droppedClauses(text, outcomes({ cardTypes: ["NoteCard"], hasHostOperation: true }))).toEqual([]);
  });

  it("does not repeat a clause that was recorded verbatim in a card", () => {
    const recorded = JSON.stringify({ text: "明天交周报，然后设一个倒计时" }).replace(/\s+/gu, "");
    expect(droppedClauses(SC52, outcomes({ cardTypes: ["NoteCard"], recorded }))).toEqual([]);
  });

  it("ignores a compound sentence that carries no recognisable request", () => {
    expect(droppedClauses("记个便签，然后明天交周报", outcomes({ cardTypes: ["NoteCard"] }))).toEqual([]);
  });

  it("never speaks for a conditional sentence", () => {
    expect(droppedClauses("查一下明天上海天气，要是下雨就提醒我带伞", outcomes())).toEqual([]);
  });
});

/* ------------------------------------------------------------------------- *
 * The pipeline: one repair turn, then an honest whole-sentence question.     *
 * ------------------------------------------------------------------------- */

interface ToolReply { name: string; args: Record<string, unknown> }

const credential = { apiKey: "TEST-clause-coverage-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

/** OpenAI-compatible `tool_calls`: one scripted batch per model turn. */
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
  const generate = vi.fn(async () => ({ ok: true as const, value: { reply: "planner answered" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, generate, fetchImpl, calls };
}

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];

const note: ToolReply = { name: "create_card", args: { kind: "note", fields: { text: "明天交周报" } } };

describe("accept60 sc-52: a compound sentence never loses its second half", () => {
  it("executes the decided half and speaks the missing duration in one batch", async () => {
    // The new contract: the note is already determined, only the countdown's
    // duration is missing. One batch carries the action and the question; the
    // host commits the note and speaks the question, with no repair turn.
    const f = setup([[note, { name: "clarify", args: { missing: "time", question: "倒计时设多长时间？" } }]]);
    const result = await runIntent({ text: SC52, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(cards(result)).toEqual(["NoteCard"]);
    expect(result.envelope?.spokenText).toBe("倒计时设多长时间？");
    expect(result.envelope?.actions).toContainEqual({ type: "subtitle.show", text: "倒计时设多长时间？", durationMs: 12000 });
    expect(result.envelope?.actions.some(action => action.type === "card.create" && action.card.type === "CountdownCard")).toBe(false);
  });

  it("asks the whole sentence for the missing duration and builds nothing", async () => {
    const f = setup([
      [note],
      [{ name: "clarify", args: { missing: "time", question: "倒计时设多长时间？" } }],
    ]);
    const result = await runIntent({ text: SC52, canvasContext: canvas() }, f.deps);
    // One repair turn, and its prompt names the clause that produced nothing.
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const repair = f.calls[1]!.messages.at(-1)!;
    expect(repair.role).toBe("user");
    expect(repair.content).toContain("设一个倒计时");
    expect(repair.content).toContain("dropped-clause");
    expect(repair.content).toContain("clarify(missing=…)");
    // The model's own question ends the turn: zero cards, no half execution.
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(cards(result)).toEqual([]);
    expect(result.message ?? "").toContain("倒计时");
  });

  it("builds both cards when the duration is there", async () => {
    const f = setup([[
      note,
      { name: "create_card", args: { kind: "countdown", fields: { minutes: 10 } } },
    ]]);
    const result = await runIntent({ text: "帮我记个便签明天交周报，然后设一个10分钟倒计时", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(cards(result)).toEqual(["NoteCard", "CountdownCard"]);
  });

  it("leaves a single-clause sentence alone", async () => {
    const f = setup([[note]]);
    const result = await runIntent({ text: "记个便签明天交周报", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(cards(result)).toEqual(["NoteCard"]);
  });

  it("ignores a trailing courtesy clause", async () => {
    const f = setup([[note]]);
    const result = await runIntent({ text: "记个便签明天交周报，谢谢", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(cards(result)).toEqual(["NoteCard"]);
  });

  it("still names a dropped clause when the sentence says 另外", async () => {
    const f = setup([[note]]);
    const result = await runIntent({ text: "记个便签明天交周报，另外设一个倒计时", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message ?? "").toContain("设一个倒计时");
    expect(result.envelope).toBeUndefined();
  });
});

describe("the dropped-clause issue rides the existing repair contract", () => {
  it("is a `dropped-clause` invalid plan that keeps the batch out of the envelope", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } }], SC52);
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.issues[0].code).toBe("dropped-clause");
    expect(result.issues[0].message).toContain("设一个倒计时");
    expect(result.issues[0].hint).toContain("clarify(missing=…)");
    expect(result.message).toContain("设一个倒计时");
  });

  it("does not fire when the model already explained the clause", async () => {
    const result = await plan([
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
      { name: "unsupported", arguments: { reply: "倒计时需要时长，说个时长我再设。" } },
    ], SC52);
    expect(result.kind).toBe("envelope");
    expect(result.issues).toEqual([]);
  });

  it("does not fire when both clauses produced cards", async () => {
    const result = await plan([
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
      { name: "create_card", arguments: { kind: "countdown", fields: { minutes: 10 } } },
    ], "帮我记个便签明天交周报，然后设一个10分钟倒计时");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard", "CountdownCard"]);
  });
});
