import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { handleDataIntent } from "../src/data/index.js";
import { createIntentLogSink, intentPathOf } from "../src/observability/intentLog.js";
import type { StepfunResult } from "../src/stepfun.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * The accept60 failures that were decided *before* the model got a chance, or in
 * a tool surface that could not express the answer.
 *
 *  - sc-16 / sc-18: a rules gate / a data-adapter clarification answered a
 *    sentence the model/tool layer now owns;
 *  - sc-30 / sc-33 / sc-45 / sc-56: the tool surface could not append an entry,
 *    highlight an entry, answer with a card, or refuse to guess between two
 *    cards. The mapper tests pin the shapes; these tests pin the pipeline
 *    contract (one envelope, the same cards and the same honest questions);
 *  - task E: a planner -> lookup -> data-adapter turn must be counted as
 *    `planner`, not as `rules-fast` (sc-21).
 */

interface ToolReply { name: string; args: Record<string, unknown> }

const card = (id: string, title: string, type: string, x: number,
  items?: Array<{ id: string; text: string; done: boolean }>): CanvasContext["cards"][number] => ({
  id, type, aliases: [title],
  displayProps: items ? { title, items } : type === "CountdownCard" ? { totalSeconds: 300 } : { text: title },
  sourceDataSummary: type === "CountdownCard" ? { remainingSeconds: 300 } : {},
  layout: { x, y: 0, width: 288, height: 160 },
});

/** The acceptance canvas: two todo lists, one note, one timer. */
const canvas = (): CanvasContext => ({
  canvasId: "TEST-tool-surface-accept60",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  timeZone: "Asia/Shanghai",
  cards: [
    card("todo_week", "本周待办", "TodoCard", 0, [
      { id: "item-1", text: "交周报", done: false },
      { id: "item-2", text: "买牛奶", done: false },
      { id: "item-3", text: "预约牙医", done: true },
    ]),
    card("todo_shop", "购物清单", "TodoCard", 400, [
      { id: "item-1", text: "鸡蛋", done: false },
      { id: "item-2", text: "洗衣液", done: false },
    ]),
    card("note_meeting", "会议记录", "NoteCard", 0),
    card("cd_water", "喝水提醒", "CountdownCard", 700),
  ],
});

const credential = { apiKey: "TEST-tool-surface-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

/** OpenAI-compatible `tool_calls`: one scripted batch per model turn. */
const scriptedToolFetch = (replies: ToolReply[][]) => {
  const calls: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ role: string; content: string }> };
    calls.push(body);
    const batch = replies[Math.min(calls.length - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(batch).map((reply, index) => ({
      index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

function setup(replies: ToolReply[][], overrides: Partial<PipelineDeps> = {}) {
  const credentials = new CredentialStore();
  const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { reply: "planner answered" } }));
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, generate, fetchImpl, calls };
}

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];
const actions = (result: IntentResult) => result.envelope?.actions ?? [];

describe("accept60: the rules layer no longer answers a plan or a table before the model", () => {
  it("sc-16 builds next week's fitness plan instead of asking 哪几天 (deterministic, no gate)", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "weekly_plan", fields: { topic: "健身计划" } } }]]);
    const result = await runIntent({ text: "帮我做一个下周的健身计划", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["WeeklyScheduleCard"]);
    // The removed gate answered in 78-94 ms with a clarification; neither the
    // question nor a model turn may be the outcome now.
    expect(result.message ?? "").not.toContain("哪几天");
    expect(result.toolCalls).toBeUndefined();
    expect(result.usedProvider).toBe("rules");
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("reaches the tool layer for a plan sentence the deterministic builder does not own", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "weekly_plan", fields: { topic: "读书计划" } } }]]);
    const result = await runIntent({ text: "帮我做一个下周的读书计划", canvasContext: canvas() }, f.deps);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(cards(result)).toEqual(["WeeklyScheduleCard"]);
  });

  it("sc-16 builds the plan in the tool path too (the 2240b shape: a canvas card mentions a weekday)", async () => {
    // The deterministic builder declines this canvas (a card body mentions 周三),
    // so the sentence is the tool layer's — exactly what happened in the live run,
    // where `create_weekly_plan` then asked 哪几天 instead of building.
    const context: CanvasContext = { ...canvas(), timeZone: "Asia/Shanghai", focusHistory: ["note_meeting"],
      cards: [card("note_meeting", "会议记录", "NoteCard", 300)].map(item => ({ ...item,
        displayProps: { title: "会议记录", text: "周三和设计讨论首页改版" } })) };
    const f = setup([[{ name: "create_card", args: { kind: "weekly_plan", fields: { topic: "健身计划" } } }]]);
    const result = await runIntent({ text: "帮我做一个下周的健身计划", canvasContext: context }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["WeeklyScheduleCard"]);
    expect(result.message ?? "").not.toContain("哪几天");
    expect(result.envelope?.spokenText ?? "").not.toContain("哪几天");
  });

  it("sc-18 lets the model build the comparison after the data adapter cannot parse the table", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "scene", fields: { scene_id: "option_comparison", data: {
      title: "iPhone 和华为对比",
      options: [{ name: "iPhone" }, { name: "华为" }],
      criteria: [{ name: "屏幕", values: ["6.1寸", "6.7寸"], unit: "寸" }],
    } } } }]]);
    const data = vi.fn(async () => ({ kind: "clarify" as const,
      message: "表格需要你提供数据。请回复一组「名称 数值」，如「周一3，周二5，周三4」；也可完整输入「用表格记录：周一3，周二5，周三4」。" }));
    const result = await runIntent({ text: "做一个表格对比 iPhone 和华为的参数，iPhone 6.1 寸，华为 6.7 寸", canvasContext: canvas() },
      { ...f.deps, data: { handleDataIntent: data } });
    // With the tool surface on, the adapter is no longer consulted before the
    // model: a data adapter is a capability the model chooses, not a keyword
    // pipeline. It may still refuse later, and that refusal is never final.
    expect(data).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.toolCalls).toBe(true);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["ComparisonCard"]);
    expect(result.message ?? "").not.toContain("表格需要你提供数据");
  });
});

describe("accept60: the tool surface can now express the sentence", () => {
  it("sc-45 returns the answer card and the todo in one envelope", async () => {
    const f = setup([[
      { name: "create_card", args: { kind: "answer", fields: { title: "特斯拉", text: "特斯拉是一家做电动车和储能的公司。" } } },
      { name: "create_card", args: { kind: "todo", fields: { items: ["研究特斯拉财报"] } } },
    ]]);
    const result = await runIntent({ text: "介绍一下特斯拉，顺便加个待办研究它的财报", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["NewsCard", "TodoCard"]);
    // One camera move for two new cards, never a per-card focus.
    expect(actions(result).filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(actions(result).filter(action => action.type === "card.focus")).toHaveLength(0);
  });

  it("sc-13 turns a knowledge question into a NewsCard instead of a subtitle only", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "answer", fields: { title: "宁德时代", text: "宁德时代是一家做动力电池的公司。",
      points: ["动力电池出货量第一"] } } }]]);
    const result = await runIntent({ text: "帮我讲讲宁德时代是做什么的", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["NewsCard"]);
    const created = actions(result).find(action => action.type === "card.create");
    expect(created && created.type === "card.create" ? created.card.displayProps : {}).toMatchObject({
      headline: "宁德时代", summary: "宁德时代是一家做动力电池的公司。", summaryBy: "ai",
    });
  });

  it("sc-33 appends 酱油 to 购物清单 and keeps both original entries", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "todo", fields: { card_id: "todo_shop", items: ["酱油"] } } }]]);
    const result = await runIntent({ text: "购物清单里加上酱油", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual([]);
    const update = actions(result).find(action => action.type === "card.update");
    expect(update).toMatchObject({ targetId: "todo_shop" });
    expect((update as Extract<typeof update, { type: "card.update" }>).displayProps).toEqual({ items: [
      { id: "item-1", text: "鸡蛋", done: false },
      { id: "item-2", text: "洗衣液", done: false },
      { id: "item-3", text: "酱油", done: false },
    ] });
  });

  it("sc-30 keeps the model's card and hands that card's entries back", async () => {
    // The model picked 购物清单 while the user named 买牛奶 (an entry of 本周待办).
    // The host no longer moves the highlight: it returns 购物清单's own entries as
    // the issue (with item ids), and the repair turn picks the card itself.
    const f = setup([
      [{ name: "view", args: { mode: "highlight",  card_id: "todo_shop" } }],
      [{ name: "view", args: { mode: "highlight",  card_id: "todo_week", item_id: "item-2" } }],
    ]);
    const result = await runIntent({ text: "高亮一下买牛奶那条", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(actions(result)).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // The rejected batch named the entries the model could choose from.
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("鸡蛋(item-1)");
  });

  it("sc-30 honours the model's own card when it already picked the right one", async () => {
    const f = setup([[{ name: "view", args: { mode: "highlight",  card_id: "todo_week", item_id: "item-2" } }]]);
    const result = await runIntent({ text: "高亮一下买牛奶那条", canvasContext: canvas() }, f.deps);
    expect(actions(result)).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sc-56 refuses a guess between two 待办 and hands the candidates back", async () => {
    // 「聚焦待办」 can only mean one of the two lists and proves neither. The model
    // picked todo_week; the host refuses that guess once (ambiguous-target) and
    // the repair turn repeats it, so the turn ends with the host's numbered
    // fallback question naming both cards — never a coin-flip focus.
    const f = setup([[{ name: "view", args: { mode: "focus",  card_id: "todo_week" } }]]);
    const result = await runIntent({ text: "聚焦待办", canvasContext: canvas() }, f.deps);
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.envelope).toBeUndefined();
    expect(result.kind, JSON.stringify(result)).toBe("clarify");
    expect(result.message).toContain("本周待办");
    expect(result.message).toContain("购物清单");
    expect(result.message).not.toContain("todo_week");
    // The repair turn was told the issue and the candidates, not "换一种说法".
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("ambiguous-target");
  });

  it("sc-31 asks 哪张卡的第几条 when 第一条 cannot land on the focused card", async () => {
    // 「高亮第一条」 with a text-only note focused proves no card or entry: a bare
    // count is only evidence when the named card really holds that entry. The
    // host must ask with the cards that do have entries instead of highlighting
    // whatever the model guessed.
    const focused: CanvasContext = { ...canvas(), focusHistory: ["note_meeting"] };
    const f = setup([[{ name: "view", args: { mode: "highlight", card_id: "note_meeting" } }]]);
    const result = await runIntent({ text: "高亮第一条", canvasContext: focused }, f.deps);
    expect(result.envelope).toBeUndefined();
    expect(result.kind, JSON.stringify(result)).toBe("clarify");
    expect(result.message).toContain("本周待办");
    expect(result.message).toContain("购物清单");
  });

  it("sc-59 sends the focused card to the display page through card.surface", async () => {
    // 传到用户页/展示页 had no tool entry at all, so the model could only say it
    // was impossible. `arrange(target, surface)` is the entry; the effect is the
    // contract's existing `card.surface` host operation.
    const focused: CanvasContext = { ...canvas(), focusHistory: ["todo_week"] };
    const f = setup([[{ name: "arrange", args: { target: "todo_week", surface: "display" } }]]);
    const result = await runIntent({ text: "把这张卡传到展示页", canvasContext: focused }, f.deps);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "card.surface", targetId: "todo_week", surface: "display" });
  });

  it("sc-59 asks instead of transferring the wrong list when 待办 names two", async () => {
    const f = setup([[{ name: "arrange", args: { target: "todo_week", surface: "user" } }]]);
    const result = await runIntent({ text: "把待办传到用户页，我要编辑", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("clarify");
    expect(result.hostOperation).toBeUndefined();
    expect(result.message).toContain("本周待办");
    expect(result.message).toContain("购物清单");
  });

  it("sc-25 refuses 打电话 as plain text and creates no card", async () => {
    const f = setup([[{ name: "unsupported", args: { reply: "我没法替你打电话，只能帮你记个提醒。" } }]]);
    const result = await runIntent({ text: "给张三打个电话", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual([]);
    expect(actions(result)).toEqual([{ type: "subtitle.show", text: "我没法替你打电话，只能帮你记个提醒。", durationMs: 12000 }]);
    expect(result.envelope?.spokenText).toBe("我没法替你打电话，只能帮你记个提醒。");
    // Never the old "记下了，给张三打个电话" fake completion.
    expect(result.envelope?.spokenText ?? "").not.toMatch(/记下了|已完成|已拨打/);
  });
});

/**
 * B — tool mutual exclusion: `answer` (stable knowledge) and `chat` (small talk)
 * must never stand in for the verified live chain. sc-19 asked for AI news and
 * got a NewsCard written from memory; sc-21 asked about tomorrow's weather in
 * Nanjing and got "我查不到".
 */
describe("accept60: live facts belong to search/weather, never to answer or chat", () => {
  const evidence = [{
    title: "AI 新闻综述", url: "https://example.com/ai-news", snippet: "本周发布的新模型与算力进展。",
    fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
  }];

  it("sc-19 rejects an answer for a news question and lets the model choose search", async () => {
    const f = setup([
      [{ name: "create_card", args: { kind: "answer", fields: { title: "AI 新闻", text: "我没法联网…" } } }],
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "create_card", args: { kind: "search_results", fields: {} } }],
    ]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "最近有什么 AI 方面的大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    // The model's answer card was refused, the repair turn picked search, and the
    // host ran the same verified provider its own rules use. The result card is
    // the model's publish decision on the follow-up turn, not an auto-card.
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["SearchResultCard"]);
    // The invented "我无法联网" text never reaches the canvas.
    expect(JSON.stringify(result.envelope)).not.toContain("没法联网");
  });

  it("sc-19 never searches behind the model: a repeated answer becomes an honest question", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "answer", fields: { title: "AI 新闻", text: "我没法联网…" } } }]]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "最近有什么 AI 方面的大新闻", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    // There is no keyword floor any more: a live-fact sentence the model cannot
    // ground is rejected twice (initial + repair) and the host says so. It never
    // runs a retrieval the model did not choose, and it never invents an answer.
    expect(webSearch).not.toHaveBeenCalled();
    expect(result.kind, JSON.stringify(result)).toBe("clarify");
    expect(result.source).toBe("host");
    expect(result.interrupt?.reason).toBe("vendor-unavailable");
    expect(JSON.stringify(result)).not.toContain("没法联网");
  });

  it("sc-21 rejects a chat that says 我查不到 and lets the model ask for weather", async () => {
    const f = setup([
      [{ name: "chat", args: {} }],
      [{ name: "weather", args: { city: "南京" } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } }],
    ]);
    const weather = vi.fn(async () => ({
      kind: "weather" as const, tempC: 18, conditionIcon: "cloud" as const,
      location: { id: 1799962, name: "南京", latitude: 32.06, longitude: 118.78, country: "中国",
        country_code: "CN", admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA" },
      observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), weatherCode: 3, isDay: true,
      intervalSeconds: 900, modelGrid: { latitude: 32.06, longitude: 118.78 }, sources: [],
    }));
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, data: { handleDataIntent: (text, context) => handleDataIntent(text, context, undefined, { weather }) } });
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    // The user's own day word is derived when the weather question stands alone,
    // so the adapter is asked for tomorrow even if the model omitted `day`.
    expect(weather).toHaveBeenCalledWith("南京", undefined, 1);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    // The card exists because the model published it on the follow-up turn.
    expect(cards(result)).toEqual(["WeatherCard"]);
    expect(result.envelope?.spokenText ?? "").not.toContain("查不到");
  });

  it("keeps a stable knowledge question on answer (sc-13 is not a live fact)", async () => {
    const f = setup([[{ name: "create_card", args: { kind: "answer", fields: { title: "宁德时代", text: "宁德时代是一家做动力电池的公司。" } } }]]);
    const webSearch = vi.fn(async () => evidence);
    const result = await runIntent({ text: "帮我讲讲宁德时代是做什么的", canvasContext: canvas() },
      { ...f.deps, search: { webSearch } });
    expect(webSearch).not.toHaveBeenCalled();
    expect(cards(result)).toEqual(["NewsCard"]);
  });
});

/**
 * C — the host may resolve a name the user said in another language, and it must
 * not silently replace the model's card. sc-15 ("这张谷歌的卡片") named
 * 「Google 公司介绍」, which the old title-only matcher could not see: the 这张
 * shortcut then focused whatever was last focused.
 */
describe("accept60: a translated name resolves the card the user means", () => {
  const googleCanvas = (): CanvasContext => ({ ...canvas(), focusHistory: ["note_meeting"], cards: [
    ...canvas().cards,
    card("answer_google", "Google 公司介绍", "NewsCard", 900),
  ] });

  it("sc-15 keeps the model's card even when the words name a translated alias", async () => {
    // The host used to override the model with its own alias match. The model
    // owns the target now; the canvas summary gives it the title it needs.
    const f = setup([[{ name: "view", args: { mode: "focus",  card_id: "note_meeting" } }]]);
    const result = await runIntent({ text: "这张谷歌的卡片讲了什么", canvasContext: googleCanvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(actions(result)).toEqual([{ type: "card.focus", targetId: "note_meeting" }]);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sc-15 model picks the translated card itself", async () => {
    // Product value kept: when the model reads the summary (「Google 公司介绍」)
    // and picks it, the host honours that choice.
    const f = setup([[{ name: "view", args: { mode: "focus",  card_id: "answer_google" } }]]);
    const result = await runIntent({ text: "这张谷歌的卡片讲了什么", canvasContext: googleCanvas() }, f.deps);
    expect(actions(result)).toEqual([{ type: "card.focus", targetId: "answer_google" }]);
  });

  it("does not swap a card the model already chose when the alias matches two", async () => {
    const context = googleCanvas();
    context.cards.push(card("answer_google2", "Google 广告业务", "NewsCard", 1200));
    const f = setup([[{ name: "view", args: { mode: "focus",  card_id: "note_meeting" } }]]);
    const result = await runIntent({ text: "这张谷歌的卡片讲了什么", canvasContext: context }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(actions(result)).toEqual([{ type: "card.focus", targetId: "note_meeting" }]);
  });
});

/** A planner turn that re-enters the data adapter and comes back rules-shaped. */
describe("telemetry: a real planner turn is never reported as rules-fast", () => {
  it("counts a planner -> lookup -> data-adapter turn as planner (sc-21)", async () => {
    const sink = createIntentLogSink();
    const f = setup([[]], { toolCalls: false, intentLog: sink });
    const planner = vi.fn(async (): Promise<StepfunResult<unknown>> =>
      ({ ok: true, value: { lookup: { kind: "weather", city: "南京" } } }));
    const data = vi.fn(async (text: string) => text.includes("天气")
      ? { kind: "clarify" as const, message: "找到多个同名或近似地点：南京 / 江苏 / 中国…", suggestions: ["南京,江苏天气"] }
      : null);
    const result = await runIntent({ text: "明天南京要穿外套吗", canvasContext: canvas() },
      { ...f.deps, planner: { provider: "deepseek", connected: true, isCurrent: () => true, generate: planner },
        data: { handleDataIntent: data as unknown as NonNullable<PipelineDeps["data"]>["handleDataIntent"] } });
    expect(planner).toHaveBeenCalledTimes(1);
    expect(data).toHaveBeenCalled();
    // The committed result is the adapter's clarification: no provider label.
    expect(result.kind).toBe("clarify");
    expect(result.usedProvider).toBeUndefined();
    expect(sink.path).toBe("planner");
    expect(intentPathOf(result, sink)).toBe("planner");
  });

  it("still reports a rules-only answer as rules-fast", async () => {
    const sink = createIntentLogSink();
    const f = setup([[]], { toolCalls: false, intentLog: sink });
    const result = await runIntent({ text: "显示全部", canvasContext: canvas() }, f.deps);
    expect(result.usedProvider).toBe("rules");
    expect(sink.path).toBeUndefined();
    expect(intentPathOf(result, sink)).toBe("rules-fast");
    expect(f.generate).not.toHaveBeenCalled();
  });
});

/**
 * sc-60 — "查一下明天上海天气，要是下雨就提醒我带伞". The 2026-11-04 local run
 * created the WeatherCard and said only "已显示上海明天天气": the conditional
 * reminder half was silently dropped. The host cannot run "remind me only if it
 * rains", so the turn must say so or ask as a whole. These tests pin the repair
 * turn that makes the model state it (the host never writes that sentence).
 */
describe("accept60: a conditional clause is never silently dropped (sc-60)", () => {
  const weatherNow = () => vi.fn(async () => ({
    kind: "weather" as const, tempC: 18, conditionIcon: "cloud" as const,
    location: { id: 1796236, name: "上海", latitude: 31.22, longitude: 121.46, country: "中国",
      country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" },
    observedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(), weatherCode: 3, isDay: true,
    intervalSeconds: 900, modelGrid: { latitude: 31.22, longitude: 121.46 }, sources: [],
  }));
  const withWeather = (f: ReturnType<typeof setup>, weather: ReturnType<typeof weatherNow>) => ({
    ...f.deps, data: { handleDataIntent: (text: string, context: CanvasContext) =>
      handleDataIntent(text, context, undefined, { weather }) },
  });
  const SC60 = "查一下明天上海天气，要是下雨就提醒我带伞";

  it("gives the model one repair turn and the reply names the dropped clause", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "上海", day: "明天" } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } },
        { name: "unsupported", args: { reply: "条件提醒暂时做不了，只能先给你看明天天气。" } }],
    ]);
    const result = await runIntent({ text: SC60, canvasContext: canvas() }, withWeather(f, weatherNow()));
    expect(f.fetchImpl).toHaveBeenCalledTimes(2);
    // The follow-up turn saw the verified weather facts, not the old card label.
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("上海");
    expect(f.calls[1]!.messages.at(-1)!.content).toContain("18°C");
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual(["WeatherCard"]);
    expect(result.envelope?.spokenText ?? "").toContain("条件提醒暂时做不了");
  });

  it("ends in an honest question instead of a silent half-execution", async () => {
    const f = setup([
      [{ name: "weather", args: { city: "上海", day: "明天" } }],
      [{ name: "create_card", args: { kind: "weather", fields: {} } }],
      [{ name: "clarify", args: { missing: "other", question: "条件提醒暂时做不了：要不要先只看明天天气？" } }],
    ]);
    const result = await runIntent({ text: SC60, canvasContext: canvas() }, withWeather(f, weatherNow()));
    expect(f.fetchImpl).toHaveBeenCalledTimes(3);
    // The conditional clause cannot be executed silently: the repair turn names
    // it, and the model chooses the honest question.
    expect(f.calls[2]!.messages.at(-1)!.content).toContain("要是下雨就提醒我带伞");
    expect(f.calls[2]!.messages.at(-1)!.content).toContain("静默");
    // No card, no envelope: the user is told the condition cannot be run.
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(result.message ?? "").toContain("条件");
  });
});
