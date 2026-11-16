import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, TodoCardSchema } from "@vivic/contracts";
import { buildToolSystemPrompt, planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import { emptyContext } from "./helpers.js";

/**
 * sc-07 — "新建一个任务清单，准备搬家". A todo list is a *plan*: the model may add
 * the regular steps a goal implies (pack, book movers, change the address), and
 * that is not a fabrication. The line between the two categories is now explicit:
 *
 *  - facts (dates, clock times, prices, links) must come from the user's words;
 *  - suggestions / plans / summaries / card titles may be generated, but must not
 *    be presented as something the user said.
 *
 * The note card keeps its original-text semantics: every character of a NoteCard
 * still comes from the user's words.
 */

const NOW = Date.parse("2026-11-01T02:00:00+08:00");

const plan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, emptyContext(), NOW, utterance, { sayFallback: true });

const todo = (fields: Record<string, unknown>): ToolCall[] =>
  [{ name: "create_card", arguments: { kind: "todo", fields } }];

const creates = (result: ToolCallPlan) =>
  result.actions.flatMap(action => action.type === "card.create" ? [action.card] : []);

const invalid = (result: ToolCallPlan) => {
  expect(result.kind).toBe("invalid");
  expect(result.actions).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.issues.length).toBeGreaterThan(0);
};

const envelope = (result: ToolCallPlan) => {
  const parsed = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6", requestId: "req_todo_suggestions", canvasId: "c1", actions: result.actions,
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
};

describe("create_card(kind=todo): suggestions are allowed, facts are not", () => {
  it("accepts entries the model generated from the user's goal", async () => {
    const result = await plan(todo({
      title: "搬家清单",
      items: ["打包物品", "预约搬家公司", "变更收货地址"],
    }), "新建一个任务清单，准备搬家");
    expect(result.kind, JSON.stringify(result.issues)).toBe("envelope");
    const [card] = creates(result);
    expect(card?.type).toBe("TodoCard");
    expect(card?.displayProps).toEqual({ title: "搬家清单", items: [
      { id: "item-1", text: "打包物品", done: false },
      { id: "item-2", text: "预约搬家公司", done: false },
      { id: "item-3", text: "变更收货地址", done: false },
    ] });
    expect(TodoCardSchema.safeParse(card).success).toBe(true);
    expect(result.issues).toEqual([]);
    envelope(result);
  });

  it("still refuses a generated date the user never said", async () => {
    const result = await plan(todo({ items: ["2026-12-01 打包物品"] }), "准备搬家");
    invalid(result);
    expect(result.issues[0].code).toBe("ungrounded");
    expect(result.issues[0].message).toContain("2026-12-01");
  });

  it("still refuses a generated price the user never said", async () => {
    const result = await plan(todo({ items: ["预算 5000 元"] }), "准备搬家");
    invalid(result);
    expect(result.issues[0].code).toBe("ungrounded");
    expect(result.issues[0].message).toContain("5000");
  });

  it("still refuses a generated link the user never said", async () => {
    const result = await plan(todo({ items: ["参考 https://example.com/moving"] }), "准备搬家");
    invalid(result);
    expect(result.issues[0].code).toBe("ungrounded");
    expect(result.issues[0].message).toContain("https://example.com/moving");
  });

  it("accepts a date the user actually said", async () => {
    const result = await plan(todo({ items: ["10月15日前打包"] }), "10月15日前打包，记个待办");
    expect(result.kind, JSON.stringify(result.issues)).toBe("envelope");
    expect(creates(result)[0]?.displayProps).toEqual({ items: [{ id: "item-1", text: "10月15日前打包", done: false }] });
  });

  it("keeps the append path under the same fact rule", async () => {
    const context = emptyContext([{
      id: "todo_week", type: "TodoCard", aliases: ["本周待办"],
      displayProps: { title: "本周待办", items: [{ id: "item-1", text: "交周报", done: false }] },
      sourceDataSummary: {}, layout: { x: 0, y: 0, width: 288, height: 160 },
    }]);
    const result = await planFromToolCalls(todo({ card_id: "todo_week", items: ["11月20日 交周报"] }),
      context, NOW, "往本周待办加一条");
    expect(result.kind).toBe("invalid");
    expect(result.issues[0].code).toBe("ungrounded");
  });
});

describe("the note card keeps its original-text semantics", () => {
  it("records the user's own words verbatim and is not turned into suggestions", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } }],
      "记个便签：明天交周报");
    expect(result.kind).toBe("envelope");
    expect(creates(result)[0]?.displayProps).toEqual({ text: "明天交周报" });
  });

  it("keeps the note rule and adds the two-category rule in the prompt", () => {
    const prompt = buildToolSystemPrompt(emptyContext());
    // The note's every-character rule stays exactly as before.
    expect(prompt).toContain("区块和条目里的每个字都必须来自用户原话");
    // The old one-size-fits-all rule is replaced by the fact/suggestion split.
    expect(prompt).not.toContain("只填用户说过的事实；没说的钟点、日期、数量不要编");
    expect(prompt).toContain("事实与建议分开");
    expect(prompt).toContain("待办清单的建议事项");
    expect(prompt).toContain("不得伪装成用户说过的事实");
    // The todo tool contract names the allowance.
    expect(prompt).toContain("常规建议事项");
  });
});
