import type { IntentRouteId } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { namesCard, squash } from "./aliases.js";
import { cardTitle, selectedCards } from "./router.js";

/** Which mechanism decided the target. Optional so older callers and stored
 * traces stay valid; card text and titles never enter this field. */
export type TargetSource = "title" | "alias" | "focus" | "ordinal" | "type" | "spatial" | "classifier" | "frozen" | "user_pick" | "missing" | "ambiguous";
export type TargetResult = { targetId: string; source?: TargetSource } | { ambiguous: Array<{ id: string; label: string }>; source?: TargetSource } | { missing: true; source?: TargetSource };
type ContextCard = CanvasContext["cards"][number];
export const targetedRoutes: ReadonlySet<IntentRouteId> = new Set<IntentRouteId>(["focus", "highlight", "edit", "arrange", "delete"]);
const targeted = targetedRoutes;
const types: Array<[RegExp, RegExp]> = [[/待办|任务清单/, /TodoCard/], [/便签|便笺|笔记/, /NoteCard/],
  [/倒计时|计时器|提醒/, /CountdownCard/], [/天气/, /WeatherCard/], [/新闻|回答/, /NewsCard/],
  [/对比|比较/, /ComparisonCard/], [/日程|计划|安排/, /WeeklyScheduleCard|ScheduleCard|AgendaCard/],
  [/表格/, /TableCard/], [/图表/, /ChartCard/]];

/** A card's own item list length (todo items, bullets, points, key points). */
const itemCountOf = (card: ContextCard): number => {
  const props = card.displayProps as Record<string, unknown>;
  for (const key of ["items", "bullets", "keyPoints", "points"]) {
    const value = props[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
};

const CN_ORDINAL: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ordinalNumber = (raw: string): number => {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.length === 2 && raw[0] === "十") return 10 + (CN_ORDINAL[raw[1]!] ?? Number.NaN);
  if (raw.length === 2 && raw[1] === "十") return (CN_ORDINAL[raw[0]!] ?? Number.NaN) * 10;
  if (raw.length === 3 && raw[1] === "十") return (CN_ORDINAL[raw[0]!] ?? Number.NaN) * 10 + (CN_ORDINAL[raw[2]!] ?? Number.NaN);
  return CN_ORDINAL[raw] ?? Number.NaN;
};

/** "第一条" / "第31张" — the number plus what it counts. A bare "第N条" is only
 *  evidence when the named card really has that many entries; "第N张" only when
 *  the layout ordering really puts the model's card at N. */
export const parseOrdinal = (text: string): { n: number; unit: string } | undefined => {
  const match = /第\s*([一二三四五六七八九十百零两\d]{1,4})\s*([张条项点个行])/u.exec(text);
  if (!match) return undefined;
  const n = ordinalNumber(match[1]!);
  return Number.isFinite(n) && n > 0 ? { n, unit: match[2]! } : undefined;
};

const ITEM_UNITS = "条项点个行";
export const orderedCardsForRecall = (cards: ContextCard[]): ContextCard[] =>
  [...cards].sort((a, b) => (a.layout.y - b.layout.y) || (a.layout.x - b.layout.x));
const orderedCards = orderedCardsForRecall;

/** A spatial word names a direction, not a card. Bare 左/右 are deliberately not
 * matched, and a direction after a movement verb is a destination ("move it to
 * the left"), not a reference to the card already sitting there. */
type Spatial = { axis: "x" | "y"; pick: "min" | "max" | "middle" };
const spatialPattern = /最左|左边|左侧|左面|最右|右边|右侧|右面|最上|上面|上方|上边|顶部|最下|下面|下方|下边|底部|中间|正中|中央/u;
const spatialLexeme = (word: string): Spatial =>
  /最左|左边|左侧|左面/u.test(word) ? { axis: "x", pick: "min" }
    : /最右|右边|右侧|右面/u.test(word) ? { axis: "x", pick: "max" }
      : /最上|上面|上方|上边|顶部/u.test(word) ? { axis: "y", pick: "min" }
        : /最下|下面|下方|下边|底部/u.test(word) ? { axis: "y", pick: "max" }
          : { axis: "x", pick: "middle" };
/** "移到左边"/"往右"/"放在中间" place a card; they do not name one. A short
 * object may sit between the verb and the direction ("移到画布左边"). */
const destination = (text: string, index: number): boolean =>
  /(?:移到|移动到|挪到|搬到|放到|拖到|移至|移向|推向|放在|移去|挪去)[^，,。；;！!？?\n]{0,6}$/u.test(
    text.slice(Math.max(0, index - 14), index))
  || /[向往][^，,。；;！!？?\n]{0,6}$/u.test(text.slice(Math.max(0, index - 8), index));
/** The first direction word that refers to a card, skipping move destinations. */
const spatialOf = (text: string): Spatial | undefined => {
  for (const match of text.matchAll(new RegExp(spatialPattern.source, "gu"))) {
    if (!destination(text, match.index ?? 0)) return spatialLexeme(match[0]);
  }
  return undefined;
};
/** "A挪到B下面": the moved card is A, B is the reference and 下面 the axis.
 * The direction word is a destination, so it must not be read as the target. */
export type MoveDirection = "left" | "right" | "up" | "down";
export interface MovementParts { target: string; reference?: string; direction?: MoveDirection }
const MOVE_VERB = "(?:移到|移动到|挪到|搬(?:到|至)|放到|拖(?:到|至)|移至|移向|推向|放在|移去|挪去|挪至)";
const MOVE_WORD = /(左上角|右上角|左下角|右下角|左上|右上|左下|右下|最左|左边|左侧|左面|最右|右边|右侧|右面|最上|上面|上方|上边|顶部|最下|下面|下方|下边|底部|中间|正中|中央)$/u;
const moveDirection = (word: string): MoveDirection | undefined =>
  /左/u.test(word) ? "left" : /右/u.test(word) ? "right" : /上|顶/u.test(word) ? "up" : /下|底/u.test(word) ? "down" : undefined;
export function movementParts(text: string): MovementParts | undefined {
  const match = text.trim().match(new RegExp(`^(?:请|帮我|请帮我)?\\s*(?:把|将)?\\s*(.+?)\\s*${MOVE_VERB}\\s*(.*)$`, "u"));
  const target = match?.[1]?.trim();
  if (!target) return undefined;
  let rest = match![2]!.trim().replace(/[。！!？?]+$/u, "");
  const word = rest.match(MOVE_WORD);
  let reference: string | undefined;
  if (word?.index !== undefined) {
    reference = rest.slice(0, word.index).trim().replace(/(?:的|卡|卡片)$/u, "").trim();
    rest = rest.slice(word.index);
  }
  const direction = moveDirection(word?.[0] ?? rest);
  return { target, ...(reference ? { reference } : {}), ...(direction ? { direction } : {}) };
}
const position = (card: ContextCard, axis: "x" | "y") => card.layout[axis];
const extent = (card: ContextCard, axis: "x" | "y") => (axis === "x" ? card.layout.width : card.layout.height) ?? 0;
/** Cards whose anchors are closer than a fraction of their own size read as one
 * stack; "the left one" cannot be answered from coordinates alone then. */
const stacked = (a: ContextCard, b: ContextCard, axis: "x" | "y") =>
  Math.abs(position(a, axis) - position(b, axis)) < Math.max(16, Math.min(extent(a, axis), extent(b, axis)) * .15);

/** Titles, type names and layout only. Internal ids never reach the question,
 * the chip or the payload's visible label; the payload itself keeps the id. */
const typeNames: Record<string, string> = { TodoCard: "待办", NoteCard: "便签", CountdownCard: "倒计时",
  ComparisonCard: "对比", WeeklyScheduleCard: "日程",
  WeatherCard: "天气", NewsCard: "新闻", AnswerCard: "回答", TableCard: "表格", ChartCard: "图表",
  FileCard: "文件", ImageCard: "图片" };
const internalIdLike = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
  || /^[0-9a-f]{16,}$/iu.test(value) || /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/iu.test(value);
const displayTitle = (card: ContextCard): string | undefined => {
  const title = cardTitle(card).trim();
  return title && title !== card.id && !internalIdLike(title) ? title.slice(0, 120) : undefined;
};
/** The card face itself: a todo's first entry or the card's own first line. */
const excerptOf = (card: ContextCard): string | undefined => {
  const props = card.displayProps, source = card.sourceDataSummary;
  const first = Array.isArray(props.items) ? props.items.find(item => item && typeof item === "object"
    && typeof (item as { text?: unknown }).text === "string") : undefined;
  const text = (first as { text?: string } | undefined)?.text ?? props.text ?? props.body
    ?? source.text ?? source.body ?? source.reminderText;
  const trimmed = typeof text === "string" ? text.trim().replace(/\s+/gu, " ") : "";
  return trimmed && trimmed !== card.id && !internalIdLike(trimmed) ? trimmed.slice(0, 18) : undefined;
};
const sideOf = (card: ContextCard, pool: ContextCard[]): "左" | "右" | "中" => {
  const xs = pool.map(item => item.layout.x), min = Math.min(...xs), max = Math.max(...xs);
  if (min === max) return "中";
  return card.layout.x <= min ? "左" : card.layout.x >= max ? "右" : "中";
};
/** Type + card face + position, with a stable ordinal only when two labels would
 * otherwise be identical. */
const candidateLabel = (card: ContextCard, pool: ContextCard[]): string => {
  const title = displayTitle(card);
  if (title) return title;
  const head = typeNames[card.type] ?? (card.type.replace(/Card$/u, "") || "卡片");
  const excerpt = excerptOf(card);
  const where = `${sideOf(card, pool)}（x=${Math.round(card.layout.x)}, y=${Math.round(card.layout.y)}）`;
  return [excerpt ? `${head}「${excerpt}」` : head, where].join(" · ").slice(0, 120);
};

/** Candidate labels the user can pick from: title first, then type + card face +
 *  position. Internal ids never appear in the question; the payload keeps them. */
const cardLabels = (values: ContextCard[]): Array<{ id: string; label: string }> => {
  const titles = values.map(card => displayTitle(card));
  const base = values.map((card, index) => titles[index] ?? candidateLabel(card, values));
  const counts = new Map<string, number>();
  for (const label of base) counts.set(label, (counts.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  // Two cards that would read the same still have to be told apart by the user,
  // so a repeated title gains the same kind of position hint.
  return values.map((card, index) => {
    let label = base[index]!;
    if ((counts.get(label) ?? 0) > 1 && titles[index] !== undefined) {
      label = `${label}（${sideOf(card, values)} x=${Math.round(card.layout.x)}, y=${Math.round(card.layout.y)}）`;
    }
    const count = (seen.get(label) ?? 0) + 1;
    seen.set(label, count);
    return { id: card.id, label: (count > 1 ? `${label} #${count}` : label).slice(0, 120) };
  });
};

/** Entry-level referents: a todo item, a bullet note's line, a news key point. */
type Entry = { id?: string; text: string };
export type EntryTargetResult = { targetId: string; itemId?: string; label: string }
  | { ambiguous: Array<{ id: string; label: string }> };
const ENTRY_FIELDS = ["items", "bullets", "keyPoints"] as const;
const entryText = (value: unknown): string => typeof value === "string" ? value.trim()
  : value && typeof value === "object" && typeof (value as { text?: unknown }).text === "string"
    ? String((value as { text: string }).text).trim() : "";
const entryId = (value: unknown): string | undefined =>
  value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
    ? (value as { id: string }).id : undefined;
const entriesOf = (card: ContextCard): Entry[] => {
  const out: Entry[] = [];
  for (const field of ENTRY_FIELDS) {
    for (const source of [card.displayProps as Record<string, unknown>, card.sourceDataSummary as Record<string, unknown>]) {
      const values = source[field];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        const text = entryText(value);
        if (text) out.push({ ...(entryId(value) ? { id: entryId(value)! } : {}), text });
      }
    }
  }
  return out;
};
const flat = (value: string): string => value.replace(/\s+/gu, "");
/**
 * "高亮买牛奶那条" names an entry, not a card: the canvas summary may not contain
 * the entry text at all (sc-30), and two todo cards share the same type. The host
 * finds the entry itself — the longest named entry wins, and only a single card
 * may hold it; two candidates stay a question.
 */
export function resolveEntryTarget(text: string, context: CanvasContext): EntryTargetResult | undefined {
  const scope = flat(text);
  if (scope.length < 2) return undefined;
  const hits: Array<{ card: ContextCard; entry: Entry }> = [];
  const seen = new Set<string>();
  for (const card of selectedCards(context)) {
    for (const entry of entriesOf(card)) {
      const needle = flat(entry.text);
      if (needle.length < 2 || !scope.includes(needle)) continue;
      const key = `${card.id}\u0000${entry.id ?? needle}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ card, entry });
    }
  }
  if (!hits.length) return undefined;
  // "买牛奶" beats a shorter "牛奶" that another card also carries.
  const longest = Math.max(...hits.map(hit => flat(hit.entry.text).length));
  const top = hits.filter(hit => flat(hit.entry.text).length === longest);
  const cards = [...new Map(top.map(hit => [hit.card.id, hit.card])).values()];
  if (cards.length > 1) return { ambiguous: cardLabels(cards) };
  const card = cards[0]!;
  const entry = top.find(hit => hit.card.id === card.id)!.entry;
  return { targetId: card.id, ...(entry.id ? { itemId: entry.id } : {}), label: entry.text };
}

/** Resolve which existing card a sentence means, from the user's own words and
 * the canvas alone: an exact title/alias, a pointer (这张/它/刚才那张), an ordinal
 * inside the only list, a card type, or a layout direction. Anything the host
 * cannot prove from those facts stays `ambiguous`, which the caller turns into a
 * model question — the host never guesses and never picks for the model. */
export async function resolveTarget(text: string, context: CanvasContext, route: IntentRouteId): Promise<TargetResult | undefined> {
  if (!targeted.has(route)) return undefined;
  const cards = selectedCards(context);
  const labels = cardLabels;
  if (!cards.length) return { missing: true, source: "missing" };
  // "读书笔记挪到购物清单下面" names two cards: only the phrase before the
  // movement verb is the target; 购物清单 is the relation reference.
  const movement = route === "arrange" ? movementParts(text) : undefined;
  const scope = movement?.target ?? text;
  // Title / alias / translation containment (谷歌 → 「Google 公司介绍」), squashed
  // for case, spacing and punctuation. A name match is the user's own fact, so it
  // outranks the 这张 → focused-card shortcut below (sc-15).
  const names = cards.filter(card => namesCard(scope, [cardTitle(card), ...(card.aliases ?? [])]));
  if (names.length === 1) {
    const title = cardTitle(names[0]!);
    return { targetId: names[0]!.id, source: title.length >= 2 && squash(scope).includes(squash(title)) ? "title" : "alias" };
  }
  // More than one card named is a real choice for a single-target tool: the
  // 这张/它 shortcut below must not quietly pick the focused one.
  if (names.length > 1) return { ambiguous: labels(names), source: "ambiguous" };
  const ordinal = ["highlight", "edit"].includes(route) && /第[一二三四五六七八九十百\d]+[条项点行]/.test(scope);
  const hasEntries = (card: ContextCard) => [card.displayProps.items, card.displayProps.bullets,
    card.displayProps.keyPoints, card.displayProps.rows, card.sourceDataSummary.items, card.sourceDataSummary.bullets,
    card.sourceDataSummary.keyPoints].some(value => Array.isArray(value) && value.length > 0);
  if (/这张|它|刚才那张/.test(scope) || ordinal) {
    const focus = context.focusHistory.at(-1);
    const focused = cards.find(card => card.id === focus);
    // "待办第二项" names a type: a focused bullet note must not win over it.
    const named = types.find(([pattern]) => pattern.test(scope))?.[1];
    if (focused && (/这张|它|刚才那张/.test(scope) || hasEntries(focused) && (!named || named.test(focused.type)))) {
      return { targetId: focused.id, source: /这张|它|刚才那张/.test(scope) ? "focus" : "ordinal" };
    }
    if (ordinal) {
      const lists = cards.filter(hasEntries);
      // One list on the canvas is the only card "第二项" can mean.
      if (lists.length === 1) return { targetId: lists[0]!.id, source: "ordinal" };
      const typed = types.find(([pattern]) => pattern.test(scope))?.[1];
      const typedLists = typed ? lists.filter(card => typed.test(card.type)) : [];
      if (typedLists.length === 1) return { targetId: typedLists[0]!.id, source: "type" };
      return { ambiguous: labels(lists.length ? lists : cards), source: "ambiguous" };
    }
  }
  const type = types.find(([pattern]) => pattern.test(scope))?.[1];
  const pool = type ? cards.filter(card => type.test(card.type)) : cards;
  if (!pool.length) return { missing: true, source: "missing" };
  // A direction is answerable from the layout alone: pick the separated card,
  // and only ask among cards that visually sit on top of each other.
  const spatial = spatialOf(scope);
  if (spatial) return spatialTarget(pool, spatial, labels);
  if (type && pool.length === 1) return { targetId: pool[0]!.id, source: "type" };
  if (cards.some(card => ["ambiguous", "missing"].includes(card.id))) return { ambiguous: labels(pool), source: "ambiguous" };
  // A named card type or an explicit card reference that matched nothing is
  // absent from the canvas: listing every unrelated card as a candidate would
  // invite a wrong pick (sc-58).
  if (!type && !names.length && explicitCardReference(scope)) return { missing: true, source: "missing" };
  return { ambiguous: labels(names.length ? names : pool), source: "ambiguous" };
}

/** How the user's own words prove *which* card they mean, without the model's id.
 *  One of these is enough for a host to accept a model-chosen id; their absence
 *  is what makes a pick between several real cards a guess. */
export type TargetEvidence = "id" | "title" | "entry" | "focus" | "ordinal" | "spatial";

/** The clause that names the target. In "读书笔记挪到购物清单下面" only 读书笔记 is
 *  the card the user wants moved; 购物清单 is the relation and must not be counted
 *  as a second candidate. */
const targetScope = (text: string): string => movementParts(text)?.target ?? text;

/**
 * Unique evidence that the sentence itself points at exactly one card:
 *
 *   ①  the user typed the id the model used;
 *   ②  exactly one card answers to a title/alias the sentence contains;
 *   ③  the sentence names one entry, and that entry lives on one card;
 *   ④  it points ("它/这张/那张/刚才") and something is actually focused;
 *   ⑤  it counts ("第3张/第31条") — the user picked one by number, not by type;
 *   ⑥  a direction word (最左/最右/最上/最下/最后一张) whose layout separates one
 *       card from the rest.
 *
 * This is a *validation* input only. It never replaces the model's choice: a hit
 * means "the model's pick is provable", not "the host has decided".
 */
export function uniqueTargetEvidence(modelId: string, text: string, context: CanvasContext): TargetEvidence | undefined {
  const scope = targetScope(text);
  if (flat(scope).length < 2) return undefined;
  if (modelId && flat(text).toLowerCase().includes(flat(modelId).toLowerCase())) return "id";
  const cards = selectedCards(context);
  const names = cards.filter(card => namesCard(scope, [cardTitle(card), ...(card.aliases ?? [])]));
  if (names.length === 1) return "title";
  const entry = resolveEntryTarget(text, context);
  if (entry && "targetId" in entry) return "entry";
  const focus = context.focusHistory.at(-1);
  if (/这张|那张|它|刚才/u.test(scope) && focus !== undefined && cards.some(card => card.id === focus)) return "focus";
  // "聚焦第31张表格": the user counted — but only a count that really lands on
  // the model's card is evidence. "第一条" on a card with no entries proves nothing.
  const ordinal = parseOrdinal(scope);
  if (ordinal) {
    if (ITEM_UNITS.includes(ordinal.unit)) {
      const card = cards.find(value => value.id === modelId);
      if (card && itemCountOf(card) >= ordinal.n) return "ordinal";
    } else if (orderedCards(cards)[ordinal.n - 1]?.id === modelId) {
      return "ordinal";
    }
  }
  const spatial = spatialOf(scope) ?? (/最后一张/u.test(scope) ? { axis: "y" as const, pick: "max" as const } : undefined);
  if (!spatial) return undefined;
  // A direction word is only evidence when the layout really separates one card
  // from the others (two cards in one stack stay a question).
  const pool = names.length ? names : cards;
  return pool.length && "targetId" in spatialTarget(pool, spatial, cardLabels) ? "spatial" : undefined;
}

/**
 * The cards the sentence *positively* names — a title/alias it contains, an entry
 * it names, or a card-type word it uses. Deliberately not "every card that is
 * left": the caller uses `length >= 2` to tell "the user pointed at several real
 * cards" from "the user pointed at nothing" (which keeps today's behaviour).
 */
export function namedCards(text: string, context: CanvasContext): ContextCard[] {
  const scope = targetScope(text);
  const cards = selectedCards(context);
  const hits = new Map<string, ContextCard>();
  for (const card of cards) if (namesCard(scope, [cardTitle(card), ...(card.aliases ?? [])])) hits.set(card.id, card);
  const entry = resolveEntryTarget(text, context);
  if (entry) for (const id of "ambiguous" in entry ? entry.ambiguous.map(value => value.id) : [entry.targetId]) {
    const card = cards.find(value => value.id === id);
    if (card) hits.set(card.id, card);
  }
  const type = types.find(([pattern]) => pattern.test(scope))?.[1];
  if (type) for (const card of cards) if (type.test(card.type)) hits.set(card.id, card);
  return [...hits.values()];
}

/** Does this clause actually name a card, a card type, a position or a pronoun?
 * A follow-up that names none of them ("把标题改成…") inherits the card the
 * previous clause focused instead of asking "which card?" again. */
export const hasExplicitCardReference = (text: string, context: CanvasContext): boolean => {
  const cards = selectedCards(context);
  if (cards.some(card => namesCard(text, [cardTitle(card), ...(card.aliases ?? [])]))) return true;
  if (/这张|它|刚才那张/.test(text) || /第[一二三四五六七八九十百\d]+[条项点行]/.test(text)) return true;
  if (types.some(([pattern]) => pattern.test(text))) return true;
  const scope = movementParts(text)?.target ?? text;
  if (spatialOf(scope)) return true;
  return explicitCardReference(text);
};

/** The card a movement relation is anchored to ("购物清单" in
 * "读书笔记挪到购物清单下面"). Host-resolved: no model id or coordinate. */
export function resolveMovementReference(reference: string, context: CanvasContext, targetId: string):
  { targetId: string } | { ambiguous: true } | { missing: true } | undefined {
  const cards = selectedCards(context).filter(card => card.id !== targetId);
  const named = cards.filter(card => [cardTitle(card), ...(card.aliases ?? [])]
    .some(name => name.length >= 2 && (reference.includes(name) || name.includes(reference))));
  if (named.length === 1) return { targetId: named[0]!.id };
  if (named.length > 1) return { ambiguous: true };
  const type = types.find(([pattern]) => pattern.test(reference))?.[1];
  if (type) {
    const pool = cards.filter(card => type.test(card.type));
    if (pool.length === 1) return { targetId: pool[0]!.id };
    if (pool.length > 1) return { ambiguous: true };
  }
  // "画布/中间/屏幕" is a viewport relation, not a missing card.
  if (explicitCardReference(reference) || /卡/.test(reference)) return { missing: true };
  return undefined;
}

/** Layout-only spatial resolution: pick when the coordinates separate the cards,
 * clarify among the stack when they do not. */
function spatialTarget(pool: ContextCard[], spatial: Spatial,
  labels: (values: ContextCard[]) => Array<{ id: string; label: string }>): TargetResult {
  // 中间 has no fixed axis: use whichever direction actually separates the cards.
  const spread = (axis: "x" | "y") => {
    const values = pool.map(card => position(card, axis));
    return Math.max(...values) - Math.min(...values);
  };
  const axis = spatial.pick === "middle" && spread("y") > spread("x") ? "y" : spatial.axis;
  const sorted = [...pool].sort((a, b) => position(a, axis) - position(b, axis) || a.layout.y - b.layout.y);
  if (sorted.length === 1) return { targetId: sorted[0]!.id, source: "spatial" };
  if (spatial.pick === "middle") {
    const index = Math.floor(sorted.length / 2);
    // An even count has no middle card; an odd one must read clearly as the middle.
    if (sorted.length % 2 === 0) return { ambiguous: labels([sorted[index - 1]!, sorted[index]!]), source: "ambiguous" };
    const middle = sorted[index]!;
    const near = [sorted[index - 1], sorted[index + 1]].filter((card): card is ContextCard => card !== undefined)
      .filter(card => stacked(card, middle, axis));
    return near.length ? { ambiguous: labels([...near, middle].sort((a, b) => position(a, axis) - position(b, axis))), source: "ambiguous" }
      : { targetId: middle.id, source: "spatial" };
  }
  const extreme = spatial.pick === "min" ? sorted[0]! : sorted.at(-1)!;
  const next = spatial.pick === "min" ? sorted[1] : sorted.at(-2);
  if (!next || !stacked(extreme, next, axis)) return { targetId: extreme.id, source: "spatial" };
  return { ambiguous: labels(sorted.filter(card => stacked(card, extreme, axis))), source: "ambiguous" };
}

/** ``X卡``/``X卡片`` names a card; demonstratives and collectives ("这张卡", "所有卡片") do not. */
const explicitCardReference = (text: string): boolean => {
  const name = /([\u4e00-\u9fa5A-Za-z0-9]{2,8})卡(?:片)?/u.exec(text)?.[1];
  return name !== undefined && !/(?:所有|全部|这些|那些|整个|任何|每张|几张|哪张|这张|那张|这个|那个|哪个|几个|一些|一张)$/u.test(name);
};
