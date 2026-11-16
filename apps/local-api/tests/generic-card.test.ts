import { describe, expect, it, vi } from "vitest";
import { NoteCardSchema, type Action } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentRequest, type PipelineDeps } from "../src/intent/pipeline.js";
import { TOOL_DEFINITIONS, buildToolSystemPrompt, findCardsOnCanvas, planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { withReceipt } from "./helpers.js";

/**
 * The generic card on the tool surface.
 *
 * Outside the 27 card types the model now has an honest shape: `create_card(
 * kind="note")` with a heading plus 1–4 titled blocks. The card is still built by
 * `cards/note.ts` (no CardRecord is written here), `displayProps.sections` is the
 * existing contract, and `style` never enters `displayProps` — the display
 * contract is strict, so an unknown field would drop the whole card — it travels
 * in `sourceData.vicicStyle`. See docs/decisions/2026-11-04-generic-card.md.
 */

const NOW = Date.parse("2026-11-04T10:00:00+08:00");

const canvas = (cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId: "TEST-generic-card", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards,
});

const plan = (calls: ToolCall[], utterance = "", ctx: CanvasContext = canvas()): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, ctx, NOW, utterance, { sayFallback: true });

const noteCall = (fields: Record<string, unknown>): ToolCall =>
  ({ name: "create_card", arguments: { kind: "note", fields } });

const creates = (result: ToolCallPlan): Array<Extract<Action, { type: "card.create" }>> =>
  result.actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");

const issuesOf = (result: ToolCallPlan): string => result.issues.map(String).join(" | ");

/** The user's own words for the acceptance sentence in the design doc. */
const MOVE_SECTIONS = [
  { title: "证件", items: ["要提前办迁移"] },
  { title: "水电", items: ["提前三天报停"] },
  { title: "网络", items: ["提前一周预约"] },
];
const MOVE_UTTERANCE = "帮我整理一下这次搬家的注意事项：证件要提前办迁移，水电提前三天报停，网络提前一周预约";

describe("create_card(kind=note): text-only notes are unchanged", () => {
  it("builds the same NoteCard it always did", async () => {
    const result = await plan([noteCall({ text: "明天交周报" })]);
    expect(result.kind, issuesOf(result)).toBe("envelope");
    expect(result.routes).toEqual(["note"]);
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    const card = creates(result)[0]!.card;
    expect(card.type).toBe("NoteCard");
    expect(card.displayProps).toEqual({ text: "明天交周报" });
    expect(card.sourceData).toEqual({});
    expect(card.variant).toBe("minimal");
    expect(card.layout.width).toBe(320);
    expect(card.layout.height).toBe(120);
    expect(NoteCardSchema.safeParse(card).success).toBe(true);
  });
});

describe("create_card(kind=note): sections-only generic cards", () => {
  it("builds a NoteCard whose displayProps carry the contract's sections", async () => {
    const result = await plan([noteCall({ sections: MOVE_SECTIONS })], MOVE_UTTERANCE);
    expect(result.kind, issuesOf(result)).toBe("envelope");
    expect(result.routes).toEqual(["note"]);
    const card = creates(result)[0]!.card;
    expect(card.type).toBe("NoteCard");
    expect(card.displayProps).toEqual({ sections: MOVE_SECTIONS });
    expect(card.sourceData).toEqual({});
    // A structured note gets room to read, but never a hand-written record.
    expect(card.variant).toBe("standard");
    expect(card.layout.width).toBe(340);
    expect(card.layout.height).toBeGreaterThanOrEqual(220);
    expect(card.layout.height).toBeLessThanOrEqual(420);
    expect(NoteCardSchema.parse(card).displayProps.sections).toEqual(MOVE_SECTIONS);
  });

  it("keeps a card-level title out of displayProps and hands it to the model", async () => {
    const titled = await plan([noteCall({ title: "搬家注意事项", sections: MOVE_SECTIONS })]);
    expect(titled.kind, issuesOf(titled)).toBe("envelope");
    const card = creates(titled)[0]!.card;
    expect(card.displayProps).toEqual({ sections: MOVE_SECTIONS });
    expect(card.sourceData).toMatchObject({ vicicTitle: "搬家注意事项" });
    expect(JSON.stringify(card.displayProps)).not.toContain("搬家注意事项");

    // The summary is how the model resolves "把搬家那张卡固定住" later: a card
    // with no `text` still needs a label, and its own title is the best one.
    const prompt = buildToolSystemPrompt(canvas([{
      id: "note_move", type: "NoteCard", displayProps: { sections: MOVE_SECTIONS },
      sourceDataSummary: { vicicTitle: "搬家注意事项" }, layout: { x: 0, y: 0, width: 340, height: 300, pinned: false },
    }]));
    expect(prompt).toContain("「搬家注意事项」");
  });

  it("stays findable by its title and by what a block says", async () => {
    const ctx = canvas([{
      id: "note_move", type: "NoteCard", displayProps: { sections: MOVE_SECTIONS },
      sourceDataSummary: { vicicTitle: "搬家注意事项" }, layout: { x: 0, y: 0, width: 340, height: 300, pinned: false },
    }]);
    // No `text` field at all: the title and the blocks are the only text there is.
    expect(findCardsOnCanvas({ query: "搬家注意事项" }, ctx).hits.map(hit => hit.id)).toEqual(["note_move"]);
    expect(findCardsOnCanvas({ query: "提前三天报停" }, ctx).hits.map(hit => hit.id)).toEqual(["note_move"]);
    expect(findCardsOnCanvas({ query: "水电" }, ctx).hits.map(hit => hit.id)).toEqual(["note_move"]);
    expect(findCardsOnCanvas({ query: "车票" }, ctx).hits).toEqual([]);
  });
});

describe("create_card(kind=note): exactly one content shape", () => {
  it("rejects text and sections given together", async () => {
    const result = await plan([noteCall({ text: "搬家注意事项", sections: MOVE_SECTIONS })]);
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(result.issues[0]!.code).toBe("invalid-param");
    expect(result.issues[0]!.message).toContain("只能给一个");
    expect(result.issues[0]!.hint).toContain("sections");
  });

  it("rejects a note with neither text nor sections", async () => {
    const empty = await plan([noteCall({})]);
    expect(empty.kind).toBe("invalid");
    expect(empty.actions).toEqual([]);
    expect(empty.issues[0]!.code).toBe("invalid-param");
    expect(empty.issues[0]!.message).toContain("便笺");
    expect(empty.issues[0]!.message).toContain("sections");

    // A title (or a style) is not content: the card still has nothing to show.
    const titled = await plan([noteCall({ title: "搬家注意事项" })]);
    expect(titled.kind).toBe("invalid");
    expect(titled.issues[0]!.code).toBe("invalid-param");
  });
});

describe("create_card(kind=note): caps are refused, never truncated", () => {
  const section = (items: string[], title = "证件") => ({ title, items });
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["five blocks", { sections: [...MOVE_SECTIONS, section(["提前打招呼"], "邻居"), section(["钥匙"], "其他")] }, "sections"],
    ["seven entries in one block", { sections: [section(["a", "b", "c", "d", "e", "f", "g"])] }, "items"],
    ["a block title over 40 characters", { sections: [section(["证件"], "区".repeat(41))] }, "title"],
    ["an entry over 180 characters", { sections: [section(["字".repeat(181)])] }, "items"],
    ["a text over 500 characters", { text: "字".repeat(501) }, "text"],
    ["a card title over 60 characters", { title: "题".repeat(61), sections: MOVE_SECTIONS }, "title"],
    ["an unknown style tone", { sections: MOVE_SECTIONS, style: { tone: "loud" } }, "style"],
    ["an unknown style accent", { sections: MOVE_SECTIONS, style: { accent: "purple" } }, "style"],
    ["an empty list of blocks", { sections: [] }, "sections"],
  ];

  it.each(cases)("rejects %s with an invalid-param issue", async (_name, fields, field) => {
    const result = await plan([noteCall(fields)], MOVE_UTTERANCE);
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(creates(result)).toEqual([]);
    expect(result.issues[0]!.code).toBe("invalid-param");
    // The issue names the field that broke, so the model can repair it.
    expect(issuesOf(result)).toContain(field);
    expect(result.issues[0]!.message).toContain("便笺");
  });

  it("keeps the whole batch when one call is valid and one breaks a cap", async () => {
    const result = await plan([
      noteCall({ sections: MOVE_SECTIONS }),
      noteCall({ sections: [section(["a", "b", "c", "d", "e", "f", "g"])] }),
    ], MOVE_UTTERANCE);
    expect(result.kind).toBe("invalid");
    expect(creates(result)).toEqual([]);
    expect(issuesOf(result)).toContain("#2 create_card(note)");
  });
});

describe("create_card(kind=note): style is presentation, not content", () => {
  it("writes style to sourceData.vicicStyle and never to displayProps", async () => {
    const style = { tone: "focus", accent: "amber" } as const;
    const result = await plan([noteCall({ title: "搬家注意事项", sections: MOVE_SECTIONS, style })]);
    expect(result.kind, issuesOf(result)).toBe("envelope");
    const card = creates(result)[0]!.card;
    expect(card.displayProps).toEqual({ sections: MOVE_SECTIONS });
    expect(JSON.stringify(card.displayProps)).not.toContain("style");
    expect(JSON.stringify(card.displayProps)).not.toContain("amber");
    // `NoteCardSchema` is strict: this would throw if style had leaked in.
    expect(NoteCardSchema.parse(card).sourceData).toMatchObject({ vicicStyle: { tone: "focus", accent: "amber" } });
  });

  it("writes nothing at all when the model sent no style", async () => {
    const result = await plan([noteCall({ text: "明天交周报" })]);
    const card = creates(result)[0]!.card;
    expect(card.sourceData).not.toHaveProperty("vicicStyle");
    expect(card.sourceData).not.toHaveProperty("vicicTitle");
    expect(card.sourceData).toEqual({});
  });

  it("drops an empty style object instead of storing a meaningless one", async () => {
    const result = await plan([noteCall({ text: "明天交周报", style: {} })]);
    expect(result.kind, issuesOf(result)).toBe("envelope");
    expect(creates(result)[0]!.card.sourceData).toEqual({});
  });
});

describe("the generic card is documented on the surface the model reads", () => {
  it("says what kind=note accepts, including the caps", () => {
    const createCard = TOOL_DEFINITIONS.find(tool => tool.function.name === "create_card")!.function;
    expect(createCard.description).toContain("通用卡");
    expect(createCard.description).toContain("sections");
    expect(createCard.description).toContain("1–4 个区块");
    expect(createCard.description).toContain("1–6 条");
  });

  it("tells the system prompt when to use it and that content must be the user's own words", () => {
    const prompt = buildToolSystemPrompt(canvas());
    expect(prompt).toContain("7b. 通用卡");
    expect(prompt).toContain("不要为了凑卡型");
    expect(prompt).toContain("每个字都必须来自用户原话");
    // The old blanket "never use kind=note" line would contradict 7b.
    expect(prompt).not.toContain("也不要走 create_card(kind=\"note\")");
  });
});

/* -------------------------------------------------------------- pipeline */

type ToolRequest = { messages: Array<{ role: string; content: unknown }> };

function setup(calls: ToolCall[], options: { sections?: boolean } = {}): {
  deps: PipelineDeps; toolRequests: ToolRequest[]; generate: ReturnType<typeof vi.fn>;
} {
  const toolRequests: ToolRequest[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    toolRequests.push(JSON.parse(String(init?.body)) as ToolRequest);
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(calls).map((call, index) => ({
      index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const deps: PipelineDeps = {
    credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true,
    sections: options.sections,
    toolCredential: { apiKey: "TEST-generic-card-key", models: ["tool-model"], defaultModel: "tool-model",
      checkedAt: new Date().toISOString() },
  };
  return { deps, toolRequests, generate };
}

const intent = (): IntentRequest => ({ text: MOVE_UTTERANCE, canvasContext: canvas() });

describe("pipeline: a request outside the 27 card types reaches a generic card", () => {
  it("commits the model's generic card with sections intact", async () => {
    const f = setup([noteCall({ title: "搬家注意事项", sections: MOVE_SECTIONS })], { sections: true });
    const result = await runIntent(intent(), f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
    expect(f.toolRequests).toHaveLength(1);

    const created = result.envelope!.actions.find((action): action is Extract<Action, { type: "card.create" }> =>
      action.type === "card.create");
    if (!created) throw new Error("TEST expected a created generic card");
    expect(created.card.type).toBe("NoteCard");
    const parsed = NoteCardSchema.parse(created.card);
    expect(parsed.displayProps.sections).toEqual(MOVE_SECTIONS);
    expect(parsed.sourceData).toMatchObject({ vicicTitle: "搬家注意事项" });
  });

  it("still renders on a client without the sections contract", async () => {
    // `VIVIC_SECTIONS` off: the pipeline flattens the blocks into plain text, so
    // the generic card reaches the deployed renderer as ordinary note content.
    const f = setup([noteCall({ sections: MOVE_SECTIONS })]);
    const result = await runIntent(intent(), f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const created = result.envelope!.actions.find((action): action is Extract<Action, { type: "card.create" }> =>
      action.type === "card.create");
    if (!created) throw new Error("TEST expected a created generic card");
    const props = created.card.displayProps as Record<string, unknown>;
    expect(props).not.toHaveProperty("sections");
    expect(String(props.text)).toContain("证件");
    expect(String(props.text)).toContain("提前三天报停");
  });
});
