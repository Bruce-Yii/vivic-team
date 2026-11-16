/**
 * Clause coverage for compound sentences.
 *
 * `decision/split.ts` answers "is this one card or several requests?" for the
 * deterministic rules and for the conditional guard. This module answers a
 * different question at the tool layer: *of the clauses the user actually
 * asked for, which ones produced nothing?*
 *
 * sc-52 ("帮我记个便签明天交周报，然后设一个倒计时") built the note and silently
 * dropped the countdown, because its duration was missing: the model answered
 * the half it could build and never mentioned the other half. A missing
 * argument must come back as a validation issue (the model may then clarify the
 * whole sentence), never as a quiet omission.
 *
 * The check is deliberately conservative — it only names a clause when the
 * clause carries a *recognisable request* (a canvas operation verb, a lookup
 * verb, a card noun, or a creation verb) and the batch shows no evidence for
 * it. Nothing here writes an explanation, fills an argument or edits a clause:
 * the caller turns a drop into an issue for the existing one-shot repair turn.
 *
 * Out of scope on purpose:
 *  - conditional clauses ("如果/要是…就…") stay with `droppedConditionalClause`
 *    in toolCalls.ts, which owns the honest "that capability does not exist";
 *  - greetings, hedges and bare modifiers carry no request and are ignored;
 *  - a clause whose words were recorded verbatim in a built card was not
 *    dropped (the note *is* the result).
 */

/** What one clause asked for. Each value maps to evidence in `PlanOutcomes`. */
export type ClauseDemand =
  | "countdown" | "todo" | "note" | "schedule" | "chart" | "notification" | "habit"
  | "reminder" | "lookup" | "op" | "record";

/** What the batch actually produced, in facts the caller can read without
 *  re-implementing the mapper: card types, action types, lookup/host operation,
 *  and the created cards' visible text (for the "recorded verbatim" escape). */
export interface PlanOutcomes {
  /** `CardRecord.type` of every card the batch created. */
  cardTypes: readonly string[];
  /** `Action.type` of every action in the batch (e.g. "card.update"). */
  actionTypes: readonly string[];
  /** A verified provider lookup rides with this batch. */
  hasLookup: boolean;
  /** The batch carries a host operation (move/pin/undo/arrange/…). */
  hasHostOperation: boolean;
  /** Concatenated display props of the created cards, whitespace already
   *  stripped: a clause found here was recorded, not dropped. */
  recorded: string;
}

/** A conditional sentence is one unit and belongs to the conditional guard. */
const CONDITIONAL = /如果|要是|假如|倘若|若是|万一/u;
/** Sentence ends always separate clauses. */
const HARD_BREAK = /[。！？!?；;\n]+/u;
/** Sequencing words start a new request even without a comma ("记个便签然后
 *  设个倒计时"), exactly like `split.ts`. Content use of the same words is
 *  harmless: a clause with no request carries no demand. */
const CONNECTIVE = /(?:然后|接着|随后|顺便|另外|同时|并且)(?:[，,]|再)?\s*/u;
/** "，再" is a sequencing comma; a bare 再 is kept inside its clause
 *  ("再快一点", "显示全部再整理") so it is never torn out of context. */
const COMMA_ZAI = /[，,]\s*再\s*/u;
const LEAD_TRIM = /^[，,；;。！!\s]+/u;
const TAIL_TRIM = /[，,；;。！!\s]+$/u;
/** Politeness and lead-ins never change which request a clause carries. */
const POLITE = /^(?:(?:请|帮我|给我|麻烦|劳驾|那|就|先|再|然后|接着|随后|顺便|另外|同时|并且)\s*)+/u;

/** A clause that starts with these verbs operates the canvas instead of
 *  creating a card ("打开购物清单" is not a new list). */
const OP_LEAD = /^(?:打开|关闭|聚焦|高亮|显示|隐藏|放大|缩小|适应|固定|取消固定|移动|挪|传送到|传送|切换到|删除|删掉|移除|清空|撤销|重做|整理|排版|恢复|标成|标为|改成|改为)/u;
/** The same operations, when they follow a 把/将 object ("把购物清单固定住",
 *  "把买牛奶标成完成", "把这张卡放回用户页"). Only checked for that object form:
 *  删除 inside card content ("待办：删除旧照片") is content, not a request. */
const OP_ANY = /固定|取消固定|置顶|移动|挪到|挪|移到|搬到|放到|放回|摆到|传到|传送到|传送|删除|删掉|移除|清空|聚焦|高亮|放大|缩小|隐藏|显示全部|全部显示|看全部|适应画布|恢复(?:原)?视图|退出聚焦|自动排版|标成|标为|改成|改为|重命名|展开|收起/u;
/** A 把/将 clause with an operation verb acts on the object it names
 *  ("把购物清单放回用户页"): that noun is the target, not a new card. */
const OBJECT_CLAUSE = /^(?:把|将)/u;
/** Lookup clauses: live facts and canvas reads are satisfied by one lookup.
 *  Only the clause's lead counts — "记个便签：查一下快递单号" is note content. */
const QUERY = /查(?!看)|搜|检索|天气|气温|预报|冷不冷|热不热|带伞|穿外套|温度|新闻|最新消息/u;
const LEAD_WINDOW = 12;
/** A record request names no card type: "记一下明天的会议安排" is a note, not a
 *  schedule, because the user asked to record. */
const RECORD_LEAD = /^(?:记|写|记录|记下|整理成|做成|转成)/u;
/** Card nouns, most specific first. */
const CARD_WORD: ReadonlyArray<readonly [ClauseDemand, RegExp]> = [
  ["countdown", /倒计时|计时器|计时|闹钟|番茄钟|定时/u],
  ["todo", /待办|清单|todo/iu],
  ["note", /便签|便笺|笔记|note/iu],
  ["schedule", /日程|会议|约会|安排到|定在|课表|行程/u],
  ["chart", /图表|柱状图|折线图|饼图/u],
  ["notification", /通知/u],
  ["habit", /打卡|习惯/u],
  ["reminder", /提醒/u],
];
/** A card noun is a request only when something creates it: a verb right before
 *  it ("设一个倒计时", "加个待办", "新建一个任务清单") or the "noun：…" form
 *  ("待办：买牛奶"). Merely mentioning a card ("我不记得是哪张清单",
 *  "参加明天的会议") is a target or a statement, not a demand. 记/写 are
 *  deliberately absent here: they ask to record (any card), and they also occur
 *  in ordinary prose ("不记得"). */
const NOUN_AFTER_STRONG = /(?:新建|创建|建立|添加|新增|设|设置|定|生成|安排|列|保存|开)(?:一?[个张条份])?(?:新的)?(?:[^，,。！？；\s]{0,4})$/u;
const NOUN_AFTER_WEAK = /(?:加入|加|做|来|搞|弄)(?:一?[个张条份])(?:新的)?(?:[^，,。！？；\s]{0,2})$/u;
/** A creation verb with no card noun still asks for *something* ("加个提醒"). */
const CREATE_LEAD = /^(?:记|写|建|新建|创建|添加|新增|加|设|设置|定|生成|做|来|搞|弄|安排|列|保存)/u;

/** The card a clause asks to create, if any. */
function nounDemandOf(text: string): ClauseDemand | undefined {
  for (const [demand, pattern] of CARD_WORD) {
    const match = pattern.exec(text);
    if (!match || match.index === undefined) continue;
    const before = text.slice(Math.max(0, match.index - 12), match.index);
    if (NOUN_AFTER_STRONG.test(before) || NOUN_AFTER_WEAK.test(before)) return demand;
    // "待办：买牛奶" / "倒计时 10 分钟" opens with the noun it is about.
    if (/^[^，,。！？；]{0,6}?[:：]/u.test(text.slice(match.index))) return demand;
  }
  return undefined;
}

/** Split a sentence into the clauses a user asked for. Conditional and negative
 *  sentences stay whole (they are one request, handled by their own guard). */
export function splitActionClauses(text: string): string[] {
  const original = text.trim();
  if (!original || CONDITIONAL.test(original)) return original ? [original] : [];
  const clauses = original.split(HARD_BREAK)
    .flatMap(part => part.split(COMMA_ZAI))
    .flatMap(part => part.split(CONNECTIVE))
    .map(part => part.replace(LEAD_TRIM, "").replace(TAIL_TRIM, "").trim())
    .filter(part => part.length >= 2);
  return clauses.length ? clauses : [original];
}

/** The request one clause carries, or `undefined` when it asks for nothing
 *  recognisable (greeting, hedge, modifier, pure content). */
export function clauseDemandOf(clause: string): ClauseDemand | undefined {
  const text = clause.replace(LEAD_TRIM, "").replace(POLITE, "").trim();
  if (!text) return undefined;
  if (OP_LEAD.test(text)) return "op";
  if (OBJECT_CLAUSE.test(text) && OP_ANY.test(text)) return "op";
  if (QUERY.test(text.slice(0, LEAD_WINDOW))) return "lookup";
  if (RECORD_LEAD.test(text)) return "record";
  if (/^(?:提醒|设一?个提醒|加个提醒)/u.test(text)) return "reminder";
  const noun = nounDemandOf(text);
  if (noun) return noun;
  if (CREATE_LEAD.test(text)) return "record";
  return undefined;
}

/** The clause without its lead-in, for the "recorded verbatim" test: a note
 *  that says exactly what the clause said already answered it. */
const clauseNeedles = (clause: string): string[] => {
  const full = clause.replace(/\s+/gu, "");
  const core = clause.replace(POLITE, "")
    .replace(/^(?:记|写|记录|记下|建|新建|创建|添加|新增|加|设|设置|定|生成|做|来|搞|弄|安排|列|保存)\s*(?:一?[个张条份])?\s*(?:便签|便笺|笔记|待办|清单|倒计时|计时器|日程|提醒|通知|卡片)?\s*[:：]?\s*/u, "")
    .replace(/\s+/gu, "");
  return core.length >= 2 && core !== full ? [full, core] : [full];
};

const REMINDER_CARDS: ReadonlySet<string> = new Set(["CountdownCard", "WeeklyScheduleCard", "NotificationCard"]);
const LOOKUP_CARDS: ReadonlySet<string> = new Set(["SearchResultCard", "WeatherCard"]);
const VIEW_ACTIONS: ReadonlySet<string> = new Set(["card.focus", "card.highlight", "canvas.fit", "canvas.restore"]);
const OP_ACTIONS: ReadonlySet<string> = new Set([...VIEW_ACTIONS, "card.update", "card.delete", "card.pin", "card.move", "card.surface"]);

const EVIDENCE: Readonly<Record<ClauseDemand, (outcomes: PlanOutcomes) => boolean>> = {
  countdown: outcomes => outcomes.cardTypes.includes("CountdownCard"),
  todo: outcomes => outcomes.cardTypes.includes("TodoCard") || outcomes.actionTypes.includes("card.update"),
  note: outcomes => outcomes.cardTypes.includes("NoteCard"),
  schedule: outcomes => outcomes.cardTypes.includes("WeeklyScheduleCard"),
  chart: outcomes => outcomes.cardTypes.includes("ChartCard"),
  notification: outcomes => outcomes.cardTypes.includes("NotificationCard"),
  habit: outcomes => outcomes.cardTypes.includes("HabitHeatmapCard"),
  // A reminder is one of the reminder-shaped cards; the model picks which.
  reminder: outcomes => outcomes.cardTypes.some(type => REMINDER_CARDS.has(type)),
  lookup: outcomes => outcomes.hasLookup || outcomes.cardTypes.some(type => LOOKUP_CARDS.has(type)),
  op: outcomes => outcomes.hasHostOperation || outcomes.actionTypes.some(type => OP_ACTIONS.has(type)),
  // A bare creation/record verb is satisfied by any real result: the card type
  // is the model's choice, and the host has no basis to prefer one.
  record: outcomes => outcomes.cardTypes.length > 0 || outcomes.hasLookup || outcomes.hasHostOperation,
};

/**
 * Clauses that asked for something and got neither a result nor a verbatim
 * record of themselves. Returns at most three, in clause order.
 */
export function droppedClauses(text: string, outcomes: PlanOutcomes): string[] {
  // A conditional sentence is one request and is owned by `droppedConditionalClause`
  // (toolCalls.ts): it names "the host cannot do 满足条件才执行", which is a different
  // verdict from "this clause produced nothing".
  if (CONDITIONAL.test(text)) return [];
  const missing: string[] = [];
  for (const clause of splitActionClauses(text)) {
    const demand = clauseDemandOf(clause);
    if (!demand) continue;
    if (EVIDENCE[demand](outcomes)) continue;
    if (clauseNeedles(clause).some(needle => outcomes.recorded.includes(needle))) continue;
    missing.push(clause);
    if (missing.length === 3) break;
  }
  return missing;
}
