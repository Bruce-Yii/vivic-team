/** A pending clarification owns the *next* message only while that message is an
 * answer. A user who speaks a new command inside the answer window must not have
 * it swallowed as a (bad) reply: the old question is abandoned and the command
 * runs as an ordinary request. This module is the single, testable decision. */
export type ContinuationKind = "answer" | "new-command";

export interface ContinuationOptions {
  /** Labels of the frozen candidates. An exact label is always an answer, even
   * when the title itself contains a verb ("删除全部卡片"). */
  choices?: readonly string[];
  /** The question the pending clarification asked ("打卡要具体到日期……"). Used
   * only to tell a *new* topic from a genuine answer; absent means unknowable. */
  question?: string;
  /** The user's own words that opened the pending task ("习惯打卡：每天背单词…").
   * A new message that reuses their keywords is a supplement, not a new topic. */
  previousUtterance?: string;
}

const compact = (value: string) => value.replace(/[\s。.!！?？,，、~～"'“”‘’「」『』《》【】()（）]+/gu, "");
const normalized = (value: string) => value.trim().replace(/[\s。.!！?？,，、~～]+$/u, "");

const GREETING = /^(?:你好|您好|嗨|嘿|哈喽|哈啰|hello|hi|vivic)(?:[\s,，]*(?:vivic))?[\s!！。.,，~～]*$/iu;

/** Pure ordinal replies: "1", "2号", "第二张", "第三个". */
const NUMBER = /^(?:[一二两三四五六七八九十]{1,3}|\d{1,3})(?:\s*(?:个|张|条|项|份|位|篇|号))?$/u;
const ORDINAL = /^第\s*(?:[一二两三四五六七八九十]{1,3}|\d{1,3})\s*(?:个|张|条|项|份|位|篇|号)?(?:吧|呢|呀|啊)?$/u;
/** "用第2个", "就选第二个", "帮我选第二张". */
const PICK = /^(?:(?:请你|请|帮我|给我|麻烦你?|麻烦)\s*)?(?:用|使用|选|选择|就要|要|就|换成|改成|锁定)\s*(?:原候选(?:里|中|的)?\s*)?(?:第\s*(?:[一二两三四五六七八九十]{1,3}|\d{1,3})\s*(?:个|张|条|项|份|位|篇|号)?|(?:[一二两三四五六七八九十]{1,3}|\d{1,3})\s*号)(?:吧|呢|呀|啊)?$/u;

/** Whole-utterance affirmative/negative replies. Anything longer is judged by
 * the command grammar below, so "确定，然后删除全部" is not a bare "yes". */
const CONFIRMATION = /^(?:是(?:的|啊)?|对(?:的|啊)?|好(?:的|吧|啊|的嘞|呀)?|行(?:吧|的|啊)?|可以|嗯+|确认|确定|没错|ok(?:ay)?|yes|y|不是|不对|不(?:是|对|用|行|要|必|删)|不|否|没有|没用|不必|不用|no|n|取消|算了(?:吧)?|不选了|不用了|不要了|不要|别了|先不要|知道了)(?:[，,]\s*(?:谢谢|多谢|感谢|不用了|取消|算了|别删了?))?$/iu;

/** Standalone canvas verbs that own the whole utterance. */
const STANDALONE = /^(?:撤销|重做|显示全部|显示所有|全部显示|恢复原视图|恢复视图|整理画布|整理一下画布|自动整理(?:一下)?(?:画布|桌面)?|清理画布|清空画布|取消固定|解除固定)[。！!？?]*$/u;

/** A verb the user utters as a request, never as a selection. */
const VERB = /^(?:提醒|倒计时|计时|定时|删除|删掉|删了|移除|去掉|整理|排列|排序|移动|挪动|挪|向左|向右|向上|向下|往左|往右|往上|往下|暂停|继续|固定|取消固定|解除固定|高亮|聚焦|撤销|重做|显示全部|显示所有|全部显示|恢复原视图|恢复视图|恢复|保存|修改|改成|改为|换成|更新|重命名|重排|清理|清空|关闭|打开|切换|播放|停止|新建|创建|添加|新增|生成|加个|加一个|建个|建一个|做个|做一个|弄个|来个|写个|列个|排一下|记录|记一下|记个)/u;

/** "把/将 … 固定住 / 往右移一点 / 删了" — the classic command shape. */
const BA = /^(?:把|将)\s*[^。！？!?]{0,40}?(?:固定|移动|挪|往|向|朝|删|移除|去掉|整理|排列|排序|暂停|继续|高亮|聚焦|放大|缩小|展开|收起|折叠|撤销|恢复|保存|改|换|更新|重命名|清理|清空|关闭|添加|新增|创建|新建|生成)/u;

/** A creation with a counter: "加个提醒", "建一张待办", "做个照片墙". */
const CREATION = /(?:加|建|做|弄|来|写|列|生成|新建|创建|添加|新增)(?:一|两|三|几|\d+)?[个张条份]/u;

/** Directional card movement without 把: "这张卡往右移一点". */
const MOVE = /(?:往|向|朝)(?:左|右|上|下|里|外)(?:边)?\s*(?:移|挪|拖|放|滑|推)/u;

/** Polite/imperative prefixes that may precede a verb without changing it. */
const POLITE = /^(?:请你|请帮我|请|帮我|给我|麻烦你|麻烦|你)\s*/u;
/** Adverbs that may precede a verb ("自动整理一下画布"). */
const ADVERB = /^(?:自动|直接|顺便|顺手|赶紧|马上|立刻|立即|现在|先|再|重新)\s*/u;

/** Optional request prefix in front of a card noun ("做11月日历", "帮我记一下书籍记录"). */
const CREATE = /^(?:批量|快速)?\s*(?:做|做个|做一个|弄|弄个|弄一个|建|建个|建一个|新建|创建|添加|新增|生成|整理|记录|记一下|记个|写|写个|列|列个|排|安排|收藏|保存)\s*/u;

/** Card/record nouns that always introduce a new card rather than answer an old
 * question. `书籍记录：《原则》…` and `做11月日历：…` were read as habit answers. */
const CARD_NOUN = /^(?:书籍记录|阅读笔记|读书笔记|习惯打卡|打卡记录|习惯记录|运动记录|目标进度|项目计划|网页收藏|照片故事|照片墙|时间线|路线图|金句|文献|通知|日历|月历|新闻|对比|日程|待办|便签|便笺)(?:卡|卡片|记录|清单|列表|表)?/u;

/** Date or book-title markers are structured card payload, not conversational filler. */
const QUOTE_MARK = /[《》〈〉「」『』]/u;
const DATE_MARK = /(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月\s*(?:\d{1,2}|[一二三四五六七八九十]{1,2})?\s*[日号]?|\d{4}\s*[-/.年]\s*\d{1,2}|(?:评分|打分|分数)\s*[:：]?\s*\d/u;
const EXTRA_DIGIT = /\d+(?:\.\d+)?/u;

/** Supplements to the pending question keep their answer path: they open with a
 * filler ("三条：", "补充：", "分别是…") or are a bare list of short items. */
const SUPPLEMENT_LEAD = /^(?:补充|说明|另外|还有|以及|其中|就是|即|例如|比如|如下|要点|内容|标题|摘要|分别是|分别为|分为|共有|一共|三点|两条|三条|四点|五点|首先|其次|最后|第一|第二|第三|第[一二三四五六七八九十]|\d{1,2}\s*[）).、])/u;

function looksLikeCommand(value: string): boolean {
  if (STANDALONE.test(value)) return true;
  let body = value;
  for (let depth = 0; depth < 4; depth++) {
    if (!body) return true;
    if (VERB.test(body) || BA.test(body)) return true;
    const next = body.replace(POLITE, "").replace(ADVERB, "");
    if (next === body) break;
    body = next;
  }
  if (VERB.test(body) || BA.test(body)) return true;
  return CREATION.test(value) || MOVE.test(value);
}

/** True when the text is exactly one of the frozen candidate labels. */
export function matchesChoice(text: string, choices: readonly string[] | undefined): boolean {
  if (!choices?.length) return false;
  const value = compact(text);
  return Boolean(value) && choices.some(choice => {
    const label = compact(choice);
    return Boolean(label) && label === value;
  });
}

const keywordOnly = (value: string) => value.replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, "");
function bigrams(value: string): string[] {
  const chars = Array.from(keywordOnly(value)), grams: string[] = [];
  for (let index = 0; index + 1 < chars.length; index++) grams.push(`${chars[index]}${chars[index + 1]}`);
  return grams;
}

/** Does the new text reuse any word from the pending question/opening turn? */
function sharesKeyword(value: string, previous: string | undefined): boolean {
  if (!previous) return false;
  const right = new Set(bigrams(previous));
  return bigrams(value).some(gram => right.has(gram));
}

function previousCorpus(options: ContinuationOptions): string | undefined {
  const corpus = [options.previousUtterance, options.question].filter((part): part is string => Boolean(part?.trim())).join("\n");
  return corpus || undefined;
}

/** Strip politeness/creation prefixes and a leading "11月" so the card noun is visible. */
function leadingCardNoun(value: string): { noun: string; rest: string } | undefined {
  let body = value;
  for (let depth = 0; depth < 4; depth++) {
    const next = body.replace(POLITE, "").replace(ADVERB, "").replace(CREATE, "");
    if (next === body) break;
    body = next;
  }
  body = body.replace(/^(?:\d{1,2}|[一二三四五六七八九十]{1,2})\s*月\s*/u, "");
  const match = CARD_NOUN.exec(body);
  return match ? { noun: match[0], rest: body.slice(match[0].length) } : undefined;
}

/** How much card-shaped content follows the noun. A lone "待办：买牛奶" is still
 * a plausible answer to "便笺写什么？"; two points of structure make it a request. */
function cardPayloadScore(text: string): number {
  let score = 0;
  if (QUOTE_MARK.test(text)) score += 2;
  if (DATE_MARK.test(text)) score += 2;
  if (/[、；;]/u.test(text) || (text.match(/[，,]/gu)?.length ?? 0) >= 2) score += 1;
  if (EXTRA_DIGIT.test(text)) score += 1;
  if (/[:：]/u.test(text)) score += 1;
  // "日历：11月5日开会" carries a real payload after the colon; "待办：买牛奶"
  // is the same length as a one-word answer and stays ambiguous.
  const payload = text.split(/[:：]/u)[1]?.trim() ?? "";
  if (Array.from(payload).length >= 5) score += 1;
  const length = Array.from(text).length;
  if (length >= 12) score += 1;
  if (length >= 20) score += 1;
  return score;
}

/** A long message is only a new topic when it at least asks for something: a bare
 * description or an arbitrary long answer must keep the answer path. */
const REQUEST_CUE = /(?:帮我|帮忙|请|麻烦|我要|我想|需要|做|建|创建|新建|生成|安排|计划|准备|整理|记录|记一下|写|列|查|搜索|找|预订|预约|订|买|参加|开会|体检|出差|旅行|读书|学习|背单词|打卡|跑步|健身|复盘|汇报|评审|提醒|添加|新增|保存|收藏|更新|修改|删除|对比|分析|总结|统计|翻译|导出|上传|下载|设计|画|拍|路线|方案|目标|进度)/u;

/** A list of short comma-separated items ("海边日落，山顶云海，…") is a B19-style
 * supplement, never a new topic on its own. */
function isItemList(text: string): boolean {
  if (/[。！？!?]/u.test(text)) return false;
  const items = text.split(/[，,、；;]/u).map(item => item.trim()).filter(Boolean);
  return items.length >= 3 && items.every(item => Array.from(item).length <= 12);
}

/** A date/time answer ("11月5日和11月12日", "周一3，周二5，周三4") carries no new
 * topic: it only names when the pending question asked about. */
const TEMPORAL_ANSWER = /[\d一二两三四五六七八九十百千万半上下午晚早中凌晨周末星期礼拜年月日号点分秒天今明后前本这那第每和与及到至、，,\s~～\-—/]/gu;

function isTemporalAnswer(text: string): boolean {
  return Array.from(text.replace(TEMPORAL_ANSWER, "")).length <= 1;
}

/** "Book record《…》…" starts a card the old question never asked about. */
function isLeadingCardRequest(text: string, previous: string | undefined): boolean {
  const lead = leadingCardNoun(text);
  if (!lead) return false;
  if (sharesKeyword(text, previous)) return false;
  const bare = !/[^\s。.!！?？,，、~～:：]/u.test(lead.rest);
  return bare || cardPayloadScore(text) >= 2;
}

/** New numbers/dates/book titles that the pending question never mentioned. */
function isFreshStructuredRequest(text: string, previous: string | undefined): boolean {
  if (!previous || Array.from(text).length < 12) return false;
  if (SUPPLEMENT_LEAD.test(text) || isItemList(text) || isTemporalAnswer(text)) return false;
  let score = 0;
  if (QUOTE_MARK.test(text)) score += 2;
  if (DATE_MARK.test(text)) score += 2;
  if (/\d+\.\d+|(?:评分|打分|分数)\s*[:：]?\s*\d/u.test(text)) score += 1;
  return score >= 2 && !sharesKeyword(text, previous);
}

/** A long sentence with nothing in common with the pending question is a new
 * topic; a long supplement ("三条：…", a four-item description) is not. */
function isLongUnrelatedRequest(text: string, previous: string | undefined): boolean {
  if (!previous || Array.from(text).length < 24) return false;
  if (SUPPLEMENT_LEAD.test(text) || isItemList(text) || isTemporalAnswer(text)) return false;
  if (!REQUEST_CUE.test(text)) return false;
  return !sharesKeyword(text, previous);
}

/** "answer" keeps the existing clarification path; "new-command" abandons it. */
export function classifyContinuation(text: string, options: ContinuationOptions = {}): ContinuationKind {
  const value = normalized(text);
  if (!value) return "answer";
  if (matchesChoice(value, options.choices)) return "answer";
  // A greeting is never an answer to a pending question; it is a new turn.
  if (GREETING.test(value)) return "new-command";
  if (NUMBER.test(value) || ORDINAL.test(value) || PICK.test(value)) return "answer";
  if (CONFIRMATION.test(value)) return "answer";
  const previous = previousCorpus(options);
  if (isLeadingCardRequest(value, previous)) return "new-command";
  if (isFreshStructuredRequest(value, previous)) return "new-command";
  if (isLongUnrelatedRequest(value, previous)) return "new-command";
  if (looksLikeCommand(value)) return "new-command";
  return "answer";
}

export function isNewCommand(text: string, options: ContinuationOptions = {}): boolean {
  return classifyContinuation(text, options) === "new-command";
}
