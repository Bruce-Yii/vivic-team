import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CardRecord } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { resolveClockTimes, resolveDates, resolveIsoDates } from "../src/intent/dateResolve.js";
import { planFromToolCalls, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { emptyContext, withReceipt } from "./helpers.js";

/**
 * Relative dates and the clarification gate.
 *
 * The production failure this pins: "习惯打卡：每天背单词，本周一到周三做到了"
 * was answered with "打卡要具体到日期：这周哪几天打了卡？". The contract only
 * stored ISO dates, so the model asked instead of converting. Now the host
 * converts weekday/relative words itself — on both creation paths — and refuses
 * a `clarify` that asks for a date/time the sentence already determines.
 */

const NOW = Date.parse("2026-11-03T10:00:00+08:00"); // Tuesday in Shanghai
const MON_WED = ["2026-11-02", "2026-11-03", "2026-11-04"];
const OPTS = { now: NOW, timeZone: "Asia/Shanghai" };

const canvas = (cards: CanvasContext["cards"] = []): CanvasContext => ({ ...emptyContext(cards), timeZone: "Asia/Shanghai" });
const plan = (calls: ToolCall[], ctx: CanvasContext = canvas(), utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, ctx, NOW, utterance, { sayFallback: true });

const cardsOf = (result: ToolCallPlan): CardRecord[] =>
  result.actions.flatMap(action => (action.type === "card.create" ? [action.card] : []));
const propsOf = (card: CardRecord): Record<string, unknown> => card.displayProps as Record<string, unknown>;

describe("dateResolve: the user's own words determine the dates", () => {
  it.each([
    ["本周一到周三", MON_WED],
    ["这周一二三", MON_WED],
    ["周一、二、三", MON_WED],
    ["周一到周三", MON_WED],
    ["周一二三", MON_WED],
    ["周一、周二、周三", MON_WED],
    ["上周五", ["2026-10-30"]],
    ["今天", ["2026-11-03"]],
    ["昨天", ["2026-11-02"]],
    ["明天", ["2026-11-04"]],
    ["最近三天", ["2026-11-01", "2026-11-02", "2026-11-03"]],
    ["10月15日", ["2026-10-15"]],
  ])("resolves %s", (text, expected) => {
    expect(resolveIsoDates(text, OPTS)).toEqual(expected);
  });

  it("keeps ranges inside their own week and Monday as the first day", () => {
    expect(resolveIsoDates("上周一到周三", OPTS)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28"]);
    expect(resolveIsoDates("下周一到周三", OPTS)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11"]);
    const monday = resolveDates("本周一", OPTS)[0]!;
    expect(monday.iso).toBe("2026-11-02");
    expect(monday.weekday).toBe(1);
  });

  it.each(["每天", "每周一", "本周三天", "三天", "没有日期"])("does not invent a date for %s", text => {
    expect(resolveDates(text, OPTS)).toEqual([]);
  });

  it("reads a stated clock time", () => {
    expect(resolveClockTimes("上午九点半开会，下午3点15分")).toEqual(["09:30", "15:15"]);
    expect(resolveClockTimes("明天交材料")).toEqual([]);
  });
});

describe("both habit creation paths accept the user's week words", () => {
  it.each([
    ["habit", ["本周一到周三"]],
    ["habit", ["周一", "周二", "周三"]],
    ["habit", ["周一二三"]],
    ["habit", ["周一、二、三"]],
  ])("create_card(kind=%s) with %j builds this week's check-ins", async (kind, checkins) => {
    const result = await plan([{ name: "create_card", arguments: { kind, fields: { habit: "背单词", checkins } } }], canvas(),
      "习惯打卡：每天背单词，本周一到周三做到了");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const [card] = cardsOf(result);
    expect(card?.type).toBe("HabitHeatmapCard");
    expect(propsOf(card!).checkins).toEqual(MON_WED);
  });

  it.each([
    [["本周一到周三"], MON_WED],
    [["周一", "周二"], ["2026-11-02", "2026-11-03"]],
    [["周一二三"], MON_WED],
    [["周一、二、三"], MON_WED],
  ])("create_scene_card(habit_tracking) with %j builds the same card", async (checkins, expected) => {
    const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词", checkins },
    } } }], canvas(), "打卡记录：每天背单词，本周一到周三做到了");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const [card] = cardsOf(result);
    expect(card?.type).toBe("HabitHeatmapCard");
    expect(propsOf(card!).checkins).toEqual(expected);
  });

  it("derives 最近三天 and 昨天 from the sentence", async () => {
    const recent = await plan([{ name: "create_card", arguments: { kind: "habit", fields: { habit: "跑步", checkins: ["最近三天"] } } }],
      canvas(), "最近三天都跑步了，记一下");
    expect(recent.kind, recent.issues.join(" | ")).toBe("envelope");
    expect(propsOf(cardsOf(recent)[0]!).checkins).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);

    const yesterday = await plan([{ name: "create_card", arguments: { kind: "habit", fields: { habit: "跑步", checkins: ["昨天"] } } }],
      canvas(), "昨天跑步打卡了");
    expect(yesterday.kind, yesterday.issues.join(" | ")).toBe("envelope");
    expect(propsOf(cardsOf(yesterday)[0]!).checkins).toEqual(["2026-11-02"]);
  });

  it("derives arithmetic offsets (N 天后 / 还有 N 天 / 再过 N 周 / 月底) from the sentence", () => {
    expect(resolveIsoDates("3 天后提醒我", OPTS)).toEqual(["2026-11-06"]);
    expect(resolveIsoDates("还有 25 天就考试了", OPTS)).toEqual(["2026-11-28"]);
    expect(resolveIsoDates("再过两周复查", OPTS)).toEqual(["2026-11-17"]);
    expect(resolveIsoDates("月底交房租", OPTS)).toEqual(["2026-11-30"]);
    // "最近三天" is a window, not an offset — it must not also become +3 days.
    expect(resolveIsoDates("最近三天都跑步了", OPTS)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("also converts dates for weekly_schedule, monthly_calendar and historical_timeline", async () => {
    const weekly = await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "weekly_schedule", data: {
      title: "下周安排", events: [{ date: "下周一", title: "开会" }],
    } } } }], canvas(), "下周一开会");
    expect(weekly.kind, weekly.issues.join(" | ")).toBe("envelope");
    expect(propsOf(cardsOf(weekly)[0]!).events).toMatchObject([{ day: 1 }]);
    expect(propsOf(cardsOf(weekly)[0]!).weekStart).toBe("2026-11-09");

    const calendar = await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "monthly_calendar", data: {
      title: "这个月", events: [{ date: "10月15日", title: "体检" }],
    } } } }], canvas(), "10月15日体检");
    expect(calendar.kind, calendar.issues.join(" | ")).toBe("envelope");
    expect(propsOf(cardsOf(calendar)[0]!).events).toMatchObject([{ date: "2026-10-15" }]);

    const timeline = await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "historical_timeline", data: {
      title: "最近", events: [{ date: "上周五", title: "去旅行" }],
    } } } }], canvas(), "上周五去旅行");
    expect(timeline.kind, timeline.issues.join(" | ")).toBe("envelope");
    expect(propsOf(cardsOf(timeline)[0]!).events).toMatchObject([{ date: "2026-10-30" }]);
  });
});

describe("clarify is refused when the host can derive the answer", () => {
  it("rejects missing=date when the sentence already names the days", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "date", question: "这周哪几天打了卡？" } }],
      canvas(), "习惯打卡：每天背单词，本周一到周三做到了");
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(result.issues.join(" ")).toContain("2026-11-02");
    expect(result.issues.join(" ")).toContain("不要追问日期");
  });

  it("rejects missing=time when the sentence already states the time", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "time", question: "几点？" } }],
      canvas(), "明天九点交材料");
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).toContain("09:00");
  });

  it("rejects missing=target when exactly one canvas card matches", async () => {
    const ctx = canvas([
      { id: "note_shopping", type: "NoteCard", aliases: ["购物便笺"], displayProps: { text: "采购清单" },
        sourceDataSummary: {}, layout: { x: 0, y: 0, width: 320, height: 120 } },
      { id: "note_meeting", type: "NoteCard", aliases: ["会议记录"], displayProps: { text: "周会纪要" },
        sourceDataSummary: {}, layout: { x: 344, y: 0, width: 320, height: 120 } },
    ]);
    const result = await plan([{ name: "clarify", arguments: { missing: "target", question: "你要操作哪张卡？" } }],
      ctx, "把购物便笺固定住");
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).toContain("note_shopping");
  });

  it("still allows a clarify for information that is truly missing", async () => {
    const content = await plan([{ name: "clarify", arguments: { missing: "content", question: "要记什么内容？" } }],
      canvas(), "这个帮我记一下");
    expect(content.kind).toBe("clarify");
    expect(content.message).toBe("要记什么内容？");

    const date = await plan([{ name: "clarify", arguments: { missing: "date", question: "这周哪几天打了卡？" } }],
      canvas(), "习惯打卡：每天背单词");
    expect(date.kind).toBe("clarify");
    expect(date.message).toContain("哪几天");

    const target = await plan([{ name: "clarify", arguments: { missing: "target", question: "你要操作哪张卡？" } }],
      canvas(), "把那张卡固定住");
    expect(target.kind).toBe("clarify");
  });

  it("names the missing item when the model's question does not", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "date", question: "能再说一下吗？" } }],
      canvas(), "这个帮我记一下");
    expect(result.kind).toBe("clarify");
    expect(result.message).toBe("还缺日期：能再说一下吗？");
  });

  it("rejects a clarify without the missing field", async () => {
    const result = await plan([{ name: "clarify", arguments: { question: "是哪一次会议的纪要？" } }], canvas(), "整理会议纪要");
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).toContain("missing");
  });
});

describe("grounding issue text names the field and the value", () => {
  it("says which habit date could not be derived", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词", checkins: ["2026-11-02"] },
    } } }], canvas(), "习惯打卡：每天背单词");
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).toContain("2026-11-02");
    expect(result.issues.join(" ")).toContain("无法从原话推导");
  });

  it("says which date field is missing instead of '不能推测'", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "countdown", data: { title: "生日", targetDate: "2026-12-01" },
    } } }], canvas(), "帮我做个生日倒计时");
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).toContain("targetDate 的日期 2026-12-01");
  });
});

// --------------------------------------------------------------- end to end

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }>; stream?: boolean }

/** OpenAI-compatible `tool_calls`: one scripted reply per model turn. */
const scriptedToolFetch = (replies: ToolReply[]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt([reply]).map((reply, index) => ({ index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) } })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

const setup = (replies: ToolReply[]) => {
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = {
    credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true,
    toolCredential: { apiKey: "TEST-relative-dates-key", models: ["deepseek-flash"], defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() },
  };
  return { deps, generate, fetchImpl, calls };
};

describe("B12: 习惯打卡：每天背单词，本周一到周三做到了", () => {
  const B12 = "习惯打卡：每天背单词，本周一到周三做到了";
  // The user's words are converted against the request's own "now". Pin the
  // clock at NOW (Tuesday 2026-11-03 in Shanghai) so 本周 means the week this
  // file's MON_WED fixture names, instead of whatever day CI runs on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("builds a HabitHeatmapCard end to end without asking", async () => {
    const f = setup([{ name: "clarify", args: { missing: "date", question: "这周哪几天打了卡？" } }]);
    const result = await runIntent({ text: B12, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const cards = result.envelope?.actions.flatMap(action => (action.type === "card.create" ? [action.card] : [])) ?? [];
    expect(cards.map(card => card.type)).toEqual(["HabitHeatmapCard"]);
    expect(cards[0]!.displayProps).toMatchObject({ habit: "背单词", checkins: MON_WED });
    // Deterministic fast path: the model is never asked, so it cannot ask back.
    expect(f.fetchImpl).not.toHaveBeenCalled();
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("turns an unnecessary model clarify into a repair turn, then the card", async () => {
    // Same shape without 本周/这周, so the sentence reaches the tool layer.
    const text = "打卡记录：每天背单词，周一、二、三都做到了";
    const f = setup([
      { name: "clarify", args: { missing: "date", question: "这周哪几天打了卡？" } },
      { name: "create_card", args: { kind: "habit", fields: { habit: "背单词", checkins: ["周一", "周二", "周三"] } } },
    ]);
    const result = await runIntent({ text, canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    const cards = result.envelope?.actions.flatMap(action => (action.type === "card.create" ? [action.card] : [])) ?? [];
    expect(cards.map(card => card.type)).toEqual(["HabitHeatmapCard"]);
    expect(cards[0]!.displayProps).toMatchObject({ habit: "背单词", checkins: MON_WED });
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // The repair prompt carries the derived dates, not a generic "invalid".
    const repair = f.calls[1]!.messages.at(-1)!;
    expect(repair.content).toContain("不要追问日期");
    expect(repair.content).toContain("2026-11-02");
  });

  it("still clarifies when the sentence has no days at all", async () => {
    const f = setup([{ name: "clarify", args: { missing: "date", question: "这次打卡是哪几天？" } }]);
    const result = await runIntent({ text: "每天背单词，帮我记一下打卡", canvasContext: canvas() }, f.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("哪几天");
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
