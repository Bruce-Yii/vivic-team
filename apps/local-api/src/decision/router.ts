import type { CanvasContext } from "../schemas.js";

/**
 * Canvas label helpers.
 *
 * This file used to hold the 4B route/target router (`createIntentRouter`,
 * route and target classification, the `VIVIC_DECISION_MODE` switch). That
 * second decision authority is gone: the model decides, and the host only
 * derives facts from the canvas. What remains are the pure card-description
 * helpers shared by the host's derivation and tool layers; nothing here chooses
 * anything.
 */

type ContextCard = CanvasContext["cards"][number];

function short(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.slice(0, 8).map(short).filter(Boolean).join("、");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return short(record.text ?? record.title ?? record.label ?? record.value);
  }
  return "";
}

/** The card's human name: its title, first alias, reminder text, else its id. */
export function cardTitle(card: ContextCard): string {
  const event = card.sourceDataSummary.event;
  return short(card.displayProps.title ?? card.displayProps.headline ?? card.sourceDataSummary.title)
    || card.aliases?.[0] || short(card.sourceDataSummary.reminderText
      ?? (event && typeof event === "object" ? (event as Record<string, unknown>).title : undefined)) || card.id;
}

/** One bounded line: type, title, the first useful body detail and its position. */
export function cardLabel(card: ContextCard): string {
  const props = card.displayProps, source = card.sourceDataSummary;
  const target = typeof source.targetAt === "string" ? Date.parse(source.targetAt) : NaN;
  const clock = typeof source.pausedAt === "string" ? Date.parse(source.pausedAt) : Date.now();
  const remaining = card.type === "CountdownCard" && Number.isFinite(target) && Number.isFinite(clock)
    ? `${Math.max(0, Math.ceil((target - clock) / 60_000))}分钟` : undefined;
  const detail = short(props.items ?? source.items ?? props.text ?? props.body ?? props.bullets ?? source.text ?? source.body ?? source.bullets
    ?? props.keyPoints ?? source.keyPoints ?? props.points ?? source.points ?? props.summary ?? source.summary
    ?? props.remaining ?? source.remaining ?? remaining ?? source.label);
  return `${card.type}「${cardTitle(card)}」${detail} 位置x=${card.layout.x},y=${card.layout.y}`.slice(0, 110);
}

/** Most relevant first: the focused card, then the most recently updated, then
 * the canvas order. Bounded so a large canvas cannot dominate a prompt. */
export function selectedCards(context: CanvasContext): ContextCard[] {
  const focused = context.focusHistory.at(-1);
  return context.cards.map((card, index) => ({ card, index })).sort((a, b) => {
    const focus = Number(b.card.id === focused) - Number(a.card.id === focused);
    if (focus) return focus;
    const updated = (card: ContextCard) => {
      const value = card.sourceDataSummary.updatedAt ?? card.displayProps.updatedAt;
      return typeof value === "string" ? Date.parse(value) || 0 : 0;
    };
    return updated(b.card) - updated(a.card) || a.index - b.index;
  }).slice(0, 40).map(value => value.card);
}
