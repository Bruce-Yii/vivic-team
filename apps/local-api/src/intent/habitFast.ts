import type { ActionEnvelope } from "@vivic/contracts";
import type { CanvasContext } from "../schemas.js";
import { addDays, isoOf, mondayOf, todayIn } from "../scenes/calendar.js";
import { buildSceneActions } from "../scenes/index.js";
import { assembleEnvelope } from "./envelope.js";

/**
 * Fixed-shape habit check-in statements:
 *   习惯打卡：每天背单词，本周一到周三做到了
 *   打卡：跑步，这周一二三完成
 *   习惯：背单词 本周一到周三
 *   每天背单词，本周一到周三都做到了
 *
 * The habit name and every checked weekday are already in the sentence, so the
 * host can build the HabitHeatmapCard without a model turn (and without the
 * model asking "这周哪几天" again). This is a closed grammar, not an intent
 * guess: a missing habit name, a missing weekday span, a question, a negation
 * or a second action all fall through to the model.
 */
export interface HabitFastHit {
  kind: "envelope";
  envelope: ActionEnvelope;
  usedProvider: "rules";
}

const WEEKDAY: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const WEEK_ANCHOR = /(?:本|这)(?:个)?\s*(?:周|星期|礼拜)/u;
const PREFIX = /^\s*(?:习惯打卡|习惯|打卡)\s*[:：]\s*/u;
/** Optional "本周/下周三" prefix inside a range/list continuation. */
const UNIT = "(?:[本这上下])?\\s*(?:周|星期|礼拜)?";

/** A negated, interrogative or multi-action sentence is not a completed record. */
const NEGATED = /(?:不要|不用|不想|不需要|不打算|别再|别(?:打卡|记录|记|做|弄|写|忘)|勿|取消|删除|停止|撤销|没有?打卡|未打卡|没做到|没完成|未完成)/u;
const QUESTION = /[?？]|(?:吗|呢)\s*[。.!！]?\s*$|哪几天|哪几|是否|有没有|什么|怎么|如何|为什么/u;
const MULTI_ACTION = /(?:然后|接着|顺便|同时|并且|以及|之后|还要|再(?:建|加|设|来|帮|记|写|做))/u;
/** A plan for future days is not a record of days that were done. */
const PLAN = /(?:计划|安排|打算|目标)/u;
const FREQUENCY = /(?:每天|每日|天天|每晚|每早|每周)/u;
const COMPLETION = /(?:做到|完成|坚持|打卡)(?:了)?/u;

interface WeekdaySpan {
  /** ISO weekdays, Monday = 1 … Sunday = 7, in the user's stated order. */
  days: number[];
  /** Characters consumed after the 本周/这周 anchor. */
  length: number;
}

function span(days: number[], length: number): WeekdaySpan | null {
  const unique = [...new Set(days)];
  if (unique.length !== days.length || unique.length > 7) return null;
  if (unique.some((day, index) => index > 0 && day < unique[index - 1]!)) return null;
  return { days: unique, length };
}

/** "一到周三" / "一、三" / "一二三" / "一" → the weekdays the user named. */
function parseWeekdaySpan(tail: string): WeekdaySpan | null {
  const range = new RegExp(`^\\s*([一二三四五六日天])\\s*(?:到|至|[-—–~～])\\s*${UNIT}\\s*([一二三四五六日天])`, "u").exec(tail);
  if (range) {
    const from = WEEKDAY[range[1]!]!, to = WEEKDAY[range[2]!]!;
    if (from > to) return null;
    return span(Array.from({ length: to - from + 1 }, (_, offset) => from + offset), range[0].length);
  }
  const list = new RegExp(`^\\s*([一二三四五六日天])((?:\\s*[、,，和及与]\\s*${UNIT}\\s*[一二三四五六日天])+)`, "u").exec(tail);
  if (list) {
    const days = [list[1]!, ...[...list[2]!.matchAll(/[一二三四五六日天]/gu)].map(match => match[0]!)].map(char => WEEKDAY[char]!);
    return span(days, list[0].length);
  }
  // "周一二三": a run of weekdays is a compact list, never a quantity.
  const run = /^\s*([一二三四五六日]{2,7})/u.exec(tail);
  if (run) return span([...run[1]!].map(char => WEEKDAY[char]!), run[0].length);
  const single = /^\s*([一二三四五六日天])/u.exec(tail);
  return single ? { days: [WEEKDAY[single[1]!]!], length: single[0].length } : null;
}

/** The habit itself: content before (or after) the week phrase, minus filler. */
function cleanHabit(raw: string): string {
  const parts = raw.split(/[，,；;。]/u).map(part => part.trim()).filter(Boolean);
  const usable = parts.filter(part => !/^(?:都|也|已|已经)?(?:做到|完成|打卡|坚持)了?$/u.test(part));
  let habit = (usable.at(-1) ?? "").replace(/^[\s:：、]+|[\s:：、]+$/gu, "");
  for (let round = 0; round < 4; round += 1) {
    const next = habit
      .replace(/^(?:我|我们|今天|昨天|昨晚|最近|已经|每天|每日|天天|每晚|每早|每周)\s*/u, "")
      .replace(/^(?:习惯打卡|打卡记录|打卡|习惯)\s*[:：]?\s*/u, "");
    if (next === habit) break;
    habit = next;
  }
  habit = habit.replace(/(?:都|也|均|已经)?\s*(?:做到|完成|打卡|坚持)(?:了)?\s*$/u, "").trim();
  habit = habit.replace(/[\s:：、]+$/u, "").trim();
  if (!habit || habit.length > 30) return "";
  if (!/^[\p{Script=Han}A-Za-z0-9][\p{Script=Han}A-Za-z0-9·\-_ ]*$/u.test(habit)) return "";
  if (/^(?:习惯|打卡|记录|完成|做到|坚持|了|都|也|的|这|本|周)+$/u.test(habit)) return "";
  return habit;
}

export function habitFastPath(text: string, ctx: CanvasContext, now = Date.now()): HabitFastHit | null {
  const input = text.trim();
  if (!input || input.length > 120) return null;
  if (NEGATED.test(input) || QUESTION.test(input) || MULTI_ACTION.test(input) || PLAN.test(input)) return null;

  const prefix = PREFIX.exec(input);
  const anchor = WEEK_ANCHOR.exec(input);
  if (!anchor) return null;
  const daysStart = anchor.index + anchor[0].length;
  const days = parseWeekdaySpan(input.slice(daysStart));
  if (!days) return null;

  // No 打卡/习惯 command means the sentence must read as a record ("每天…",
  // "…都做到了"), never as a bare plan ("背单词，本周一到周三" goes to the model).
  if (!prefix && !FREQUENCY.test(input) && !COMPLETION.test(input)) return null;

  const before = input.slice(prefix ? prefix.index + prefix[0].length : 0, anchor.index);
  let habit = cleanHabit(before);
  // Only an explicit 习惯/打卡 command may name the habit after the days;
  // otherwise "本周一到周三每天背单词" reads as a plan and stays with the model.
  if (!habit && prefix) habit = cleanHabit(input.slice(daysStart + days.length));
  if (!habit) return null;

  const monday = mondayOf(todayIn(ctx.timeZone ?? "Asia/Shanghai", now));
  const checkins = days.days.map(day => isoOf(addDays(monday, day - 1)));
  const built = buildSceneActions([{ scene_id: "habit_tracking", data: { habit, checkins } }], { text: input, ctx, now });
  if (!built.ok) return null;
  const envelope = assembleEnvelope(built.actions, ctx.canvasId, "打卡记录已生成");
  return envelope ? { kind: "envelope", envelope, usedProvider: "rules" } : null;
}
