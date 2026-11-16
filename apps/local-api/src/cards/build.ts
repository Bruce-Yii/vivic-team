import { randomUUID } from "node:crypto";
import { CardRecordSchema, type Action, type CardRecord } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { CardBuildContext } from "./types.js";

/** The control page reports its camera, not its pixel size. This is the
 * reference desktop window (1440×900) used to bound a row; a measured viewport
 * may arrive later without changing the packer. */
export const LAYOUT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const GAP = 24;
// Missing footprints use a conservative fallback for older canvas contexts.
const FALLBACK = Object.freeze({ width: 640, height: 480 });

type Rect = { x: number; y: number; width: number; height: number };

const footprint = (card: CanvasContext["cards"][number]): Rect => ({
  x: card.layout.x,
  y: card.layout.y,
  width: card.layout.width ?? FALLBACK.width,
  height: card.layout.height ?? FALLBACK.height,
});

/** Rectangle intersection with the same breathing room the packer reserves
 * between two cards. */
const collides = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x
  && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y;

const worldViewport = (context: CanvasContext) => {
  const zoom = Number.isFinite(context.viewport.zoom) && context.viewport.zoom > 0 ? context.viewport.zoom : 1;
  // The control page reports React Flow's camera transform (screen = world *
  // zoom + viewport.x/y), so the visible world starts at -viewport.x / zoom.
  const left = -context.viewport.x / zoom, top = -context.viewport.y / zoom;
  return { left, top, right: left + LAYOUT_VIEWPORT.width / zoom, bottom: top + LAYOUT_VIEWPORT.height / zoom };
};

/**
 * Place one new card against the existing canvas. Existing cards, including
 * pinned cards, are obstacles and never move. The first free slot inside the
 * current viewport wins (left-to-right, top-to-bottom, including holes left by
 * differently sized cards); when the viewport has no room, the card starts a
 * new row just below the cards already in view instead of extending row 0 to
 * x≈15000. `context` must already contain every card created earlier in the
 * same batch.
 */
export function newCardLayout(width: number, height: number, context: CardBuildContext): CardRecord["layout"] {
  const occupied = context.cards.map(footprint);
  const bounds = worldViewport(context);
  if (!(width > 0) || !(height > 0)) return { x: bounds.left, y: bounds.top, width, height, pinned: false };
  const xs = [...new Set([bounds.left, ...occupied.map(rect => rect.x + rect.width + GAP)])]
    .filter(x => x >= bounds.left).sort((a, b) => a - b);
  // A card can only start on the viewport's top edge or immediately below a
  // card that is already visible; this keeps the search finite and compact.
  const ys = [...new Set([bounds.top, ...occupied.filter(rect => rect.y + rect.height <= bounds.bottom)
    .map(rect => rect.y + rect.height + GAP)])]
    .filter(y => y >= bounds.top).sort((a, b) => a - b);
  for (const y of ys) {
    if (y + height > bounds.bottom) continue;
    for (const x of xs) {
      if (x + width > bounds.right) continue;
      if (!occupied.some(rect => collides({ x, y, width, height }, rect))) return { x, y, width, height, pinned: false };
    }
  }
  // No room in the viewport: extend downward below the lowest card that is
  // itself in view. Cards far outside the window never push new cards away.
  const inView = occupied.filter(rect => rect.y < bounds.bottom);
  const top = inView.length ? Math.max(...inView.map(rect => rect.y + rect.height)) + GAP : bounds.top;
  const base = { width, height, pinned: false as const };
  for (const x of [...new Set([bounds.left, ...occupied.map(rect => rect.x + rect.width + GAP)])]
    .filter(x => x >= bounds.left).sort((a, b) => a - b)) {
    if (!occupied.some(rect => collides({ ...base, x, y: top }, rect))) return { ...base, x, y: top };
  }
  return { ...base, x: bounds.left, y: top };
}

/**
 * Assign a layout to every unpinned `card.create` in an envelope before the
 * host commits it. Rules-only paths (scheduled reminders, fast todo/note/
 * countdown), planner paths, tool calls and composite actions all meet here,
 * so one card can never be committed at the model's default `{x:0,y:0}` while
 * another was placed by `newCardLayout`.
 *
 * Deletions earlier in the batch are applied to the working set first: a card
 * created after "delete this card" may reuse the freed slot. A pinned new card
 * is left exactly where its builder put it and becomes an obstacle.
 */
export function placeNewCards(actions: Action[], context: CanvasContext): Action[] {
  if (!actions.some(action => action.type === "card.create")) return actions;
  let cards: CanvasContext["cards"] = [...context.cards];
  const next = actions.map(action => {
    if (action.type === "card.delete") {
      cards = cards.filter(card => card.id !== action.targetId);
      return action;
    }
    if (action.type === "cards.delete") {
      const removed = new Set(action.targetIds);
      cards = cards.filter(card => !removed.has(card.id));
      return action;
    }
    if (action.type !== "card.create") return action;
    const width = action.card.layout.width ?? FALLBACK.width;
    const height = action.card.layout.height ?? FALLBACK.height;
    const placedRect = { x: action.card.layout.x, y: action.card.layout.y, width, height };
    // Re-place the model's default origin and any card that already collides
    // with the working canvas. A card a builder placed with newCardLayout is
    // left alone: re-running the same packer would reset an intentional
    // arrangement (for example a scene's side-by-side quotes).
    const origin = action.card.layout.x === 0 && action.card.layout.y === 0;
    const colliding = cards.some(card => collides(placedRect, footprint(card)));
    const layout = action.card.layout.pinned || !origin && !colliding
      ? action.card.layout
      : newCardLayout(width, height, { ...context, cards });
    const card = { ...action.card, layout: { ...action.card.layout, ...layout } };
    cards = [...cards, { id: card.id, type: card.type, aliases: card.metadata.aliases,
      displayProps: card.displayProps, sourceDataSummary: card.sourceData, layout: card.layout }];
    return { ...action, card };
  });
  return next;
}

export const awakenFor = (actions: Action[], context: CardBuildContext): Action[] =>
  context.stage === "STANDBY" ? [{ type: "stage.awaken" }, ...actions] : actions;

export function createCardActions(
  data: Pick<CardRecord, "type" | "displayProps" | "sourceData">,
  size: { width: number; height: number },
  context: CardBuildContext,
  now: Date,
  variant: CardRecord["variant"] = "minimal",
): Action[] {
  const stamp = now.toISOString();
  const card = CardRecordSchema.parse({
    ...data,
    id: `${data.type.replace(/Card$/, "").toLowerCase()}_${randomUUID()}`,
    variant,
    sources: [],
    layout: newCardLayout(size.width, size.height, context),
    metadata: { createdAt: stamp, updatedAt: stamp },
  });
  return awakenFor([{ type: "card.create", card }, { type: "card.focus", targetId: card.id }], context);
}
