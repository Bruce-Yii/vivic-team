import { describe, expect, it } from "vitest";
import type { Action, CardRecord } from "@vivic/contracts";
import { LAYOUT_VIEWPORT, newCardLayout, placeNewCards } from "../src/cards/build.js";
import { CredentialStore } from "../src/credentials.js";
import { scheduledReminderIntent } from "../src/intent/scheduledReminders.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import type { CanvasContext } from "../src/schemas.js";
import { emptyContext } from "./helpers.js";

const stamp = "2026-10-15T08:00:00.000Z";
type Existing = CanvasContext["cards"][number];

/** A card record as an envelope would produce it (all schema fields present). */
const card = (id: string, type: CardRecord["type"], layout: Partial<CardRecord["layout"]>): CardRecord => ({
  id, type, variant: "minimal", displayProps: {}, sourceData: {}, sources: [],
  layout: { x: 0, y: 0, width: 320, height: 120, pinned: false, ...layout },
  metadata: { createdAt: stamp, updatedAt: stamp },
} as CardRecord);

/** The compact card summary the control page sends back in canvasContext. */
const existingCard = (id: string, type: string, layout: Partial<Existing["layout"]>): Existing => ({
  id, type, displayProps: {}, sourceDataSummary: {},
  layout: { x: 0, y: 0, width: 320, height: 120, pinned: false, ...layout },
});

const create = (record: CardRecord): Action => ({ type: "card.create", card: record });

const context = (cards: Existing[] = []): CanvasContext => ({
  ...emptyContext(cards), timeZone: "Asia/Shanghai",
});

const overlaps = (a: { x: number; y: number; width?: number; height?: number },
  b: { x: number; y: number; width?: number; height?: number }): boolean =>
  a.x < b.x + (b.width ?? 640) && a.x + (a.width ?? 640) > b.x
  && a.y < b.y + (b.height ?? 480) && a.y + (a.height ?? 480) > b.y;

describe("new-card placement", () => {
  it("places a batch in the viewport without overlapping existing or sibling cards", () => {
    const existing = [
      existingCard("pinned", "NoteCard", { x: 0, y: 0, width: 600, height: 400, pinned: true }),
      existingCard("countdown-old", "CountdownCard", { x: 624, y: 0, width: 264, height: 96 }),
      existingCard("todo-old", "TodoCard", { x: 912, y: 0, width: 288, height: 160 }),
      existingCard("note-old", "NoteCard", { x: 0, y: 424, width: 320, height: 240 }),
    ];
    const ctx = context(existing);
    const before = structuredClone(ctx);
    const batch = [
      card("cd-1", "CountdownCard", { width: 264, height: 96 }),
      card("cd-2", "CountdownCard", { width: 264, height: 96 }),
      card("cd-3", "CountdownCard", { width: 264, height: 96 }),
      card("note-1", "NoteCard", { width: 320, height: 120 }),
      card("note-2", "NoteCard", { width: 320, height: 120 }),
      card("todo-1", "TodoCard", { width: 288, height: 160 }),
      card("todo-2", "TodoCard", { width: 288, height: 160 }),
    ].map(create);
    const placed = placeNewCards(batch, ctx);
    const cards = placed.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create")
      .map(action => action.card);

    expect(cards).toHaveLength(batch.length);
    expect(cards.every(record => record.layout.pinned === false)).toBe(true);
    for (const record of cards) {
      expect(record.layout.x).toBeGreaterThanOrEqual(0);
      expect(record.layout.y).toBeGreaterThanOrEqual(0);
      // All seven fit in the reference desktop viewport, not a row at y≈7220.
      expect(record.layout.x + (record.layout.width ?? 0)).toBeLessThanOrEqual(LAYOUT_VIEWPORT.width);
      expect(record.layout.y + (record.layout.height ?? 0)).toBeLessThanOrEqual(LAYOUT_VIEWPORT.height);
      for (const other of existing) expect(overlaps(record.layout, other.layout)).toBe(false);
    }
    for (let index = 0; index < cards.length; index++)
      for (let next = index + 1; next < cards.length; next++)
        expect(overlaps(cards[index]!.layout, cards[next]!.layout)).toBe(false);
    // Pinned and every existing card stayed exactly where they were.
    expect(ctx).toEqual(before);
    expect(ctx.cards[0]!.layout).toMatchObject({ x: 0, y: 0, pinned: true });
  });

  it("extends a new row downward instead of stretching row 0 past the viewport", () => {
    const existing = [
      existingCard("row-1", "NoteCard", { x: 0, y: 0, width: 440, height: 200 }),
      existingCard("row-2", "NoteCard", { x: 464, y: 0, width: 440, height: 200 }),
      existingCard("row-3", "NoteCard", { x: 928, y: 0, width: 440, height: 200 }),
    ];
    const ctx = context(existing);
    const [placed] = placeNewCards([create(card("newcomer", "NoteCard", { width: 360, height: 240 }))], ctx);
    if (placed?.type !== "card.create") throw new Error("Expected a create action");
    expect(placed.card.layout.y).toBeGreaterThan(0);
    expect(placed.card.layout.x + 360).toBeLessThanOrEqual(LAYOUT_VIEWPORT.width);
    for (const other of existing) expect(overlaps(placed.card.layout, other.layout)).toBe(false);
  });

  it("places a rules-only scheduled countdown off the origin and clear of the canvas", () => {
    const existing = [existingCard("pinned", "NoteCard", { x: 0, y: 0, width: 600, height: 400, pinned: true })];
    const ctx = context(existing);
    const now = Date.parse("2026-10-15T08:00:00Z");
    const scheduled = scheduledReminderIntent("明天上午9点提醒我开会", ctx, now);
    expect(scheduled?.actions).toBeDefined();
    const direct = scheduled!.actions!.find((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
    expect(direct).toBeDefined();
    // The rules-only builder itself now uses the shared packer.
    expect(direct!.card.layout.x !== 0 || direct!.card.layout.y !== 0).toBe(true);
    const placed = placeNewCards(scheduled!.actions!, ctx);
    const createAction = placed.find((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
    expect(createAction).toBeDefined();
    expect(createAction!.card.type).toBe("CountdownCard");
    expect(createAction!.card.layout.pinned).toBe(false);
    expect(createAction!.card.layout.x !== 0 || createAction!.card.layout.y !== 0).toBe(true);
    for (const other of existing) expect(overlaps(createAction!.card.layout, other.layout)).toBe(false);
  });

  it("runs the rules-direct scheduled reminder through the same pipeline placement", async () => {
    const existing = [existingCard("pinned", "NoteCard", { x: 0, y: 0, width: 600, height: 400, pinned: true })];
    const ctx = context(existing);
    const deps = { credentials: new CredentialStore(), stepfun: { baseUrl: "https://unused.test" } } as PipelineDeps;
    const result = await runIntent({ text: "明天上午9点提醒我开会", canvasContext: ctx }, deps);
    expect(result.kind).toBe("envelope");
    const createAction = result.envelope!.actions.find((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
    expect(createAction).toBeDefined();
    expect(createAction!.card.layout.x !== 0 || createAction!.card.layout.y !== 0).toBe(true);
    for (const other of existing) expect(overlaps(createAction!.card.layout, other.layout)).toBe(false);
  });

  it("uses the current camera as the search origin", () => {
    const layout = newCardLayout(320, 120, {
      ...context([existingCard("elsewhere", "NoteCard", { x: 0, y: 0, width: 320, height: 120 })]),
      // React Flow: screen = world * zoom + viewport; this camera shows the
      // world starting at (2000, 1200).
      viewport: { x: -2000, y: -1200, zoom: 1 },
    });
    expect(layout.x).toBeGreaterThanOrEqual(2000);
    expect(layout.y).toBeGreaterThanOrEqual(1200);
  });
});
