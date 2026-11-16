import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { buildToolSystemPrompt, findCardsOnCanvas, planFromToolCalls, type ToolCallPlan } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { withReceipt } from "./helpers.js";

/**
 * `find_cards`: the model's own way to inspect a canvas it can only partially
 * see. The tool layer reads `canvasContext` (never a provider), returns real
 * ids/entries/positions, and the pipeline hands that result back exactly once so
 * the model — not the host — decides which card to act on. A miss returns the
 * canvas type census instead of a host question.
 */

const NOW = Date.parse("2026-11-04T10:00:00+08:00");

type Card = CanvasContext["cards"][number];

const noteCard = (id: string, text: string, x = 0): Card => ({
  id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {},
  layout: { x, y: 0, width: 320, height: 120 },
});

const todoCard = (id: string, title: string, items: string[], x = 0): Card => ({
  id, type: "TodoCard", aliases: [title],
  displayProps: { title, items: items.map((text, index) => ({ id: `item-${index + 1}`, text, done: false })) },
  sourceDataSummary: {}, layout: { x, y: 0, width: 288, height: 160 },
});

const tableCard = (index: number): Card => ({
  id: `card-${index}`, type: "TableCard", aliases: [`表格${index}`],
  displayProps: { columns: ["名称"], rows: [[`内容${index}`]] }, sourceDataSummary: {},
  layout: { x: index * 340, y: 0, width: 320, height: 120 },
});

const canvasOf = (cards: Card[], extra: Partial<CanvasContext> = {}): CanvasContext =>
  ({ canvasId: "TEST-find-cards", stage: "WORKSPACE", viewport: { x: 0, y: 0, zoom: 1 },
    focusHistory: [], timeZone: "Asia/Shanghai", cards, ...extra });

/** The two lists used by the entry cases: 买牛奶 lives in 本周待办. */
const lists = (): CanvasContext => canvasOf([
  todoCard("todo_week", "本周待办", ["交周报", "买牛奶", "预约牙医"]),
  todoCard("todo_shop", "购物清单", ["鸡蛋", "洗衣液"], 400),
  noteCard("note_meeting", "周会纪要：确认发布窗口", 0),
]);

const plan = (calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  ctx: CanvasContext = lists(), utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, ctx, NOW, utterance, { sayFallback: true });

const cardsOf = (result: ToolCallPlan): Array<Record<string, unknown>> =>
  result.actions.flatMap(action => action.type === "card.create" ? [action.card as unknown as Record<string, unknown>] : []);

describe("find_cards retrieval (pure, over the canvas context)", () => {
  it("matches titles, body text and entries literally", () => {
    const byTitle = findCardsOnCanvas({ query: "本周待办" }, lists());
    expect(byTitle.hits.map(hit => hit.id)).toEqual(["todo_week"]);
    expect(byTitle.hits[0]!.title).toBe("本周待办");

    const byBody = findCardsOnCanvas({ query: "发布窗口" }, lists());
    expect(byBody.hits.map(hit => hit.id)).toEqual(["note_meeting"]);

    const byEntry = findCardsOnCanvas({ query: "买牛奶" }, lists());
    expect(byEntry.hits.map(hit => hit.id)).toEqual(["todo_week"]);
    // The matching entry keeps its item id so the model can address it directly.
    expect(byEntry.hits[0]!.matchedEntries).toEqual([{ id: "item-2", text: "买牛奶" }]);
    expect(byEntry.hits[0]!.entries.map(entry => entry.id)).toEqual(["item-1", "item-2", "item-3"]);
  });

  it("ignores case and full-width/half-width differences", () => {
    const ctx = canvasOf([noteCard("note_budget", "Q4 Budget Review")]);
    expect(findCardsOnCanvas({ query: "ｑ４　ｂｕｄｇｅｔ" }, ctx).hits.map(hit => hit.id)).toEqual(["note_budget"]);
    expect(findCardsOnCanvas({ query: "q4 budget" }, ctx).hits.map(hit => hit.id)).toEqual(["note_budget"]);
  });

  it("filters by card type and caps the result at the requested limit", () => {
    const many = canvasOf([
      ...Array.from({ length: 5 }, (_, index) => noteCard(`note_${index}`, `笔记${index}`, index * 340)),
      todoCard("todo_1", "清单", ["牛奶"]),
    ]);
    const onlyTodos = findCardsOnCanvas({ type: "TodoCard" }, many);
    expect(onlyTodos.hits.map(hit => hit.id)).toEqual(["todo_1"]);

    const limited = findCardsOnCanvas({ query: "笔记", limit: 3 }, many);
    expect(limited.hits).toHaveLength(3);
    expect(limited.matched).toBe(5);
    expect(limited.truncated).toBe(true);
    // The tool schema's own ceiling wins over an out-of-range argument.
    expect(findCardsOnCanvas({ limit: 99 }, many).hits.length).toBe(6);
  });

  it("returns the canvas type census when nothing matches", () => {
    const miss = findCardsOnCanvas({ query: "火星" }, lists());
    expect(miss.hits).toEqual([]);
    expect(miss.matched).toBe(0);
    expect(miss.byType).toEqual([
      { type: "TodoCard", count: 2 },
      { type: "NoteCard", count: 1 },
    ]);
    // Searchable scope is honest: the host may only have a window of the canvas.
    const windowed = findCardsOnCanvas({ query: "火星" },
      canvasOf([noteCard("note_1", "笔记")], { totalCardCount: 100 }));
    expect(windowed.scanned).toBe(1);
    expect(windowed.total).toBe(100);
  });

  it("is read-only: a find_cards plan builds and changes nothing", async () => {
    const result = await plan([{ name: "find_cards", arguments: { query: "买牛奶" } }], lists(), "买牛奶在哪张卡");
    expect(result.kind).toBe("lookup");
    expect(result.lookup).toMatchObject({ kind: "cards", query: "买牛奶" });
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(cardsOf(result)).toEqual([]);
  });

  it("cannot share a batch with the tools that would consume the result", async () => {
    const result = await plan([
      { name: "find_cards", arguments: { query: "买牛奶" } },
      { name: "update_card", arguments: { item_id: "item-2", action: "done" } },
    ], lists(), "把买牛奶标成完成");
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.message).toContain("单独调用");
  });

  it("rejects an out-of-range limit instead of clamping silently", async () => {
    const result = await plan([{ name: "find_cards", arguments: { limit: 50 } }]);
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("invalid-param");
  });

  it("rejects an unknown card type instead of returning an empty 没找到", async () => {
    // `type` used to be cast to CardType, so a typo/translation matched nothing
    // and looked like an honest miss. It is now a structured issue.
    const result = await plan([{ name: "find_cards", arguments: { type: "Todo" } }]);
    expect(result.kind).toBe("invalid");
    expect(result.lookup).toBeUndefined();
    expect(result.issues[0]!.code).toBe("invalid-param");
    expect(result.issues[0]!.message).toContain("Todo");
    expect(result.issues[0]!.hint).toContain("TodoCard");
    // The real type name is still accepted.
    const valid = await plan([{ name: "find_cards", arguments: { type: "TodoCard" } }]);
    expect(valid.kind).toBe("lookup");
    expect(valid.lookup).toMatchObject({ kind: "cards", type: "TodoCard" });
  });
});

describe("the truncation is stated in the tool prompt", () => {
  const hundred = (): CanvasContext =>
    canvasOf(Array.from({ length: 100 }, (_, index) => noteCard(`note_${index}`, `内容${index}`, index * 340)));

  it("says how many cards exist and how many are listed", () => {
    const prompt = buildToolSystemPrompt(hundred());
    expect(prompt).toContain("共 100 张卡");
    expect(prompt).toContain("画布共 100 张卡，这里只列出最近的 24 张；要操作不在列表里的卡，先用 find_cards 查，不要猜 id");
    // The summary really is a window: card 30 is not listed, but is searchable.
    expect(prompt).not.toContain("- note_30 (NoteCard)");
    expect(findCardsOnCanvas({ query: "内容30" }, hundred()).hits.map(hit => hit.id)).toEqual(["note_30"]);
  });

  it("keeps the old prompt when every card is listed", () => {
    const small = lists();
    expect(buildToolSystemPrompt(small)).not.toContain("画布共 3 张卡，这里只列出最近的");
  });
});

/* ---------------------------- end to end: the one feed-back turn ---------------------------- */

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }> }

/** OpenAI-compatible `tool_calls`: one scripted reply per model turn. */
const scriptedToolFetch = (replies: ToolReply[]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt([reply]).map((reply, index) => ({ index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

const credential = { apiKey: "TEST-find-cards-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

const setup = (replies: ToolReply[], overrides: Partial<PipelineDeps> = {}) => {
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, generate, fetchImpl, calls };
};

const updatedItems = (result: Awaited<ReturnType<typeof runIntent>>, cardId: string): Array<Record<string, unknown>> => {
  const update = result.envelope?.actions.find(action => action.type === "card.update" && action.targetId === cardId);
  expect(update, JSON.stringify(result.envelope?.actions)).toBeDefined();
  return ((update as Extract<NonNullable<typeof update>, { type: "card.update" }>).displayProps as { items: Array<Record<string, unknown>> }).items;
};

describe("find_cards end to end: the canvas result goes back once", () => {
  it("finds the entry by text and lets the model edit it with the real ids", async () => {
    const f = setup([
      { name: "find_cards", args: { query: "买牛奶" } },
      { name: "update_card", args: { card_id: "todo_week", item_id: "item-2", action: "done" } },
    ]);
    const result = await runIntent({ text: "把买牛奶标成完成", canvasContext: lists() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    // Exactly one turn + one feed-back turn: no second read, no repair.
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(updatedItems(result, "todo_week")).toEqual([
      { id: "item-1", text: "交周报", done: false },
      { id: "item-2", text: "买牛奶", done: true },
      { id: "item-3", text: "预约牙医", done: false },
    ]);
    // The follow-up prompt carries the card id and the entry id as data.
    const followUp = f.calls[1]!.messages.at(-1)!;
    expect(followUp.role).toBe("user");
    expect(followUp.content).toContain("todo_week");
    expect(followUp.content).toContain("买牛奶(item-2)");
    expect(followUp.content).toContain("不要再调用 find_cards");
  });

  it("lets the model append to the list it found, then commits the card operation", async () => {
    const f = setup([
      { name: "find_cards", args: { query: "购物清单" } },
      { name: "create_card", args: { kind: "todo", fields: { card_id: "todo_shop", items: ["酱油"] } } },
    ]);
    const result = await runIntent({ text: "购物清单里加上酱油，我不记得是哪张清单", canvasContext: lists() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(updatedItems(result, "todo_shop").map(item => item.text)).toEqual(["鸡蛋", "洗衣液", "酱油"]);
  });

  it("lets the model build a card after the retrieval result arrives", async () => {
    const f = setup([
      { name: "find_cards", args: { type: "TodoCard" } },
      { name: "create_card", args: { kind: "note", fields: { text: "清单里的牛奶已买" } } },
    ]);
    const result = await runIntent({ text: "帮我整理一份会议纪要：议题是Q4预算评审，结论是下周一定稿", canvasContext: lists() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions.some(action => action.type === "card.create" && action.card.type === "NoteCard")).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns a miss with the type census and lets the model clarify itself", async () => {
    const f = setup([
      { name: "find_cards", args: { query: "火星" } },
      { name: "clarify", args: { missing: "target", question: "画布上没有火星这张卡，你说的是哪一张？" } },
    ]);
    const result = await runIntent({ text: "聚焦火星那张卡", canvasContext: lists() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.source).toBe("model");
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    const followUp = f.calls[1]!.messages.at(-1)!.content;
    expect(followUp).toContain("没找到文字「火星」");
    expect(followUp).toContain("画布卡型统计：TodoCard 2、NoteCard 1");
    expect(followUp).toContain("clarify(missing=target)");
  });

  it("never feeds back twice: a repeated find_cards ends honestly", async () => {
    const f = setup([
      { name: "find_cards", args: { query: "买牛奶" } },
      { name: "find_cards", args: { query: "买牛奶" } },
    ]);
    const result = await runIntent({ text: "把买牛奶标成完成", canvasContext: lists() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.message ?? "").toContain("已经查过画布");
  });

  it("does not stop at the host's old truncation guard: an id outside the summary works", async () => {
    const truncated = canvasOf(Array.from({ length: 64 }, (_, index) => tableCard(index)), { totalCardCount: 100 });
    // The summary lists only 24 cards; card-30 is outside it but inside the
    // searchable context, so find_cards → focus_card is a legitimate path.
    const f = setup([
      { name: "find_cards", args: { query: "表格30" } },
      { name: "view", args: { mode: "focus",  card_id: "card-30" } },
    ]);
    const result = await runIntent({ text: "聚焦第31张表格", canvasContext: truncated }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.focus", targetId: "card-30" }]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.interrupt).toBeUndefined();
  });

  it("still lets the model act directly on an id that is only outside the summary", async () => {
    const truncated = canvasOf(Array.from({ length: 64 }, (_, index) => tableCard(index)), { totalCardCount: 100 });
    const f = setup([{ name: "view", args: { mode: "focus",  card_id: "card-30" } }]);
    const result = await runIntent({ text: "聚焦第31张表格", canvasContext: truncated }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.focus", targetId: "card-30" }]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps the truncation safety on the degraded path (tool surface off)", async () => {
    const truncated = canvasOf(Array.from({ length: 64 }, (_, index) => tableCard(index)), { totalCardCount: 100 });
    const result = await runIntent({ text: "聚焦第31张表格", canvasContext: truncated },
      { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" } });
    expect(result.kind).toBe("clarify");
    expect(result.source).toBe("host");
    expect(result.envelope).toBeUndefined();
    expect(result.message ?? "").toContain("画布卡片较多");
  });
});
