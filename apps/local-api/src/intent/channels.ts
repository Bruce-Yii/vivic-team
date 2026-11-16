import type { Action } from "@vivic/contracts";

const SAY_LIMIT = 40;
const TEXT_LIMIT = 120;
const LIST_SYMBOL = /[•‣⁃∙·●○◦▪▫■□☐☑✓✔◆◇①-⑳]/u;
const LIST_PREFIX = /(?:^|\s)(?:[-*+]|\p{Nd}+[.．](?!\p{Nd})|(?:\p{Nd}+|[一二三四五六七八九十百]+)[、)）]|[（(](?:\p{Nd}+|[一二三四五六七八九十百]+)[)）])/u;

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function truncate(value: string, limit: number): string {
  // Zod measures UTF-16 units; a truncated subtitle must still contain whole pairs.
  const shortened = value.slice(0, limit);
  return shortened.replace(/[\uD800-\uDBFF]$/u, "").trimEnd();
}

function safeSay(value: unknown): string | undefined {
  const say = nonemptyString(value);
  if (!say || say.length > SAY_LIMIT || /http/iu.test(say) || /\p{Nd}{6,}/u.test(say)
    || LIST_SYMBOL.test(say) || LIST_PREFIX.test(say)) return undefined;
  return say;
}

function subtitleText(value: unknown): string | undefined {
  const text = nonemptyString(value);
  return text ? truncate(text, TEXT_LIMIT) || undefined : undefined;
}

/** A pure conversational reply (no card change) is read aloud in full: the
 * subtitle is short enough, and a one-line "say" made introductions sound cut off. */
function conversationalSay(text: string | undefined): string | undefined {
  // subtitleText() hard-cuts at 120; never read a cut-off sentence aloud.
  if (text && text.length >= TEXT_LIMIT && !/[。！？!?]$/u.test(text)) text = text.match(/^[\s\S]*[。！？!?]/u)?.[0];
  if (!text || /http/iu.test(text) || /\p{Nd}{6,}/u.test(text) || LIST_SYMBOL.test(text) || LIST_PREFIX.test(text)) return undefined;
  return text;
}

export function normalizeOutputChannels(
  input: { say?: unknown; text?: unknown },
  fallbackText?: string,
  options: { conversational?: boolean } = {},
): { say?: string; text?: string } {
  const text = subtitleText(input.text) ?? subtitleText(fallbackText);
  if (options.conversational) {
    const full = conversationalSay(text);
    if (full) return { say: full, text: full };
  }
  // Keep URLs and long numbers on screen. Never read an unsafe fallback aloud.
  const firstSentence = text?.match(/^[\s\S]*?(?:[。！？!?]|\.(?!\p{Nd})|\r?\n|$)/u)?.[0] ?? "";
  const say = safeSay(input.say) ?? safeSay(truncate(firstSentence, SAY_LIMIT));
  return { ...(say ? { say } : {}), ...(text ? { text } : {}) };
}

export function applyOutputChannels(
  actions: Action[],
  channels: { say?: string; text?: string },
): { actions: Action[]; spokenText?: string } {
  const text = subtitleText(channels.text);
  // A conversational reply is read in full, i.e. exactly the subtitle (<= 120).
  const say = safeSay(channels.say) ?? (text && channels.say?.trim() === text ? conversationalSay(text) : undefined);
  const nextActions: Action[] = actions.filter(action => action.type !== "subtitle.show");
  if (text) nextActions.push({ type: "subtitle.show", text });
  return { actions: nextActions, ...(say ? { spokenText: say } : {}) };
}
