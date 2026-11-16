import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, TodoCardSchema } from "@vivic/contracts";
import { CARD_CONTRACTS } from "../src/cards/index.js";
import { buildToolSystemPrompt, planFromToolCalls, TOOL_DEFINITIONS, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";

/**
 * sc-07 — "新建一个任务清单，准备搬家". The user asked for a *list*, not for
 * entries: the contract used to require a non-empty `items`, so the model had
 * no card to build and asked "想先记哪几件事" instead of creating the list.
 *
 * A titled list with zero entries is the list contract itself: `title` or
 * `items` must be present, and the host still builds through the todo card's
 * own builder (never a hand-written CardRecord). The entries path, the append
 * path and their validation are unchanged.
 */

const NOW = Date.parse("2026-11-01T02:00:00+08:00");

const canvas = (): CanvasContext => ({
  canvasId: "TEST-todo-empty-list",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  timeZone: "Asia/Shanghai",
  cards: [
    {
      id: "todo_week", type: "TodoCard", aliases: ["本周待办"],
      displayProps: { title: "本周待办", items: [{ id: "item-1", text: "交周报", done: true }] },
      sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160 },
    },
    {
      id: "note_meeting", type: "NoteCard", aliases: ["会议记录"],
      displayProps: { text: "周会纪要" }, sourceDataSummary: {},
      layout: { x: 320, y: 0, width: 320, height: 120 },
    },
  ],
});

const plan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, canvas(), NOW, utterance, { sayFallback: true });

const creates = (result: ToolCallPlan) =>
  result.actions.flatMap(action => action.type === "card.create" ? [action.card] : []);

const invalid = (result: ToolCallPlan) => {
  expect(result.kind).toBe("invalid");
  expect(result.actions).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.issues.length).toBeGreaterThan(0);
};

const envelope = (result: ToolCallPlan) => {
  expect(result.actions.length).toBeGreaterThan(0);
  const parsed = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6", requestId: "req_todo_empty_list", canvasId: "TEST-todo-empty-list", actions: result.actions,
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
};

describe("create_card(kind=todo): a list may be just its title", () => {
  it("builds a titled TodoCard with zero entries when the user asks for a list", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: { title: "搬家清单" } } }],
      "帮我新建一个任务清单，准备搬家");
    expect(result.kind, JSON.stringify(result.issues)).toBe("envelope");
    const [card] = creates(result);
    expect(card?.type).toBe("TodoCard");
    expect(card?.displayProps).toEqual({ title: "搬家清单", items: [] });
    // The builder still produced a real card record that passes the contract and
    // the envelope: nothing was hand-written here.
    expect(TodoCardSchema.safeParse(card).success).toBe(true);
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.routes).toEqual(["todo"]);
    envelope(result);
  });

  it("keeps the entries path unchanged (items only, program IDs)", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶", "交周报"] } } }],
      "加个待办：买牛奶；交周报");
    expect(result.kind).toBe("envelope");
    expect(creates(result)[0]?.displayProps).toEqual({ items: [
      { id: "item-1", text: "买牛奶", done: false },
      { id: "item-2", text: "交周报", done: false },
    ] });
  });

  it("keeps both halves when the user gave a title and entries", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: {
      title: "搬家清单", items: ["约搬家公司", "整理证件"],
    } } }], "帮我建个搬家清单：约搬家公司、整理证件");
    expect(result.kind).toBe("envelope");
    expect(creates(result)[0]?.displayProps).toEqual({ title: "搬家清单", items: [
      { id: "item-1", text: "约搬家公司", done: false },
      { id: "item-2", text: "整理证件", done: false },
    ] });
  });

  it("refuses a todo with neither title nor items", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: {} } }], "新建一个任务清单");
    invalid(result);
    expect(result.issues[0].code).toBe("invalid-param");
    expect(result.issues[0].message).toContain("title");
    expect(result.issues[0].message).toContain("items");
    // The hint carries the rule the model got wrong: title-only is a real list.
    expect(result.issues[0].hint).toContain("不要追问条目");
  });

  it("still refuses an empty items array and stays out of the title-only path", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: { items: [] } } }], "新建一个任务清单");
    invalid(result);
    expect(result.issues[0].code).toBe("invalid-param");
    expect(result.issues[0].message).toContain("待办条目不能为空");
  });

  it("keeps appending to an existing card unchanged", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: {
      card_id: "todo_week", items: ["酱油"],
    } } }], "本周待办里加上酱油");
    expect(result.kind).toBe("envelope");
    expect(creates(result)).toEqual([]);
    expect(result.routes).toEqual(["edit"]);
    expect(result.actions).toEqual([{ type: "card.update", targetId: "todo_week", displayProps: { items: [
      { id: "item-1", text: "交周报", done: true },
      { id: "item-2", text: "酱油", done: false },
    ] } }]);
    // The existing title is preserved by the merge, not replaced by the model.
    expect(result.actions[0]).not.toHaveProperty("displayProps.title");
  });

  it("refuses an append that carries no entries", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_week", title: "本周待办" } } }],
      "往本周待办加条");
    invalid(result);
    expect(result.issues[0].code).toBe("invalid-param");
    expect(result.issues[0].message).toContain("items");
  });
});

describe("the todo contract itself accepts a titled empty list", () => {
  const context = (): CanvasContext => ({ ...canvas(), cards: [] });

  it("builds title-only slots through the contract's builder", async () => {
    const built = await CARD_CONTRACTS.todo!.build({ title: "搬家清单" }, context(), new Date(NOW));
    expect(Array.isArray(built)).toBe(true);
    const card = (built as Array<{ type: string; card?: unknown }>).find(action => action.type === "card.create")!;
    expect((card as { card: { displayProps: unknown } }).card.displayProps).toEqual({ title: "搬家清单", items: [] });
    expect(TodoCardSchema.safeParse((card as { card: unknown }).card).success).toBe(true);
  });

  it("refuses slots with neither half", async () => {
    await expect(Promise.resolve().then(() => CARD_CONTRACTS.todo!.build({}, context(), new Date(NOW)))).rejects.toThrow();
    await expect(Promise.resolve().then(() => CARD_CONTRACTS.todo!.build({ items: [] }, context(), new Date(NOW)))).rejects.toThrow();
  });
});

describe("the tool surface tells the model not to ask for entries", () => {
  const create = TOOL_DEFINITIONS.find(tool => tool.function.name === "create_card")!.function.description;

  it("documents title or items on the todo kind", () => {
    expect(create).toContain("kind=todo");
    expect(create).toContain("两者至少给一个");
    expect(create).toContain("空条目的标题型清单");
    expect(create).toContain("不要追问条目");
  });

  it("names the list-vs-entry rule in the system prompt", () => {
    const prompt = buildToolSystemPrompt(canvas());
    expect(prompt).toContain("建清单不等于加条目");
    expect(prompt).toContain("不要反问「想先记哪几件事」");
  });
});
