import { ActionEnvelopeSchema } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import type { IntentResult } from "../intent/pipeline.js";
import { cardTitle } from "./router.js";
import { resolveTarget } from "./target.js";
import { deletionLabel } from "./confirmation.js";

type ContextCard = CanvasContext["cards"][number];

/** Whether a proposed deletion may run without a second question.
 *
 * The user's rule is: a delete whose target is already unambiguous runs once;
 * only an ambiguous, multi-card or mismatched target is asked about. "Already
 * unambiguous" is decided from host evidence only — an explicit card id, a
 * unique title/alias/content match, or the focus the user pointed at — never
 * from the planner's own confidence. */
export type DeleteVerdict =
  // `targetId` is set only when the host had to correct the proposed target:
  // a pure pointer ("删了它") has exactly one referent, the last focused card.
  | { mode: "direct"; reason: "explicit_id" | "title" | "alias" | "content" | "focus" | "type" | "spatial"; targetId?: string }
  | { mode: "confirm"; reason: "batch" | "composite" | "ambiguous" | "unresolved" | "stale"; targetId?: string }
  | { mode: "refuse"; reason: "unresolved" | "not_found"; message: string };

/** Command, politeness, deictic, spatial and ordinal words carry no card content.
 * Stripped before matching so "把刚才那张删掉" names no card at all. */
const NOISE = /(?:请帮我|帮我|请|麻烦|劳驾|给我|把|将|删除|删掉|删去|移除|去掉|清除|清掉|扔掉|丢掉|删了|删|移走|拿走|创建|新建|建立|添加|生成|写的|写|做的|做|弄|加的|加|打开的|打开|显示的|显示|这张|那张|这个|那个|这些|那些|这种|那种|这里|那里|它|它们|刚才|刚刚|之前|先前|原来|上面|下面|里面|最左|左边|左侧|左面|最右|右边|右侧|右面|最上|上方|上边|顶部|最下|下方|下边|底部|中间|正中|中央|没用了|没有用|没用的|没用|不要了|不需要了|多余的|废的|垃圾|所有|全部|全都|整个|画布|当前|现在|马上|立刻|顺便|然后|以及|或者|还是|和|与|及|或|的|了|吧|啊|呀|呢|吗|哦|嘛|哈|嗯)/gu;
const ORDINAL = /第[一二三四五六七八九十百零两\d]+[张个条项份号]?/gu;
const SPLIT = /[^\u4e00-\u9fa5A-Za-z0-9]+/gu;
/** A bare type word names a class of cards, not one card: it can only be
 * answered by the type rule in `resolveTarget`, never by content matching. */
const TYPE_WORD = /^(?:待办|任务清单|任务|事项|便签|便笺|笔记|便条|清单|倒计时|计时器|计时|提醒|天气|新闻|回答|对比|比较|日程|计划|安排|表格|图表|卡片|卡|文件|图片)$/u;
/** Demonstratives make the sentence point at a card instead of naming one. */
const DEICTIC = /这张|那张|这个|那个|这些|那些|它|刚才|这|那/u;

const normalize = (value: string): string => value.toLocaleLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, "").replace(/[的了呢吧啊呀哦嘛]/gu, "");

/** Command, politeness, pronoun and sentence-final words left after a delete verb
 * name nothing at all: "删了它"/"删掉刚才那个"/"把这张删除"/"删了" only point at
 * the card the user was just looking at. */
const DELETE_NOISE = /(?:请帮我|帮我|请|麻烦|劳驾|给我|把|将|删除|删掉|删去|移除|去掉|清除|清掉|扔掉|丢掉|删了|删|移走|拿走|这张|那张|这个|那个|这些|那些|这种|那种|它|它们|刚才那个|刚才那张|刚才|刚刚|之前那个|之前那张|之前|先前|原来|一下|的|了|吧|啊|呀|呢|吗|哦|嘛|哈|嗯)/gu;
const DELETE_VERB = /删除|删掉|删去|删了|删|移除|去掉|清除|清掉|扔掉|丢掉|移走|拿走/u;
/** A negated or scoped sentence is not a bare pointer: it must not become a
 * one-click delete of whatever happens to be focused. */
const NOT_A_POINTER = /不要|不用|别|无需|不必|如果|要是|是否|能否|是不是|有没有|没有|吗|么|呢|[？?]/u;
const SCOPED_DELETE = /所有|全部|全都|整个|清空|多张|几张|[两二三四五六七八九十\d]+张/u;

/** What a delete sentence that names no card can only mean: the most recently
 * focused card. `undefined` means the sentence carries content words and stays on
 * the ordinary matching path. `mode: "confirm"` is the single-card canvas where
 * the pointer has one possible referent but no focus evidence — it still asks,
 * because nothing was explicitly focused. `{ message }` is an honest refusal
 * (never "which card?"), used when the canvas offers nothing to point at. */
export type DeicticDeletion = { targetId: string; mode: "direct" | "confirm" } | { message: string };

export function deicticDeletion(utterance: string, context: CanvasContext): DeicticDeletion | undefined {
  const text = utterance.trim();
  if (!text || NOT_A_POINTER.test(text) || SCOPED_DELETE.test(text) || !DELETE_VERB.test(text)) return undefined;
  if (text.replace(DELETE_NOISE, "").replace(/[\s\p{P}\p{S}]+/gu, "")) return undefined;
  const focus = context.focusHistory.at(-1);
  const focused = focus ? context.cards.find(card => card.id === focus) : undefined;
  if (focused) return { targetId: focused.id, mode: "direct" };
  // A stale focus means the card the user pointed at is gone; never delete a
  // replacement that happens to sit on the canvas now.
  if (focus) return { message: "刚才聚焦的卡片已经不在画布上，本次没有删除。请直接说要删除的卡片名称。" };
  // No focus evidence at all: a lone card is still the only possible referent,
  // so keep the ordinary confirmation instead of refusing.
  if (context.cards.length === 1) return { targetId: context.cards[0]!.id, mode: "confirm" };
  if (!context.cards.length) return { message: "画布上没有可删除的卡片，本次没有删除。" };
  // Only the pointer failed, never the request: say exactly what is missing
  // instead of listing every card and asking "which one?".
  return { message: "画布上还没有聚焦过卡片，无法确定“它”指谁；本次没有删除。请直接说要删除的卡片名称。" };
}

/** A pointer that did not match the proposal means the proposal is wrong, not the
 * request: the single `card.delete` is moved onto the focused card. */
export function retargetDeletion(proposal: IntentResult, targetId: string): IntentResult {
  const parsed = ActionEnvelopeSchema.safeParse(proposal.envelope);
  if (!parsed.success) return proposal;
  return { ...proposal, envelope: { ...parsed.data, actions: parsed.data.actions.map(action =>
    action.type === "card.delete" ? { ...action, targetId } : action) } };
}

/** Content words left after command, deictic and type vocabulary is removed. */
function contentTokens(text: string): string[] {
  return text.replace(NOISE, " ").replace(ORDINAL, " ").split(SPLIT)
    .map(token => token.trim())
    .filter(token => token.length >= 2 && !TYPE_WORD.test(token));
}

/** Every human-readable string on a card face, for "does the user's wording
 * describe this card". Ids, layout and metadata are deliberately excluded. */
function cardTexts(card: ContextCard): string[] {
  const values: string[] = [];
  const push = (value: unknown) => { if (typeof value === "string" && value.trim()) values.push(value); };
  const props = card.displayProps;
  push(props.title); push(props.headline); push(props.text); push(props.body);
  push(props.summary); push(props.label); push(props.name); push(props.caption);
  for (const key of ["items", "bullets", "keyPoints", "points", "rows"]) {
    const value = props[key];
    if (!Array.isArray(value)) continue;
    for (const item of value.slice(0, 20)) {
      if (typeof item === "string") { push(item); continue; }
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      push(record.text); push(record.label); push(record.title);
    }
  }
  for (const alias of card.aliases ?? []) push(alias);
  const source = card.sourceDataSummary;
  push(source.title); push(source.text); push(source.body); push(source.reminderText); push(source.label);
  const title = cardTitle(card);
  if (title !== card.id) push(title);
  return values;
}

/** The cards the sentence actually describes. `named` says the user used
 * content words at all; `cards` says which of them exist on the canvas. */
function describedCards(text: string, context: CanvasContext): { cards: ContextCard[]; named: boolean } {
  const tokens = contentTokens(text);
  if (!tokens.length) return { cards: [], named: false };
  const cards = context.cards.filter(card => {
    const haystack = cardTexts(card).map(normalize).filter(value => value.length >= 2);
    return tokens.some(token => {
      const needle = normalize(token);
      return needle.length >= 2 && haystack.some(value => value.includes(needle) || needle.includes(value));
    });
  });
  return { cards, named: true };
}

/** An id typed into the message is an explicit reference, not a guess. */
function explicitId(text: string, context: CanvasContext): ContextCard | undefined {
  const named = context.cards.filter(card => card.id.length >= 6 && text.includes(card.id));
  return named.length === 1 ? named[0] : undefined;
}

const quote = (card: ContextCard): string => `「${deletionLabel(card)}」`;

/** Presentation-only actions ride along with a delete without being a second
 * operation: they change no card and no canvas. Anything else is a composite. */
const PRESENTATIONAL: ReadonlySet<string> = new Set(["stage.awaken", "subtitle.show", "subtitle.hide", "ambient.setPreset"]);

/** A single `card.delete` against an existing card, and nothing else. */
function singleDeletion(proposal: IntentResult, context: CanvasContext):
  { target: ContextCard } | { verdict: DeleteVerdict } | undefined {
  if (proposal.hostOperation) return { verdict: { mode: "confirm", reason: "composite" } };
  const parsed = ActionEnvelopeSchema.safeParse(proposal.envelope);
  if (!parsed.success) return undefined;
  if (parsed.data.canvasId !== context.canvasId) return { verdict: { mode: "confirm", reason: "stale" } };
  const actions = parsed.data.actions.filter(action => !PRESENTATIONAL.has(action.type));
  const deletions = actions.filter(action => action.type === "card.delete" || action.type === "cards.delete");
  if (!deletions.length) return undefined;
  if (deletions.length > 1 || actions.length !== 1) return { verdict: { mode: "confirm", reason: "composite" } };
  const action = deletions[0]!;
  if (action.type !== "card.delete") return { verdict: { mode: "confirm", reason: "batch" } };
  const matches = context.cards.filter(card => card.id === action.targetId);
  if (matches.length !== 1) return { verdict: { mode: "confirm", reason: "stale" } };
  return { target: matches[0]! };
}

export async function assessDeletion(proposal: IntentResult, context: CanvasContext, utterance: string): Promise<DeleteVerdict | undefined> {
  const single = singleDeletion(proposal, context);
  if (!single) return undefined;
  if ("verdict" in single) return single.verdict;
  const target = single.target;

  // A sentence that only points ("删了它", "删掉刚才那个", "删了") carries no card
  // content of its own; its one possible referent is the most recently focused
  // card. The host decides that directly instead of asking the user "which card?".
  const deictic = deicticDeletion(utterance, context);
  if (deictic) {
    if ("message" in deictic) return { mode: "refuse", reason: "not_found", message: deictic.message };
    // One card and no focus evidence: the referent is unique but not explicit,
    // so keep the ordinary confirmation while pinning the frozen target.
    if (deictic.mode === "confirm") return { mode: "confirm", reason: "unresolved", targetId: deictic.targetId };
    return deictic.targetId === target.id ? { mode: "direct", reason: "focus" }
      : { mode: "direct", reason: "focus", targetId: deictic.targetId };
  }

  const typed = explicitId(utterance, context);
  if (typed) return typed.id === target.id ? { mode: "direct", reason: "explicit_id" }
    : { mode: "confirm", reason: "unresolved", targetId: target.id };

  const host = await resolveTarget(utterance, context, "delete");
  const hostTarget = host && "targetId" in host ? host.targetId : undefined;
  const hostSource = host && "targetId" in host ? host.source : undefined;
  const hostCard = hostTarget === undefined ? undefined : context.cards.find(card => card.id === hostTarget);
  const described = describedCards(utterance, context);

  // Content the sentence actually names outranks the focus: a user who says
  // "会议纪要" while a countdown is focused must not lose the countdown.
  if (described.cards.length > 1) return { mode: "confirm", reason: "ambiguous" };
  const describedCard = described.cards[0];
  if (describedCard && describedCard.id !== target.id)
    return { mode: "confirm", reason: "unresolved", targetId: target.id };
  // Content words that match nothing describe a card that is not on the canvas.
  // A demonstrative ("那个东西") points instead of naming, so it only confirms.
  if (described.named && !describedCard && !DEICTIC.test(utterance))
    return { mode: "confirm", reason: "unresolved", targetId: target.id };

  // With no content words, the host resolver (title, alias, type, focus) is the
  // only evidence left; when it names another card the proposal is wrong.
  if (!describedCard && hostCard && hostCard.id !== target.id)
    return { mode: "confirm", reason: "unresolved", targetId: target.id };

  if (describedCard) return { mode: "direct", reason: "content" };
  if (hostCard) return { mode: "direct", reason: hostSource === "focus" ? "focus" : hostSource === "type" ? "type"
    : hostSource === "spatial" ? "spatial" : hostSource === "alias" ? "alias" : "title" };
  return { mode: "confirm", reason: "unresolved" };
}
