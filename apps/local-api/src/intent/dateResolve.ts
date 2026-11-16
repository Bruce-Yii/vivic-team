import { addDays, dayOfWeek, isoOf, mondayOf, todayIn, validDate, type Ymd } from "../scenes/calendar.js";

/**
 * Deterministic resolver for the relative dates Chinese speakers actually say:
 *
 *   今天 / 昨天 / 明天 / 后天 / 大后天 / 前天 / 大前天
 *   最近三天 / 最近一周 / 过去 7 天
 *   本周一到周三 / 这周一二三 / 周一、二、三 / 周一到周三 / 上周五 / 下周一
 *   10月15日 / 2026-10-15
 *
 * The resolver is the host's answer to "the contract only stores ISO dates, so
 * the model has to ask which days". Nothing here is a guess: every output is a
 * single date uniquely determined by the user's own words plus the request's
 * "today" (the caller's clock, never the wall clock at a later moment). Weeks
 * are Monday-first, so 本周一 is the first day of the week that contains today.
 *
 * Two consumers:
 *  - `normalizeSceneData` turns a week word the model copied from the sentence
 *    into the ISO dates the card contract requires (habit check-ins, schedule
 *    and calendar dates);
 *  - scene grounding accepts a derived date as evidence when it is exactly one
 *    of these values ("can be uniquely derived from the user's words"), while
 *    numbers, links, authors and DOIs stay strictly literal.
 */
export interface DateResolveOptions {
  /** The request's clock (ms). Defaults to now. */
  now?: number;
  /** IANA zone the user's "today" is in. Defaults to Asia/Shanghai. */
  timeZone?: string;
}

export type ResolvedDateKind = "explicit" | "relative" | "recent" | "weekday" | "range";

export interface ResolvedDate {
  /** YYYY-MM-DD */
  iso: string;
  /** ISO weekday: Monday = 1 … Sunday = 7. */
  weekday: number;
  /** The words this date was derived from. */
  text: string;
  kind: ResolvedDateKind;
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const CN_DIGIT: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const WEEK = "(?:周|星期|礼拜)";
/** A week prefix decides which Monday is the base: 上=-1, 下=+1, 本/这=0. */
const PREFIX = "(上上|上|这|本|下下|下)?";

const shiftOf = (prefix: string | undefined): number =>
  prefix === "上上" ? -2 : prefix === "上" ? -1 : prefix === "下下" ? 2 : prefix === "下" ? 1 : 0;

const cnNumber = (raw: string): number => {
  if (/^\d+$/u.test(raw)) return Number(raw);
  if (raw === "十") return 10;
  if (raw.length === 1) return CN_DIGIT[raw] ?? Number.NaN;
  if (raw.length === 2 && raw[0] === "十") return 10 + (CN_DIGIT[raw[1]!] ?? 0);
  if (raw.length === 2 && raw[1] === "十") return (CN_DIGIT[raw[0]!] ?? 0) * 10;
  return Number.NaN;
};

/** 今天/昨天/明天…, longest word first so 大后天 is not read as 后天. */
const RELATIVE_DAY: Array<{ pattern: RegExp; offset: number; label: string }> = [
  { pattern: /大前天/u, offset: -3, label: "大前天" },
  { pattern: /(?<!大)前天/u, offset: -2, label: "前天" },
  { pattern: /昨天|昨日/u, offset: -1, label: "昨天" },
  { pattern: /今天|今日|今晚|今早|今夜/u, offset: 0, label: "今天" },
  { pattern: /明天|明日|明早|明晚/u, offset: 1, label: "明天" },
  { pattern: /大后天/u, offset: 3, label: "大后天" },
  { pattern: /(?<!大)后天/u, offset: 2, label: "后天" },
];

/**
 * Every date the user's words uniquely determine, de-duplicated and sorted.
 * A bare weekday (no 本/这/上/下) means this week's occurrence — the same
 * reading the prompt gives the model ("今天" is a fixed anchor).
 */
export function resolveDates(text: string, options: DateResolveOptions = {}): ResolvedDate[] {
  if (!text) return [];
  const today = todayIn(options.timeZone ?? "Asia/Shanghai", options.now ?? Date.now());
  const found = new Map<string, ResolvedDate>();
  const add = (date: Ymd, kind: ResolvedDateKind, source: string): void => {
    const iso = isoOf(date);
    if (!found.has(iso)) found.set(iso, { iso, weekday: dayOfWeek(date), text: source, kind });
  };
  const mondayFor = (prefix: string | undefined): Ymd => addDays(mondayOf(today), shiftOf(prefix) * 7);

  // Explicit ISO dates are already contract-shaped; keep them as evidence.
  for (const match of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/gu)) {
    const date = validDate(+match[1]!, +match[2]!, +match[3]!);
    if (date) add(date, "explicit", match[0]);
  }

  // "10月15日" / "十月十五号": the request's own year (a habit record never
  // means last year's October unless the user said so).
  for (const match of text.matchAll(/(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*月\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,3})\s*[日号]/gu)) {
    const month = cnNumber(match[1]!), day = cnNumber(match[2]!);
    if (!Number.isFinite(month) || !Number.isFinite(day)) continue;
    const date = validDate(today.year, month, day);
    if (date) add(date, "explicit", match[0]);
  }

  for (const { pattern, offset, label } of RELATIVE_DAY) {
    if (pattern.test(text)) add(addDays(today, offset), "relative", label);
  }

  // Arithmetic offsets: "3 天后" / "还有 25 天" / "再过两周" / "月底". These are as
  // deterministic as "明天" — the user's own words plus today decide one date —
  // so one resolver owns them instead of each card type re-parsing them.
  for (const match of text.matchAll(/([一二两三四五六七八九十\d]{1,3})\s*天\s*(?:后|以后|之后)/gu)) {
    const count = cnNumber(match[1]!);
    if (Number.isFinite(count) && count >= 0 && count <= 400) add(addDays(today, count), "relative", match[0]);
  }
  for (const match of text.matchAll(/(?:还有|再有|剩|再过|过)\s*([一二两三四五六七八九十\d]{1,3})\s*(天|周|星期|礼拜|个月|月)/gu)) {
    const count = cnNumber(match[1]!);
    const unit = match[2]!;
    const days = unit === "天" ? count : unit === "个月" || unit === "月" ? count * 30 : count * 7;
    if (Number.isFinite(days) && days >= 0 && days <= 400) add(addDays(today, days), "relative", match[0]);
  }
  if (/(?:月底|月末|这个月最后一天)/u.test(text)) {
    const last = new Date(Date.UTC(today.year, today.month, 0));
    const date = validDate(last.getUTCFullYear(), last.getUTCMonth() + 1, last.getUTCDate());
    if (date) add(date, "relative", "月底");
  }

  // "最近三天" / "过去 7 天": a window ending today, inclusive.
  for (const match of text.matchAll(/(?:最近|近|过去|这)\s*([一二两三四五六七八九十\d]{1,3})\s*天/gu)) {
    const count = cnNumber(match[1]!);
    if (!Number.isFinite(count) || count < 1 || count > 31) continue;
    for (let offset = count - 1; offset >= 0; offset -= 1) add(addDays(today, -offset), "recent", match[0]);
  }
  for (const match of text.matchAll(/(?:最近|近|过去)\s*([一二两三四五六七八九十\d]{1,3})\s*(?:个)?(?:周|星期|礼拜)/gu)) {
    const weeks = cnNumber(match[1]!);
    if (!Number.isFinite(weeks) || weeks < 1 || weeks > 8) continue;
    for (let offset = weeks * 7 - 1; offset >= 0; offset -= 1) add(addDays(today, -offset), "recent", match[0]);
  }

  // A weekday range names both ends: "本周一到周三", "周一至周三".
  // Ranges are parsed first and their spans recorded: the trailing weekday of
  // "上周一到周三" must not be read again as this week's Wednesday.
  const consumed: Array<[number, number]> = [];
  const insideRange = (index: number): boolean => consumed.some(([start, end]) => index >= start && index < end);
  for (const match of text.matchAll(new RegExp(`(?<!每)\\s*${PREFIX}\\s*(?:个)?\\s*${WEEK}\\s*([一二三四五六日天])\\s*(?:到|至|[-—–~～])\\s*(?:个)?\\s*(?:周|星期|礼拜)?\\s*([一二三四五六日天])`, "gu"))) {
    const from = WEEKDAY[match[2]!], to = WEEKDAY[match[3]!];
    if (!from || !to || from > to) continue;
    const monday = mondayFor(match[1]);
    for (let day = from; day <= to; day += 1) add(addDays(monday, day - 1), "range", match[0]);
    consumed.push([match.index!, match.index! + match[0].length]);
  }

  // A weekday list ("周一、二、三", "周一和周三") or a compact run ("周一二三").
  // "(?![天])" keeps "本周三天" (three days, not 周三) unresolved instead of
  // guessing; matches inside an already-parsed range are skipped.
  const LIST = new RegExp(`(?<!每)\\s*${PREFIX}\\s*(?:个)?\\s*${WEEK}\\s*([一二三四五六日天](?:\\s*[、,，和及与]\\s*(?:[本这上]?\\s*(?:个)?\\s*(?:周|星期|礼拜)?\\s*)?[一二三四五六日天])*)(?![天])`, "gu");
  for (const match of text.matchAll(LIST)) {
    if (insideRange(match.index!)) continue;
    const monday = mondayFor(match[1]);
    for (const char of match[2]!.replace(/[、,，和及与本这上周星期礼拜]/gu, "")) {
      const day = WEEKDAY[char];
      if (day) add(addDays(monday, day - 1), "weekday", match[0]);
    }
  }
  for (const match of text.matchAll(new RegExp(`(?<!每)\\s*${PREFIX}\\s*(?:个)?\\s*${WEEK}\\s*([一二三四五六日]{2,7})(?![天])`, "gu"))) {
    if (insideRange(match.index!)) continue;
    const monday = mondayFor(match[1]);
    for (const char of match[2]!) {
      const day = WEEKDAY[char];
      if (day) add(addDays(monday, day - 1), "weekday", match[0]);
    }
  }

  // A single weekday: "周一" (this week), "上周五", "下周一".
  for (const match of text.matchAll(new RegExp(`(?<!每)\\s*${PREFIX}\\s*(?:个)?\\s*${WEEK}\\s*([一二三四五六日天])(?![天])`, "gu"))) {
    if (insideRange(match.index!)) continue;
    const day = WEEKDAY[match[2]!];
    if (day) add(addDays(mondayFor(match[1]), day - 1), "weekday", match[0]);
  }

  // "周末" is Saturday + Sunday of the anchored week.
  for (const match of text.matchAll(new RegExp(`(?<!每)${PREFIX}\\s*(?:个)?\\s*(?:周|星期|礼拜)末`, "gu"))) {
    const monday = mondayFor(match[1]);
    add(addDays(monday, 5), "weekday", match[0]);
    add(addDays(monday, 6), "weekday", match[0]);
  }

  // "工作日" is the Monday–Friday of this week; it authorizes repetition of
  // those days, not an unseen date.
  if (/工作日/u.test(text)) {
    const monday = mondayOf(today);
    for (let day = 1; day <= 5; day += 1) add(addDays(monday, day - 1), "weekday", "工作日");
  }

  return [...found.values()].sort((a, b) => a.iso.localeCompare(b.iso));
}

/** ISO dates only, sorted — the shape card contracts store. */
export function resolveIsoDates(text: string, options: DateResolveOptions = {}): string[] {
  return resolveDates(text, options).map(date => date.iso);
}

/** Whether the words name a date at all (used to validate tool arguments). */
export function isResolvableDateExpression(value: string, options: DateResolveOptions = {}): boolean {
  return resolveDates(value, options).length > 0;
}

/** Clock times the words state, as HH:mm. Used to refuse a "what time?" question
 *  when the user already said the time; card grounding still uses the corpus. */
export function resolveClockTimes(text: string): string[] {
  const times = new Set<string>();
  const pad = (value: number): string => String(value).padStart(2, "0");
  for (const match of text.matchAll(/(\d{1,2})\s*[:：]\s*(\d{2})/gu)) {
    const hour = +match[1]!, minute = +match[2]!;
    if (hour <= 23 && minute <= 59) times.add(`${pad(hour)}:${pad(minute)}`);
  }
  for (const match of text.matchAll(/(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|晚间)?\s*(\d{1,2}|[零〇一二两三四五六七八九十]{1,2})\s*点\s*(半|一刻|三刻|(?:\d{1,2}|[零〇一二两三四五六七八九十]{1,2})\s*分?)?/gu)) {
    let hour = cnNumber(match[2]!);
    if (!Number.isFinite(hour) || hour > 24) continue;
    const tail = match[3] ?? "";
    const minute = tail === "半" ? 30 : tail === "一刻" ? 15 : tail === "三刻" ? 45 : tail ? cnNumber(tail.replace(/\s*分?$/u, "")) : 0;
    if (!Number.isFinite(minute) || minute > 59) continue;
    if (/(?:下午|傍晚|晚上|晚间)/u.test(match[1] ?? "") && hour < 12) hour += 12;
    if (hour === 24) hour = 0;
    times.add(`${pad(hour)}:${pad(minute)}`);
  }
  if (/中午/u.test(text)) times.add("12:00");
  return [...times];
}
