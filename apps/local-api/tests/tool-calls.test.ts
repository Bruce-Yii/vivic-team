import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import { TOOL_CATALOG, TOOL_DEFINITIONS, buildToolSystemPrompt, formatIssues, planFromToolCalls as planToolCalls, toolFeedbackPhrase, type ToolCall, type ToolCallPlan } from "../src/intent/toolCalls.js";
import { CanvasContextSchema, type CanvasContext } from "../src/schemas.js";

/**
 * The tool layer is a pure mapper: `tool_calls` in, existing card contracts out.
 * These tests pin both halves of the contract the model can break — the tool
 * surface (ten tools, one meaning each) and the ActionEnvelope the host commits.
 */

type PlanOptions = Parameters<typeof planToolCalls>[4];

/**
 * Every canvas action owes the user one natural sentence in the same batch
 * (`docs/decisions/2026-11-05-action-requires-model-receipt.md`); the cases in
 * this file are about the mapping, not about a model that forgot to speak, so
 * they run on the turn *after* the receipt's repair chance (`sayFallback`). The
 * receipt rule itself has its own describe block below.
 */
const planFromToolCalls = (calls: ToolCall[], ctx: CanvasContext, now?: number, utterance?: string, options?: PlanOptions): Promise<ToolCallPlan> =>
  planToolCalls(calls, ctx, now, utterance, { ...options, sayFallback: true });

/** Fixed clock so countdown/weekly targets are deterministic (Sunday 2026-11-01, Shanghai). */
const NOW = Date.parse("2026-11-01T02:00:00+08:00");

/** Four existing cards, shaped exactly like the Control page's CanvasContext. */
const canvas = (): CanvasContext => ({
  canvasId: "TEST-tool-calls",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: ["note_meeting"],
  timeZone: "Asia/Shanghai",
  cards: [
    {
      id: "note_meeting",
      type: "NoteCard",
      aliases: ["会议记录"],
      displayProps: { text: "周会纪要：确认发布窗口" },
      sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 320, height: 120, pinned: false },
    },
    {
      id: "note_shopping",
      type: "NoteCard",
      aliases: ["购物便笺"],
      displayProps: { text: "采购清单" },
      sourceDataSummary: {},
      layout: { x: 344, y: 0, width: 320, height: 120 },
    },
    {
      id: "todo_week",
      type: "TodoCard",
      aliases: ["本周待办"],
      displayProps: { items: [{ id: "item-1", text: "交周报", done: false }] },
      sourceDataSummary: {},
      layout: { x: 0, y: 144, width: 288, height: 160 },
    },
    {
      id: "countdown_tea",
      type: "CountdownCard",
      aliases: ["泡茶"],
      displayProps: { totalSeconds: 300 },
      // No absolute ISO timestamp here on purpose: the scene guard treats any
      // calendar fact on the canvas as a weekday the user named, which makes
      // create_weekly_plan's proposed Mon/Wed/Fri "ungrounded". The probe canvas
      // also sent titles only; the production-shaped canvas is covered by the
      // sensitivity section of scripts/tool-dry-run.ts.
      sourceDataSummary: { remainingSeconds: 300 },
      layout: { x: 312, y: 144, width: 260, height: 200 },
    },
  ],
});

/** A NewsCard canvas: its visible title is `headline`, which edit_card must map. */
const newsCanvas = (): CanvasContext => ({
  ...canvas(),
  canvasId: "TEST-tool-calls-news",
  cards: [{
    id: "news_one", type: "NewsCard", aliases: ["AI 新闻"],
    displayProps: { headline: "旧标题", summary: "一段摘要", summaryBy: "ai" },
    sourceDataSummary: {},
    layout: { x: 0, y: 0, width: 320, height: 120 },
  }],
});

const plan = (calls: ToolCall[], ctx: CanvasContext = canvas(), utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, ctx, NOW, utterance);

const cardsOf = (result: ToolCallPlan): Extract<Action, { type: "card.create" }>[] =>
  result.actions.filter((action): action is Extract<Action, { type: "card.create" }> => action.type === "card.create");
const focusIds = (result: ToolCallPlan): string[] =>
  result.actions.flatMap(action => (action.type === "card.focus" ? [action.targetId] : []));

type CreateAction = Extract<Action, { type: "card.create" }>;
/** `CardRecord.displayProps/sourceData` are per-card unions; tests read raw fields. */
const propsOf = (action: CreateAction): Record<string, unknown> =>
  action.card.displayProps as Record<string, unknown>;
const sourceOf = (action: CreateAction): Record<string, unknown> =>
  action.card.sourceData as Record<string, unknown>;
const eventsOf = (action: CreateAction): Array<Record<string, unknown>> =>
  (propsOf(action).events as Array<Record<string, unknown>> | undefined) ?? [];

/** The host revalidates every batch through the same envelope schema before commit. */
const envelope = (result: ToolCallPlan) => {
  expect(result.actions.length).toBeGreaterThan(0);
  const parsed = ActionEnvelopeSchema.safeParse({
    schemaVersion: "0.6",
    requestId: "req_tool_calls_test",
    canvasId: "TEST-tool-calls",
    actions: result.actions,
  });
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return parsed.data!;
};

const invalid = (result: ToolCallPlan) => {
  expect(result.kind).toBe("invalid");
  expect(result.actions).toEqual([]);
  expect(result.created).toEqual([]);
  expect(result.issues.length).toBeGreaterThan(0);
  return result.issues.join(" | ");
};

describe("tool surface", () => {
  it("declares the fourteen capability tools exactly once, each with a description and a parameter schema", () => {
    const names = TOOL_DEFINITIONS.map(definition => definition.function.name);
    expect(names).toEqual([
      "create_card",
      "update_card",
      "delete_card",
      "view",
      "arrange",
      "history",
      "search",
      "metal_price",
      "read_url",
      "weather",
      "find_cards",
      "clarify",
      "chat",
      "unsupported",
    ]);
    expect(new Set(names).size).toBe(names.length);
    for (const definition of TOOL_DEFINITIONS) {
      expect(definition.type).toBe("function");
      expect(definition.function.description.length).toBeGreaterThan(0);
      expect(definition.function.parameters).toMatchObject({ type: "object" });
    }
  });

  it("accepts the four-card canvas context the tests run against", () => {
    expect(CanvasContextSchema.safeParse(canvas()).success).toBe(true);
  });

  const descriptionOf = (name: string): string => {
    const definition = TOOL_DEFINITIONS.find(item => item.function.name === name);
    expect(definition, name).toBeDefined();
    return definition!.function.description;
  };

  it("writes every description in the five-part contract", () => {
    // 做什么 / 输入 / 何时用 / 何时绝对不用我 / 返回 — the same five headings for
    // every tool, so the model can compare neighbours instead of guessing.
    const sections = ["做什么：", "输入：", "何时用：", "何时绝对不用我：", "返回："];
    for (const definition of TOOL_DEFINITIONS) {
      const description = definition.function.description;
      for (const section of sections) {
        expect(description, `${definition.function.name} 缺少 ${section}`).toContain(section);
      }
      // Grouped by domain in the description; names stay stable for callers.
      expect(description.startsWith("【"), definition.function.name).toBe(true);
    }
  });

  it("keeps the capability catalog and feedback phrases in sync with the surface", () => {
    const names = TOOL_DEFINITIONS.map(definition => definition.function.name);
    // Adding/removing a tool must update the catalog and the progress line too.
    expect(TOOL_CATALOG.map(capability => capability.name)).toEqual(names);
    for (const name of names) expect(toolFeedbackPhrase(name), name).not.toBe("我正在处理");
    expect(TOOL_CATALOG.find(capability => capability.name === "update_card"))
      .toMatchObject({ capability: "edit", targeted: true, destructive: false });
    // One factory entry exposes every card kind instead of per-card tools.
    expect(TOOL_CATALOG.find(capability => capability.name === "create_card")?.kinds).toEqual([
      "countdown", "todo", "note", "weekly_plan", "schedule", "template", "scene", "chart", "notification", "habit", "answer",
      "weather", "search_results", "article",
    ]);
    expect(TOOL_CATALOG.find(capability => capability.name === "view")?.modes).toEqual(["focus", "highlight", "fit", "restore"]);
    expect(TOOL_CATALOG.find(capability => capability.name === "history")?.actions).toEqual(["undo", "redo"]);
    expect(TOOL_CATALOG.find(capability => capability.name === "focus_created")).toBeUndefined();
  });

  it("gives every meaning exactly one owner", () => {
    // The factory names every kind it can build: a card type has one entry, and
    // the per-kind table is the only place its fields are described.
    const create = descriptionOf("create_card");
    for (const kind of ["countdown", "todo", "note", "weekly_plan", "schedule", "template", "scene",
      "chart", "notification", "habit", "answer", "weather", "search_results", "article"]) {
      expect(create, kind).toContain(`kind=${kind}`);
    }
    // Live facts vs stable knowledge vs weather vs small talk.
    expect(create).toContain("实时资讯");
    expect(create).toContain("search");
    expect(create).toContain("weather");
    expect(descriptionOf("search")).toContain("稳定知识解释");
    expect(descriptionOf("search")).toContain("create_card(kind=answer)");
    expect(descriptionOf("chat")).toContain("create_card(kind=answer)");
    expect(descriptionOf("weather")).toContain("search");
    // A scene card may not shadow a dedicated kind.
    for (const owner of ["chart", "notification", "habit", "todo"]) expect(create, owner).toContain(`kind=${owner}`);
    // Appending, entry edits and title edits each name their one owner.
    expect(create).toContain("update_card");
    expect(descriptionOf("update_card")).toContain("create_card(kind=todo");
    expect(descriptionOf("update_card")).toContain("delete_card");
    // The redundant duplicate was removed rather than documented away.
    expect(TOOL_DEFINITIONS.map(item => item.function.name)).not.toContain("focus_created");
    expect(TOOL_DEFINITIONS.map(item => item.function.name)).not.toContain("create_todo");
  });

  /**
   * `project_plan`, `reading_note`, `comparison_table` and `todo_checklist`
   * duplicated scene/todo cards. One meaning per kind: the enum and the prompt
   * must not offer them any more, or the model keeps picking the old path.
   */
  it("offers only the four non-overlapping office templates", () => {
    const definition = TOOL_DEFINITIONS.find(item => item.function.name === "create_card")!;
    const kind = (definition.function.parameters.properties as Record<string, { enum?: string[] }>).kind!;
    expect(kind.enum).toContain("template");
    const prompt = buildToolSystemPrompt(canvas());
    const rule8 = prompt.split("\n").find(line => line.startsWith("8. ")) ?? "";
    expect(rule8).toContain("会议纪要/周报/决策记录/复盘");
    for (const retired of ["项目计划", "阅读笔记", "对比表", "待办清单"]) expect(rule8).not.toContain(retired);
    // The field table no longer documents a retired template id.
    for (const retired of ["project_plan", "reading_note", "comparison_table", "todo_checklist"])
      expect(prompt).not.toContain(`${retired}: `);
    // The replacement kinds are named so the model has somewhere to go.
    expect(prompt).toContain('create_card(kind="scene", fields={"scene_id":"project_roadmap"})');
    expect(prompt).toContain('阅读笔记用 kind="scene"（scene_id="book_record"）');
    expect(prompt).toContain('对比表用 kind="scene"（scene_id="option_comparison"）');
    expect(prompt).toContain('待办清单用 kind="todo"');
  });
});

/**
 * The prompt is the only lever the model has over target resolution and
 * multi-action batches, so it is pinned like an interface: ids plus geometry,
 * the focus tail, and the two multi-action few-shots must all survive edits.
 */
describe("tool system prompt", () => {
  const promptOf = (ctx: CanvasContext = canvas()): string => buildToolSystemPrompt(ctx);

  it("lists every card with its id, type, label and layout", () => {
    const prompt = promptOf();
    expect(prompt).toContain("- note_meeting (NoteCard) 「周会纪要：确认发布窗口」 @0,0 320x120");
    expect(prompt).toContain("- note_shopping (NoteCard) 「采购清单」 @344,0 320x120");
    // A TodoCard has no title; its first item is the label the user names.
    expect(prompt).toContain("- todo_week (TodoCard) 「交周报」 @0,144 288x160");
    // A CountdownCard falls back to its alias.
    expect(prompt).toContain("- countdown_tea (CountdownCard) 「泡茶」 @312,144 260x200");
    expect(prompt).toContain("@x,y 为左上角坐标");
  });

  it("carries each list's entries with their ids so an entry can be named (sc-30)", () => {
    const prompt = buildToolSystemPrompt(listCanvas());
    expect(prompt).toContain("- todo_week (TodoCard) 「本周待办」 @0,0 288x160 条目：交周报(item-1)/买牛奶(item-2)/预约牙医(item-3)");
    expect(prompt).toContain("- todo_shop (TodoCard) 「购物清单」 @400,0 288x160 条目：鸡蛋(item-1)/洗衣液(item-2)");
    expect(prompt).toContain("「条目：」后面括号里的 id 就是 update_card 的 item_id");
    // A card without entries stays a single line.
    expect(prompt).toContain("- note_meeting (NoteCard) 「周会纪要：确认发布窗口」 @0,200 320x120\n");
  });

  it("shows every entry of the focused card and a counted preview elsewhere", () => {
    const many = listCanvas();
    many.focusHistory = ["todo_week"];
    many.cards[0]!.displayProps = { title: "本周待办", items: Array.from({ length: 9 }, (_, index) =>
      ({ id: `item-${index + 1}`, text: `条目${index + 1}`, done: false })) };
    const prompt = buildToolSystemPrompt(many);
    // The focused card is the one the user is talking about: all nine entries.
    expect(prompt).toContain("[当前聚焦] 条目：条目1(item-1)/条目2(item-2)/条目3(item-3)/条目4(item-4)/条目5(item-5)/条目6(item-6)/条目7(item-7)/条目8(item-8)/条目9(item-9)");
    // Everyone else keeps a bounded preview plus the number left out.
    many.cards[1]!.displayProps = { title: "购物清单", items: Array.from({ length: 9 }, (_, index) =>
      ({ id: `item-${index + 1}`, text: `购物${index + 1}`, done: false })) };
    const bounded = buildToolSystemPrompt(many);
    expect(bounded).toContain("条目：购物1(item-1)/购物2(item-2)/购物3(item-3)/购物4(item-4)/购物5(item-5)/购物6(item-6)/…还有3条");
    expect(bounded).toContain("只用这里出现过的 id，不要编");
  });

  it("routes knowledge questions to answer and impossible asks to unsupported", () => {
    const prompt = promptOf();
    expect(prompt).toContain("知识问答一律 create_card(kind=\"answer\") 落卡");
    expect(prompt).toContain("宁德时代是做什么的");
    // "chat" is now chit-chat only, never the knowledge-answer route.
    expect(prompt).toContain("只有打招呼、感谢、情绪表达才用 chat");
    expect(prompt).toContain("unsupported(reply=");
    // Appending and entry-level highlight have an outlet of their own.
    expect(prompt).toContain("create_card(kind=\"todo\", fields={\"card_id\":");
    expect(prompt).toContain("items 只放新增条目，宿主保留原条目");
    expect(prompt).toContain("view(mode=\"highlight\", card_id=条目表里有买牛奶(item-2)的那张卡");
    // Multi-match target: the model must ask instead of picking one (sc-56/59).
    expect(prompt).toContain("多候选不许猜");
    expect(prompt).toContain("必须调用 clarify(missing=\"target\")");
    expect(prompt).toContain("targetCandidates");
    // A dropped conditional clause must be named or clarified, never silent (sc-60).
    expect(prompt).toContain("复合句不丢子句");
    expect(prompt).toContain("条件提醒暂时做不了");
  });

  it("keeps a long card label to one line", () => {
    const long = canvas();
    long.cards[0]!.displayProps = { text: "周".repeat(60) };
    const prompt = promptOf(long);
    expect(prompt).toContain(`「${"周".repeat(40)}…」`);
    expect(prompt).not.toContain("周".repeat(41));
  });

  it("marks a pinned card so pin/unpin targets are readable", () => {
    const pinned = canvas();
    pinned.cards[0]!.layout.pinned = true;
    expect(promptOf(pinned)).toContain("@0,0 320x120 [固定]");
    expect(promptOf()).not.toContain("@0,0 320x120 [固定]");
  });

  it("carries the focus history newest-first so “它/刚才那张” resolves", () => {
    expect(promptOf()).toContain("最近聚焦（越靠前越近）：note_meeting");
    expect(promptOf({ ...canvas(), focusHistory: [] })).toContain("最近聚焦：无");
    const two = promptOf({ ...canvas(), focusHistory: ["note_meeting", "todo_week"] });
    expect(two).toContain("最近聚焦（越靠前越近）：todo_week「交周报」 → note_meeting");
  });

  it("adds focused cards outside the 24-card summary so no id is unusable", () => {
    const many = canvas();
    many.cards = Array.from({ length: 30 }, (_, index) => ({
      id: `note_${index}`, type: "NoteCard", aliases: [`卡片${index}`],
      displayProps: { text: `内容${index}` }, sourceDataSummary: {},
      layout: { x: index * 340, y: 0, width: 320, height: 120, pinned: false },
    }));
    many.focusHistory = ["note_2", "note_25", "note_27"];
    const prompt = buildToolSystemPrompt(many);
    // The first 24 stay the summary base.
    expect(prompt).toContain("- note_23 (NoteCard) 「内容23」");
    expect(prompt).not.toContain("- note_24 (NoteCard)");
    // Focused cards beyond the window are appended with type, label and geometry,
    // so focus_card/delete_card can resolve every id named in 最近聚焦.
    expect(prompt).toContain("- note_27 (NoteCard) 「内容27」 @9180,0 320x120 [当前聚焦]");
    expect(prompt).toContain("- note_25 (NoteCard) 「内容25」 @8500,0 320x120 [最近聚焦]");
    expect(prompt).toContain("- note_2 (NoteCard) 「内容2」 @680,0 320x120 [最近聚焦]");
    expect(prompt).toContain("最近聚焦（越靠前越近）：note_27「内容27」 → note_25「内容25」 → note_2「内容2」");
    expect(prompt).toContain("并补上最近聚焦的 2 张");
  });

  it("never names a focused id that is not on the canvas", () => {
    const stale = canvas();
    stale.focusHistory = ["ghost_card", "note_meeting"];
    const prompt = buildToolSystemPrompt(stale);
    expect(prompt).not.toContain("ghost_card");
    expect(prompt).toContain("最近聚焦（越靠前越近）：note_meeting");
  });

  it("tells the model how to resolve positional references instead of refusing", () => {
    const prompt = promptOf();
    expect(prompt).toContain("x 最小=最左");
    expect(prompt).toContain("最近聚焦");
    expect(prompt).toContain("不要说“摘要里没有位置”");
    // A negated action must not be executed: "别删，先聚焦它" only focuses.
    expect(prompt).toContain("「别删，先聚焦它」→ 只调用 view(mode=\"focus\")");
  });

  it("routes a chart utterance to create_chart, not a scene card or a question", () => {
    const prompt = promptOf();
    expect(prompt).toContain("把这几个数做成柱状图");
    expect(prompt).toContain('create_card(kind="chart", fields={"chartKind":"bar"');
    expect(prompt).toContain('"points":[');
    expect(prompt).toContain('"x":"周一"');
    expect(prompt).toContain('不要改用 kind="scene" 的表格');
    expect(prompt).toContain("不要反问用户已经说过的数据");
    // The scene route is retired from the prompt: one owner per meaning.
    expect(prompt).not.toContain('scene_id="data_visualization"');
  });

  it("routes a notification utterance to create_notification with a level", () => {
    const prompt = promptOf();
    expect(prompt).toContain("明天九点交材料，级别重要");
    expect(prompt).toContain('create_card(kind="notification", fields={"title":"交材料"');
    expect(prompt).toContain('"body":"明天九点交材料"');
    expect(prompt).toContain('"level":"warning"');
    expect(prompt).toContain("“重要/紧急”≈warning");
    expect(prompt).not.toContain('scene_id="single_notification"');
  });

  it("pins both multi-action few-shots on one line each", () => {
    const lines = promptOf().split("\n");
    const focusThenPin = lines.find(line => line.includes("先聚焦购物清单")) ?? "";
    expect(focusThenPin).toContain('view(mode="focus"');
    expect(focusThenPin).toContain("arrange(target=");
    expect(focusThenPin).toContain('position="pin"');
    const showThenArrange = lines.find(line => line.includes("显示全部再整理")) ?? "";
    expect(showThenArrange).toContain('view(mode="fit")');
    expect(showThenArrange).toContain('arrange(target="canvas")');
    expect(promptOf()).toContain("漏做");
  });
});

describe("one tool call per contract", () => {
  it("create_countdown builds a CountdownCard from minutes", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 10 } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["CountdownCard"]);
    expect(result.created[0]!.tool).toBe("create_card");
    expect(result.routes).toEqual(["countdown"]);
    const created = cardsOf(result)[0]!;
    expect(created.card.type).toBe("CountdownCard");
    // 10 minutes from the fixed clock, computed by the host, not the model.
    expect(sourceOf(created)).toMatchObject({ startedAt: new Date(NOW).toISOString() });
    expect(Date.parse(String(sourceOf(created).targetAt))).toBe(NOW + 10 * 60 * 1000);
    expect(sourceOf(created)).not.toHaveProperty("reminderText");
    envelope(result);
  });

  it("create_countdown carries a user-stated reminder text", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 20, text: "把汤关火" } } }]);
    expect(result.kind).toBe("envelope");
    expect(sourceOf(cardsOf(result)[0]!)).toMatchObject({ reminderText: "把汤关火" });
    envelope(result);
  });

  it("create_todo builds one TodoCard holding every item", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶", "交周报"] } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.routes).toEqual(["todo"]);
    expect(propsOf(cardsOf(result)[0]!)).toMatchObject({
      items: [{ id: "item-1", text: "买牛奶", done: false }, { id: "item-2", text: "交周报", done: false }],
    });
    envelope(result);
  });

  it("create_note builds a NoteCard that stores the text verbatim", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    expect(result.routes).toEqual(["note"]);
    expect(propsOf(cardsOf(result)[0]!)).toMatchObject({ text: "明天交周报" });
    envelope(result);
  });

  it("create_weekly_plan builds a bare fitness plan instead of asking 哪几天 (sc-16)", async () => {
    // The plan's days are the plan's own content (scenes/build.ts weekly_schedule);
    // a bare "健身计划" is no longer replaced by a host question.
    const built = await plan([{ name: "create_card", arguments: { kind: "weekly_plan", fields: { topic: "健身计划" } } }], canvas(), "帮我做一个下周的健身计划");
    expect(built.kind).toBe("envelope");
    expect(built.message ?? "").not.toContain("哪几天");
    expect(built.created.map(item => item.cardType)).toEqual(["WeeklyScheduleCard"]);
    const card = cardsOf(built)[0]!;
    expect(String(propsOf(card).title)).toContain("健身计划");
    // Proposed days and exercise names stay the suggestion the scene owns; no
    // clock time is invented and no duration question is asked.
    expect(eventsOf(card).map(event => event.day)).toEqual([1, 3, 5]);
    for (const event of eventsOf(card)) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
    envelope(built);
  });

  it("create_weekly_plan builds a WeeklyScheduleCard for next week with no invented clock", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "weekly_plan", fields: { topic: "健身计划" } } }], canvas(), "下周健身计划：周一三五早上跑步");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["WeeklyScheduleCard"]);
    const card = cardsOf(result)[0]!;
    // weekStart is intentionally not asserted: the scene guard re-anchors the
    // week from any "本周/下周" text on the canvas (the todo card's alias), which
    // the dry-run report records as an adapter finding rather than a contract.
    expect(String(propsOf(card).title)).toContain("健身计划");
    const events = eventsOf(card);
    expect(events.map(event => event.day)).toEqual([1, 3, 5]);
    for (const event of events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
    envelope(result);
  });

  it("create_schedule builds a WeeklyScheduleCard on the named weekday at the stated clock", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "开会", day: "周四", time: "上午9点" } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["WeeklyScheduleCard"]);
    const card = cardsOf(result)[0]!;
    expect(propsOf(card)).toMatchObject({ title: "周四 开会" });
    expect(eventsOf(card)[0]).toMatchObject({
      day: 4,
      title: "开会",
      start: "09:00",
    });
    envelope(result);
  });

  it("create_schedule omits start when the user gave no clock", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "健身", day: "周四", time: "下午" } } }]);
    expect(result.kind).toBe("envelope");
    expect(eventsOf(cardsOf(result)[0]!)[0]).toMatchObject({
      day: 4,
      // A period without a clock is user-stated fact: it stays in the title
      // instead of being dropped or turned into an invented start time.
      title: "下午健身",
    });
    expect(eventsOf(cardsOf(result)[0]!)[0]).not.toHaveProperty("start");
    envelope(result);
  });

  it("create_schedule resolves an explicit date instead of silently using today", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "11-05" } } }]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const card = cardsOf(result)[0]!;
    expect(String(propsOf(card).title)).toContain("11月5日");
    expect(eventsOf(card)[0]).toMatchObject({ day: 4, title: "评审" });
    envelope(result);
  });

  it("create_schedule reads 大后天 as +3 days, not as 后天", async () => {
    // `includes("后天")` also matches 大后天: the relative table must check the
    // longer word first or the event silently moves one day early.
    const result = await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "大后天" } } }]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(eventsOf(cardsOf(result)[0]!)[0]).toMatchObject({ day: 3 });
  });

  it("create_schedule refuses a day it cannot read instead of moving the event to today", async () => {
    // The old parser returned today's weekday for any unreadable word, so
    // 「下周八」 became an event today with no error. A structured issue is the
    // only honest answer: the model re-fills day or asks the user.
    const issues = invalid(await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "下周八" } } }],
      canvas(), "下周八评审"));
    expect(issues).toContain("看不懂日期");
    expect(issues).toContain("invalid-param");
    const noDate = invalid(await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "情人节" } } }]));
    expect(noDate).toContain("看不懂日期");
  });

  it("create_schedule refuses a time it cannot read instead of dropping it", async () => {
    // The old parser dropped an unreadable `time` and built the card without it,
    // so the event lost the time the user said without any error.
    const issues = invalid(await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "周四", time: "abc" } } }]));
    expect(issues).toContain("看不懂时间");
    // 上午 is a period, not a clock: it stays allowed and is kept in the title.
    const periodOnly = await plan([{ name: "create_card", arguments: { kind: "schedule", fields: { title: "评审", day: "周四", time: "上午" } } }]);
    expect(periodOnly.kind, periodOnly.issues.join(" | ")).toBe("envelope");
  });

  it("auto-focuses a new card; the redundant focus_created tool is gone", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    // The contract already focuses its own card; the old extra tool only
    // repeated that target and is no longer part of the surface.
    expect(focusIds(result)).toEqual([result.created[0]!.id]);
    expect(TOOL_DEFINITIONS.some(item => item.function.name === "focus_created")).toBe(false);
    const rejected = invalid(await plan([{ name: "focus_created", arguments: {} }]));
    expect(rejected).toContain("未知工具");
    expect(rejected).toContain("unsupported");
  });

  it("canvas_fit is a camera move only, never a card", async () => {
    const result = await plan([{ name: "view", arguments: { mode: "fit" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["overview"]);
    // A pure view action still needs at least one action to be a valid envelope.
    expect(envelope(result).actions).toEqual([{ type: "canvas.fit" }]);
  });

  it("focus_card targets an existing id from the canvas summary", async () => {
    const result = await plan([{ name: "view", arguments: { mode: "focus", card_id: "note_shopping" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["focus"]);
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "note_shopping" }]);
  });

  it("highlight_card highlights an existing id and never creates", async () => {
    const result = await plan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["highlight"]);
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week" }]);
  });

  it("restore_view restores the camera without touching cards", async () => {
    const result = await plan([{ name: "view", arguments: { mode: "restore" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["restore"]);
    expect(envelope(result).actions).toEqual([{ type: "canvas.restore" }]);
  });

  it("delete_card proposes a delete of an existing id (host still confirms)", async () => {
    const result = await plan([{ name: "delete_card", arguments: { card_id: "note_shopping" } }]);
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["delete"]);
    expect(envelope(result).actions).toEqual([{ type: "card.delete", targetId: "note_shopping" }]);
  });

  it("delete_card for 删了它 targets the focused card only when the model's id is gone", async () => {
    // The model read a focus id the 24-card summary did not contain and echoed a
    // ghost. A pure pointer has one referent; with no valid id the host may take
    // that referent instead of failing and asking the user which card.
    const result = await planFromToolCalls([{ name: "delete_card", arguments: { card_id: "ghost_card" } }],
      canvas(), NOW, "删了它");
    expect(result.kind).toBe("envelope");
    expect(result.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
  });

  it("delete_card keeps a valid model id even for a bare 删了 with no focus", async () => {
    // The pointer has no referent (nothing was focused), but the model named a
    // card that exists: that is the decision, and the pipeline still confirms it.
    const none = canvas();
    none.focusHistory = [];
    const result = await planFromToolCalls([{ name: "delete_card", arguments: { card_id: "note_shopping" } }], none, NOW, "删了");
    expect(result.kind).toBe("envelope");
    expect(result.actions).toEqual([{ type: "card.delete", targetId: "note_shopping" }]);
  });

  it("a bare 删了 with no focus and no usable id explains instead of guessing", async () => {
    const none = canvas();
    none.focusHistory = [];
    const result = await planFromToolCalls([{ name: "delete_card", arguments: { card_id: "ghost_card" } }], none, NOW, "删了");
    // The host hands the gap back to the model (one repair turn); the model, not
    // the host, decides whether to ask the user which card.
    expect(result.kind).toBe("invalid");
    expect(result.issues.join(" ")).not.toMatch(/哪张|哪一张/);
    expect(result.actions).toEqual([]);
  });

  it("a content-named delete never falls back to the focused card", async () => {
    const result = await planFromToolCalls([{ name: "delete_card", arguments: { card_id: "ghost_card" } }],
      canvas(), NOW, "删除周报的卡片");
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
  });

  it("undo_last returns a host history operation, not a card", async () => {
    const result = await plan([{ name: "history", arguments: { action: "undo" } }]);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "history.undo" });
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["undo"]);
    const redo = await plan([{ name: "history", arguments: { action: "redo" } }]);
    expect(redo.hostOperation).toEqual({ kind: "history.redo" });
  });

  it("edit_card renames a card through the contract's own title field", async () => {
    const renamed = await plan([{ name: "update_card", arguments: {
      card_id: "todo_week", action: "set_title", title: "周末待办",
    } }]);
    expect(renamed.kind).toBe("envelope");
    expect(renamed.routes).toEqual(["edit"]);
    expect(envelope(renamed).actions).toEqual([
      { type: "card.update", targetId: "todo_week", displayProps: { title: "周末待办" } },
    ]);
    // A NewsCard's visible title is `headline`, not an invented `title` field.
    const news = await plan([{ name: "update_card", arguments: {
      card_id: "news_one", action: "set_title", title: "新的标题",
    } }], newsCanvas());
    expect(news.kind).toBe("envelope");
    expect(envelope(news).actions).toEqual([
      { type: "card.update", targetId: "news_one", displayProps: { headline: "新的标题" } },
    ]);
  });

  it("edit_card rejects a title edit without a title or on a card that has none", async () => {
    const missing = invalid(await plan([{ name: "update_card", arguments: {
      card_id: "todo_week", action: "set_title",
    } }]));
    expect(missing).toContain("set_title 缺少 title");
    const note = invalid(await plan([{ name: "update_card", arguments: {
      card_id: "note_meeting", action: "set_title", title: "改名",
    } }]));
    expect(note).toContain("没有可改的标题字段");
    expect(note).toContain("unsupported");
  });

  it("edit_card pauses and resumes only a countdown", async () => {
    const paused = await plan([{ name: "update_card", arguments: { card_id: "countdown_tea", action: "pause_countdown" } }]);
    expect(paused.kind).toBe("host-operation");
    expect(paused.hostOperation).toEqual({ kind: "countdown.pause", targetId: "countdown_tea" });
    expect(paused.routes).toEqual(["edit"]);
    const resumed = await plan([{ name: "update_card", arguments: { card_id: "countdown_tea", action: "resume_countdown" } }]);
    expect(resumed.hostOperation).toEqual({ kind: "countdown.resume", targetId: "countdown_tea" });
    const notCountdown = invalid(await plan([{ name: "update_card", arguments: { card_id: "note_meeting", action: "pause_countdown" } }]));
    expect(notCountdown).toContain("倒计时");
  });

  it("arrange_card moves or pins an existing card", async () => {
    const moved = await plan([{ name: "arrange", arguments: { target: "todo_week", position: "left" } }]);
    expect(moved.kind).toBe("host-operation");
    expect(moved.hostOperation).toEqual({ kind: "card.move", targetId: "todo_week", direction: "left" });
    expect(moved.routes).toEqual(["arrange"]);
    const pinned = await plan([{ name: "arrange", arguments: { target: "note_meeting", position: "pin" } }]);
    expect(pinned.hostOperation).toEqual({ kind: "card.pin", targetId: "note_meeting", pinned: true });
  });

  it("pairs one host operation with view actions in a composite batch", async () => {
    // A create plus a host operation keeps the card envelope; the host applies
    // the envelope first, then the single operation.
    const note = await plan([
      { name: "create_card", arguments: { kind: "note", fields: { text: "x" } } },
      { name: "history", arguments: { action: "undo" } },
    ]);
    expect(note.kind).toBe("composite");
    expect(note.hostOperation).toEqual({ kind: "history.undo" });
    expect(note.actions.map(action => action.type)).toEqual(["card.create", "card.focus"]);
    // "先聚焦购物清单，再把它固定住": the focus is an envelope action and the
    // pin is a host operation against the same existing card.
    const pair = await plan([
      { name: "view", arguments: { mode: "focus", card_id: "todo_week" } },
      { name: "arrange", arguments: { target: "todo_week", position: "pin" } },
    ], canvas(), "先聚焦本周待办，再把它固定住");
    expect(pair.kind).toBe("composite");
    expect(pair.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: true });
    expect(pair.actions).toEqual([{ type: "card.focus", targetId: "todo_week" }]);
    expect(pair.routes).toEqual(["focus", "arrange"]);
    // "先显示全部卡片，然后整理一下布局": a camera move plus canvas arrange.
    const camera = await plan([
      { name: "view", arguments: { mode: "fit" } },
      { name: "arrange", arguments: { target: "canvas" } },
    ], canvas(), "先显示全部卡片，然后整理一下布局");
    expect(camera.kind).toBe("composite");
    expect(camera.hostOperation).toEqual({ kind: "canvas.arrange" });
    expect(camera.actions).toEqual([{ type: "canvas.fit" }]);
    expect(camera.routes).toEqual(["overview", "arrange"]);
  });

  it("still allows only one host operation per batch", async () => {
    // Relaxing the envelope+operation rule must not make two operations run.
    const issues = invalid(await plan([
      { name: "arrange", arguments: { target: "todo_week", position: "pin" } },
      { name: "arrange", arguments: { target: "canvas" } },
    ]));
    expect(issues).toContain("一个宿主操作");
    const undone = invalid(await plan([
      { name: "history", arguments: { action: "undo" } },
      { name: "update_card", arguments: { card_id: "countdown_tea", action: "pause_countdown" } },
    ]));
    expect(undone).toContain("一个宿主操作");
  });


  it("create_from_template builds the template's real card type", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "template", fields: {
      template_id: "meeting_minutes",
      fields: { topics: ["预算评审"], decisions: ["先按 A 方案推进"] },
    } } }]);
    expect(result.kind).toBe("envelope");
    expect(result.routes).toEqual(["generate"]);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.cardType).toBe("NoteCard");
    expect(envelope(result).actions.map(action => action.type)).toContain("card.create");
  });

  it("create_from_template rejects unknown templates and hands missing fields back", async () => {
    const unknown = invalid(await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: "nope", fields: {} } } }]));
    expect(unknown).toContain("未知模板");
    const missing = await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: "meeting_minutes", fields: {} } } }]);
    expect(missing.kind).toBe("invalid");
    const gap = missing.issues.at(-1)!;
    expect(gap.code).toBe("missing-param");
    expect(gap.message).toContain("会议");
    expect(gap.hint).toContain("clarify(missing=...)");
  });

  it.each([
    ["project_plan", "project_roadmap"],
    ["reading_note", "book_record"],
    ["comparison_table", "option_comparison"],
    ["todo_checklist", "create_card(kind=\"todo\""],
  ])("rejects the retired %s template and names %s instead", async (templateId, replacement) => {
    // The enum should stop this upstream; the mapper still refuses it so a
    // stale tool schema or gateway cannot resurrect an overlapping template.
    const issues = invalid(await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: templateId, fields: {} } } }]));
    expect(issues).toContain("已并入");
    expect(issues).toContain(replacement);
  });

  it("still builds the four retained office templates", async () => {
    const weekly = await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: "weekly_report",
      fields: { done: ["模板调研"], next: ["接入工具层"] } } } }]);
    expect(weekly.kind).toBe("envelope");
    expect(weekly.created[0]!.cardType).toBe("TodoCard");
    const retro = await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: "retrospective",
      fields: { topic: "模板试点", wentWell: ["选型准"], toImprove: ["字段太细"], next: ["合并同义字段"] } } } }]);
    expect(retro.kind).toBe("envelope");
    const decision = await plan([{ name: "create_card", arguments: { kind: "template", fields: { template_id: "decision_record",
      fields: { topic: "模板存哪", options: ["代码", "数据库"], decision: "先放代码" } } } }]);
    expect(decision.kind).toBe("envelope");
  });

  it("create_scene_card builds any registered scene card", async () => {
    const quote = await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "quote_note", data: { text: "慢慢来，比较快" } } } }]);
    expect(quote.kind).toBe("envelope");
    expect(quote.created.map(item => item.cardType)).toEqual(["QuoteCard"]);
    expect(quote.routes).toEqual(["generate"]);
    const chart = await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "data_visualization", data: {
      chartKind: "bar", points: [{ x: "周一", y: 12 }, { x: "周二", y: 8 }],
    } } } }], canvas(), "把这几个数做成柱状图：周一 12，周二 8");
    expect(chart.created.map(item => item.cardType)).toEqual(["ChartCard"]);
    expect(chart.kind).toBe("envelope");
  });

  it("create_scene_card rejects an unknown scene id", async () => {
    const issues = invalid(await plan([{ name: "create_card", arguments: { kind: "scene", fields: { scene_id: "nope", data: {} } } }]));
    expect(issues).toContain("参数不合法");
  });

  it("keeps a 4.5 rating as 4.5: the host never rounds the user's own score", async () => {
    const utterance = "书籍记录：《原则》瑞·达利欧，已读完，评分4.5";
    const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "book_record",
      data: { title: "原则", author: "瑞·达利欧", status: "finished", rating: 4.5 },
    } } }], canvas(), utterance);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const [create] = cardsOf(result);
    expect(create?.card.type).toBe("BookCard");
    const props = propsOf(create!);
    expect(props.rating).toBe(4.5);
    // The old behaviour rounded to 5 and pushed "评分 4.5" into notes — that
    // edited the user's data. A half star is stored as given, with no note.
    expect(props).not.toHaveProperty("notes");
    envelope(result);
  });

  it("drops a decimal rating and keeps the words when the frontend cannot render half stars", async () => {
    const utterance = "书籍记录：《原则》瑞·达利欧，已读完，评分4.5";
    const previous = process.env.VIVIC_DECIMAL_RATING;
    process.env.VIVIC_DECIMAL_RATING = "off";
    try {
      const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
        scene_id: "book_record",
        data: { title: "原则", author: "瑞·达利欧", status: "finished", rating: 4.5 },
      } } }], canvas(), utterance);
      expect(result.kind, result.issues.join(" | ")).toBe("envelope");
      const [create] = cardsOf(result);
      const props = propsOf(create!);
      // The shipped web bundle validates rating as an integer: sending 4.5 makes
      // the whole envelope fail client-side. Until it ships half stars the card
      // carries no rating, but the user's exact words stay visible.
      expect(props).not.toHaveProperty("rating");
      expect(props.notes).toContain("评分 4.5");
      envelope(result);
    } finally {
      if (previous === undefined) delete process.env.VIVIC_DECIMAL_RATING;
      else process.env.VIVIC_DECIMAL_RATING = previous;
    }
  });

  it.each([
    ["Monday-based weekday tokens", ["周一", "周二", "周三"]],
    ["a weekday range", ["本周一到周三"]],
  ])("builds a HabitHeatmapCard from %s and derives this week's ISO dates", async (_label, checkins) => {
    const now = Date.parse("2026-11-03T10:00:00+08:00"); // Tuesday 2026-11-03, Shanghai
    const result = await planFromToolCalls([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词", checkins },
    } } }], canvas(), now, "习惯打卡：每天背单词，本周一到周三做到了");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const [create] = cardsOf(result);
    expect(create?.card.type).toBe("HabitHeatmapCard");
    expect(propsOf(create!).checkins).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);
    envelope(result);
  });

  it("does not invent habit check-ins the user never said", async () => {
    const fabricated = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词", checkins: ["2026-11-02"] },
    } } }], canvas(), "习惯打卡：每天背单词");
    expect(fabricated.kind).toBe("invalid");
    expect(fabricated.issues[0]!.code).toBe("ungrounded");
    expect(fabricated.actions).toEqual([]);

    const undated = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词" },
    } } }], canvas(), "习惯打卡：每天背单词");
    expect(undated.kind).toBe("invalid");
    expect(undated.actions).toEqual([]);
  });

  it("create_habit derives weekday check-ins but never treats the model's hint as evidence", async () => {
    const now = Date.parse("2026-11-03T10:00:00+08:00");
    const result = await planFromToolCalls([{ name: "create_card", arguments: { kind: "habit", fields: {
      habit: "背单词", checkins: ["周一", "周二", "周三"],
    } } }], canvas(), now, "习惯打卡：每天背单词，本周一到周三做到了");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    const [create] = cardsOf(result);
    expect(create?.card.type).toBe("HabitHeatmapCard");
    expect(propsOf(create!).checkins).toEqual(["2026-11-02", "2026-11-03", "2026-11-04"]);

    const invented = await planFromToolCalls([{ name: "create_card", arguments: { kind: "habit", fields: {
      habit: "背单词", checkins: ["周一"],
    } } }], canvas(), now, "习惯打卡：每天背单词");
    expect(invented.kind).toBe("invalid");
    expect(invented.actions).toEqual([]);
  });

  it("arrange_canvas is a host canvas arrangement operation", async () => {
    const result = await plan([{ name: "arrange", arguments: { target: "canvas" } }]);
    expect(result.kind).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "canvas.arrange" });
    expect(result.routes).toEqual(["arrange"]);
  });

  it("missing required create args go back to the model instead of a host question", async () => {
    const countdown = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: {} } }]);
    expect(countdown.kind).toBe("invalid");
    expect(countdown.issues[0]!.code).toBe("missing-param");
    expect(countdown.issues[0]!.message).toContain("多长时间");
    expect(countdown.issues[0]!.hint).toContain("clarify(missing=...)");
    const todo = await plan([{ name: "create_card", arguments: { kind: "todo", fields: {} } }]);
    expect(todo.kind).toBe("invalid");
    expect(todo.issues[0]!.message).toContain("待办");
    const note = await plan([{ name: "create_card", arguments: { kind: "note", fields: {} } }]);
    expect(note.kind).toBe("invalid");
    expect(note.issues[0]!.message).toContain("便笺");
  });

  it("create_chart builds a ChartCard from the user's numbers", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "chart", fields: {
      chartKind: "bar", points: [{ x: "周一", y: 12 }, { x: "周二", y: 8 }],
    } } }], canvas(), "把这几个数做成柱状图：周一 12，周二 8");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["ChartCard"]);
    expect(result.routes).toEqual(["generate"]);
  });

  it("create_notification builds a NotificationCard", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "notification", fields: {
      title: "交材料", body: "明天九点交材料",
    } } }], canvas(), "给我发一条通知卡：明天九点交材料，级别重要");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NotificationCard"]);
  });

  it("create_countdown refuses a duration the user never said", async () => {
    const asked = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 5 } } }], canvas(), "设个倒计时");
    expect(asked.kind).toBe("invalid");
    expect(asked.issues[0]!.message).toContain("多长时间");
    const grounded = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 5 } } }], canvas(), "设个5分钟倒计时");
    expect(grounded.kind).toBe("envelope");
  });

  it("clarify asks one question and never touches the canvas", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "other", question: "倒计时设多长时间？" } }]);
    expect(result.kind).toBe("clarify");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.message).toBe("倒计时设多长时间？");
    expect(result.issues).toEqual([]);
  });

  it("chat means no card at all", async () => {
    const result = await plan([{ name: "chat", arguments: {} }]);
    expect(result.kind).toBe("chat");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["chat"]);
  });
});

describe("multi-card batches", () => {
  const cases: Array<[string, ToolCall[], string[]]> = [
    ["note + countdown", [
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
      { name: "create_card", arguments: { kind: "countdown", fields: { minutes: 50 } } },
    ], ["NoteCard", "CountdownCard"]],
    ["todo + note", [
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶"] } } },
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
    ], ["TodoCard", "NoteCard"]],
    ["note + todo + countdown", [
      { name: "create_card", arguments: { kind: "note", fields: { text: "交周报" } } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["买菜"] } } },
      { name: "create_card", arguments: { kind: "countdown", fields: { minutes: 25 } } },
    ], ["NoteCard", "TodoCard", "CountdownCard"]],
    ["numbered three items (countdown + 2 schedules)", [
      { name: "create_card", arguments: { kind: "countdown", fields: { minutes: 30 } } },
      { name: "create_card", arguments: { kind: "schedule", fields: { title: "健身", day: "周四", time: "下午" } } },
      { name: "create_card", arguments: { kind: "schedule", fields: { title: "开会", day: "周四", time: "上午9点" } } },
    ], ["CountdownCard", "WeeklyScheduleCard", "WeeklyScheduleCard"]],
  ];

  it.each(cases)("%s builds every card, one camera move, no stray focus", async (_label, calls, cardTypes) => {
    const result = await plan(calls);
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(cardTypes);
    expect(cardsOf(result).map(action => action.card.type)).toEqual(cardTypes);
    // Order follows the user's order, never the contract registry's order.
    expect(result.created.map(item => item.tool)).toEqual(calls.map(call => call.name));

    const batch = envelope(result);
    expect(batch.actions.filter(action => action.type === "canvas.fit")).toHaveLength(1);
    expect(batch.actions.filter(action => action.type === "card.focus")).toHaveLength(0);
    // One awaken at most, and this canvas is already awake.
    expect(batch.actions.filter(action => action.type === "stage.awaken")).toHaveLength(0);

    // Cards are placed on distinct slots so auto-layout never stacks them.
    const layouts = cardsOf(result).map(action => action.card.layout);
    expect(new Set(layouts.map(layout => `${layout.x},${layout.y}`)).size).toBe(layouts.length);
    expect(result.routes).toHaveLength(cardTypes.length);
  });

  it("keeps an explicit focus on the new card in a single-create batch", async () => {
    const result = await plan([
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶"] } } },
      { name: "view", arguments: { mode: "focus", card_id: "todo_week" } },
    ], canvas(), "建个待办买牛奶，再打开本周待办");
    expect(result.kind).toBe("envelope");
    // The new card is focused by its builder; the explicit focus keeps its own
    // target too, one focus per card.
    expect(focusIds(result)).toContain(result.created[0]!.id);
    expect(focusIds(result)).toContain("todo_week");
    envelope(result);
  });
});

/** Two lists whose entries decide the target: "买牛奶" only lives in 本周待办. */
const listCanvas = (): CanvasContext => ({
  canvasId: "TEST-tool-lists",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  timeZone: "Asia/Shanghai",
  cards: [
    {
      id: "todo_week",
      type: "TodoCard",
      aliases: ["本周待办"],
      displayProps: { title: "本周待办", items: [
        { id: "item-1", text: "交周报", done: false },
        { id: "item-2", text: "买牛奶", done: false },
        { id: "item-3", text: "预约牙医", done: true },
      ] },
      sourceDataSummary: {},
      layout: { x: 0, y: 0, width: 288, height: 160 },
    },
    {
      id: "todo_shop",
      type: "TodoCard",
      aliases: ["购物清单"],
      displayProps: { title: "购物清单", items: [
        { id: "item-1", text: "鸡蛋", done: false },
        { id: "item-2", text: "洗衣液", done: false },
      ] },
      sourceDataSummary: {},
      layout: { x: 400, y: 0, width: 288, height: 160 },
    },
    {
      id: "note_meeting",
      type: "NoteCard",
      aliases: ["会议记录"],
      displayProps: { text: "周会纪要：确认发布窗口" },
      sourceDataSummary: {},
      layout: { x: 0, y: 200, width: 320, height: 120 },
    },
  ],
});
const listPlan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
  planFromToolCalls(calls, listCanvas(), NOW, utterance);
const todoItemsOf = (result: ToolCallPlan, cardId: string): Array<Record<string, unknown>> => {
  const update = result.actions.find(action => action.type === "card.update" && action.targetId === cardId);
  expect(update, JSON.stringify(result.actions)).toBeDefined();
  return ((update as Extract<Action, { type: "card.update" }>).displayProps as { items: Array<Record<string, unknown>> }).items;
};

describe("answer: a knowledge answer is a card, not just speech", () => {
  it("builds the answer contract's NewsCard from title/text/points", async () => {
    const result = await listPlan([{ name: "create_card", arguments: { kind: "answer", fields: {
      title: "宁德时代", text: "宁德时代是一家做动力电池的公司。", points: ["动力电池出货量第一", "总部在宁德"],
    } } }], "讲讲宁德时代是做什么的");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NewsCard"]);
    expect(result.routes).toEqual(["answer"]);
    const card = cardsOf(result)[0]!;
    expect(card.card.type).toBe("NewsCard");
    expect(propsOf(card)).toMatchObject({
      headline: "宁德时代", summary: "宁德时代是一家做动力电池的公司。",
      keyPoints: ["动力电池出货量第一", "总部在宁德"], summaryBy: "ai",
    });
    // The card comes from cards/answer.ts, never from a hand-built CardRecord.
    expect(sourceOf(card)).toMatchObject({ contract: "answer" });
    envelope(result);
  });

  it("derives the headline from the answer's own first clause when no title is given", async () => {
    const result = await listPlan([{ name: "create_card", arguments: { kind: "answer", fields: {
      text: "光合作用是植物把光能转成化学能的过程。它发生在叶绿体里。",
    } } }], "解释一下什么是光合作用");
    const card = cardsOf(result)[0]!;
    expect(propsOf(card).headline).toBe("光合作用是植物把光能转成化学能的过程");
    expect(propsOf(card)).not.toHaveProperty("keyPoints");
  });

  it("hands a missing answer body back to the model", async () => {
    const asked = await listPlan([{ name: "create_card", arguments: { kind: "answer", fields: {} } }], "介绍一下特斯拉");
    expect(asked.kind).toBe("invalid");
    expect(asked.issues[0]!.code).toBe("missing-param");
    expect(asked.actions).toEqual([]);
  });

  it("rejects an answer too long for the tool turn's token budget", async () => {
    // voice-first product: a 1-3 sentence card, never a truncated essay.
    const issues = invalid(await listPlan([{ name: "create_card", arguments: { kind: "answer", fields: { text: "长".repeat(241) } } }],
      "介绍一下特斯拉"));
    expect(issues).toContain("参数不合法");
  });

  it("answers and creates the promised card in one batch (sc-45)", async () => {
    const result = await listPlan([
      { name: "create_card", arguments: { kind: "answer", fields: { title: "特斯拉", text: "特斯拉是一家电动车公司。" } } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["研究特斯拉财报"] } } },
    ], "介绍一下特斯拉，顺便加个待办研究它的财报");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NewsCard", "TodoCard"]);
    expect(result.routes).toEqual(["answer", "todo"]);
    envelope(result);
  });
});

describe("create_todo: appending to an existing list", () => {
  it("appends to the named card and keeps every existing entry (sc-33)", async () => {
    const result = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_shop", items: ["酱油"] } } }],
      "购物清单里加上酱油");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    // One card.update, no second TodoCard.
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["edit"]);
    expect(todoItemsOf(result, "todo_shop")).toEqual([
      { id: "item-1", text: "鸡蛋", done: false },
      { id: "item-2", text: "洗衣液", done: false },
      { id: "item-3", text: "酱油", done: false },
    ]);
    envelope(result);
  });

  it("preserves a completed entry's done state while appending", async () => {
    const result = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_week", items: ["取快递"] } } }],
      "本周待办再加一条取快递");
    expect(todoItemsOf(result, "todo_week")).toEqual([
      { id: "item-1", text: "交周报", done: false },
      { id: "item-2", text: "买牛奶", done: false },
      { id: "item-3", text: "预约牙医", done: true },
      { id: "item-4", text: "取快递", done: false },
    ]);
  });

  it("recalls the named list instead of appending to it when card_id is missing", async () => {
    // The model picked the right tool but forgot card_id. The host used to append
    // to the list the sentence named — deciding a target the model never chose.
    // Now it hands the lists back (with their entries) and lets the model decide.
    const asked = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { items: ["酱油"] } } }], "购物清单里加上酱油");
    expect(asked.kind).toBe("invalid");
    expect(asked.actions).toEqual([]);
    expect(asked.created).toEqual([]);
    expect(asked.issues[0]!.code).toBe("missing-param");
    expect(asked.issues[0]!.message).toContain("购物清单");
    expect(asked.issues[0]!.hint).toContain("card_id");
    expect(asked.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
    // The numbered question is the fallback only when the repair cannot decide.
    expect(asked.message).toContain("购物清单");

    // The corrected call (card_id filled from the recalled candidates) appends.
    const fixed = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_shop", items: ["酱油"] } } }],
      "购物清单里加上酱油");
    expect(fixed.kind, fixed.issues.join(" | ")).toBe("envelope");
    expect(todoItemsOf(fixed, "todo_shop").map(item => item.text)).toEqual(["鸡蛋", "洗衣液", "酱油"]);
  });

  it("still creates a new list for a plain create", async () => {
    const result = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶"] } } }], "加个待办：买牛奶");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.actions.some(action => action.type === "card.update")).toBe(false);
  });

  it("keeps the model's list even when the sentence names another one", async () => {
    // The model picked todo_week; the sentence names 购物清单. The host no longer
    // swaps the target: the model's id is the decision, and the summary now shows
    // every list with its entries so it can pick right in the first place.
    const result = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_week", items: ["酱油"] } } }],
      "购物清单里加上酱油");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(todoItemsOf(result, "todo_week").map(item => item.text)).toEqual(["交周报", "买牛奶", "预约牙医", "酱油"]);
  });

  it("rejects an unknown card_id so the repair turn can fix it", async () => {
    const issues = invalid(await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_gone", items: ["酱油"] } } }],
      "再加一条酱油"));
    expect(issues).toContain("todo_gone");
  });

  it("rejects appending to a card that is not a todo list", async () => {
    const issues = invalid(await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "note_meeting", items: ["酱油"] } } }],
      "把酱油加到会议记录里"));
    expect(issues).toContain("只能操作 TodoCard");
  });

  it("refuses an append pick the sentence cannot back (ambiguous-target)", async () => {
    // Two lists answer to 待办 and nothing in the sentence proves which one, so
    // the model's card_id is a guess: the append path now uses the same
    // `cardFor` check as every other target instead of executing the first id.
    const asked = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_week", items: ["酱油"] } } }],
      "待办里加上酱油");
    expect(asked.kind).toBe("invalid");
    expect(asked.actions).toEqual([]);
    expect(asked.issues[0]!.code).toBe("ambiguous-target");
    expect(asked.issues[0]!.message).toContain("todo_week");
    expect(asked.issues[0]!.message).toContain("todo_shop");
    expect(asked.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
    // The repair turn can still append once the model picks one explicitly.
    const fixed = await listPlan([{ name: "create_card", arguments: { kind: "todo", fields: { card_id: "todo_week", items: ["酱油"] } } }],
      "把酱油加到本周待办");
    expect(fixed.kind, fixed.issues.join(" | ")).toBe("envelope");
    expect(todoItemsOf(fixed, "todo_week").map(item => item.text)).toEqual(["交周报", "买牛奶", "预约牙医", "酱油"]);
  });
});

describe("update_todo_item: entry-level edits, not a new card", () => {
  it("marks one entry done and keeps every other entry and done state", async () => {
    const result = await listPlan([{ name: "update_card", arguments: {
      card_id: "todo_week", item_id: "item-2", action: "done",
    } }], "把买牛奶标成完成");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["edit"]);
    expect(todoItemsOf(result, "todo_week")).toEqual([
      { id: "item-1", text: "交周报", done: false },
      { id: "item-2", text: "买牛奶", done: true },
      { id: "item-3", text: "预约牙医", done: true },
    ]);
  });

  it("resolves an entry from the sentence and removes it by text", async () => {
    const result = await listPlan([{ name: "update_card", arguments: {
      item_id: "买牛奶", action: "remove",
    } }], "把买牛奶那条删掉");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(todoItemsOf(result, "todo_week").map(item => item.text)).toEqual(["交周报", "预约牙医"]);
  });

  it("renames an entry through the todo contract", async () => {
    const result = await listPlan([{ name: "update_card", arguments: {
      card_id: "todo_shop", item_id: "item-1", action: "rename", text: "有机鸡蛋",
    } }]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(todoItemsOf(result, "todo_shop")).toEqual([
      { id: "item-1", text: "有机鸡蛋", done: false },
      { id: "item-2", text: "洗衣液", done: false },
    ]);
  });

  it("names the available entries when the requested one is not on the card", async () => {
    const issues = invalid(await listPlan([{ name: "update_card", arguments: {
      card_id: "todo_shop", item_id: "item-9", action: "done",
    } }]));
    expect(issues).toContain("item-9");
    expect(issues).toContain("鸡蛋");
    expect(issues).toContain("unknown-card");
  });

  it("refuses to remove the last entry instead of leaving an invalid card", async () => {
    const issues = invalid(await plan([{ name: "update_card", arguments: {
      card_id: "todo_week", item_id: "item-1", action: "remove",
    } }]));
    expect(issues).toContain("至少保留一条");
    expect(issues).toContain("delete_card");
  });
});

describe("highlight_card: entry-level highlight", () => {
  it("highlights one entry through the contract's itemId", async () => {
    const result = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week", item_id: "item-2" } }],
      "高亮买牛奶那条");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
  });

  it("keeps the model's card and hands that card's entries back (sc-30 is a recall)", async () => {
    // sc-30 used to let the host find 买牛奶 on 本周待办 and move the highlight
    // there, overriding the model's 购物清单. The model decides the card; an entry
    // it cannot satisfy on that card comes back as that card's entries, so the
    // model corrects itself (or the user is asked) — never a silent swap.
    const asked = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_shop" } }], "高亮一下买牛奶那条");
    expect(asked.kind).toBe("invalid");
    expect(asked.actions).toEqual([]);
    expect(asked.issues[0]!.code).toBe("unknown-card");
    expect(asked.issues[0]!.message).toContain("买牛奶");
    expect(asked.issues[0]!.message).toContain("鸡蛋(item-1)");
    expect(asked.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_shop"]);
    expect(asked.targetCandidates?.[0]?.items).toEqual(["鸡蛋(item-1)", "洗衣液(item-2)"]);

    // The corrected call with the entry and the card the model re-picked works.
    const fixed = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week", item_id: "item-2" } }],
      "高亮一下买牛奶那条");
    expect(envelope(fixed).actions).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
  });

  it("derives the entry from the user's words on the card the model chose", async () => {
    // card_id given, item_id omitted: the user's own entry words identify the
    // entry on that card (deterministic, allowed — the card is already decided).
    const result = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week" } }], "高亮买牛奶那条");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
  });

  it("accepts an entry's text in item_id and resolves it to the entry's id", async () => {
    const result = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week", item_id: "买牛奶" } }]);
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
  });

  it("rejects an item that is not on that card and names the available entries", async () => {
    const issues = invalid(await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_shop", item_id: "item-9" } }]));
    expect(issues).toContain("item-9");
    expect(issues).toContain("鸡蛋");
  });

  it("rejects entry-level highlight on a card without todo entries", async () => {
    const issues = invalid(await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "note_meeting", item_id: "item-1" } }]));
    expect(issues).toContain("只有待办卡片");
  });
});

/**
 * Two entries with the same words are a real choice. The old code matched the
 * first one by text and silently edited/highlighted it; now both ids go back to
 * the model, which must clarify instead of the host picking.
 */
describe("duplicate entry text: the host refuses to pick the first one", () => {
  const duplicateCanvas = (): CanvasContext => {
    const context = listCanvas();
    context.cards[0] = {
      ...context.cards[0]!,
      displayProps: { title: "本周待办", items: [
        { id: "item-1", text: "买牛奶", done: false },
        { id: "item-2", text: "买牛奶", done: true },
        { id: "item-3", text: "交周报", done: false },
      ] },
    };
    return context;
  };
  const duplicatePlan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
    planFromToolCalls(calls, duplicateCanvas(), NOW, utterance);

  it("refuses an update whose item_id is text shared by two entries", async () => {
    const asked = await duplicatePlan([{ name: "update_card", arguments: {
      card_id: "todo_week", item_id: "买牛奶", action: "done",
    } }], "把买牛奶标成完成");
    expect(asked.kind).toBe("invalid");
    expect(asked.actions).toEqual([]);
    expect(asked.issues[0]!.code).toBe("ambiguous-target");
    expect(asked.issues[0]!.message).toContain("item-1");
    expect(asked.issues[0]!.message).toContain("item-2");
    expect(asked.targetCandidates?.[0]?.items).toEqual(["买牛奶(item-1)", "买牛奶(item-2)"]);
  });

  it("refuses a highlight whose item_id is text shared by two entries", async () => {
    const asked = await duplicatePlan([{ name: "view", arguments: {
      mode: "highlight", card_id: "todo_week", item_id: "买牛奶",
    } }], "高亮买牛奶那条");
    expect(asked.kind).toBe("invalid");
    expect(asked.issues[0]!.code).toBe("ambiguous-target");
    expect(asked.issues[0]!.message).toContain("item-2");
  });

  it("still accepts the entry id, which is unique by contract", async () => {
    const result = await duplicatePlan([{ name: "update_card", arguments: {
      card_id: "todo_week", item_id: "item-2", action: "done",
    } }]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(todoItemsOf(result, "todo_week")).toEqual([
      { id: "item-1", text: "买牛奶", done: false },
      { id: "item-2", text: "买牛奶", done: true },
      { id: "item-3", text: "交周报", done: false },
    ]);
  });
});

describe("targeted tools: the model picks the card, the host recalls facts", () => {
  /**
   * The old contract re-matched the user's words against card names and let a
   * unique hit replace the model's id (sc-30), or asked a numbered question when
   * several matched (sc-56). Both made the model's decision meaningless. The host
   * now uses the model's id whenever it exists on the canvas — even when the
   * sentence names another card — and recalls candidates only for an id it cannot
   * resolve. This block is the regression pin for that reversal.
   */
  it("keeps the model's id even when the sentence names another card", async () => {
    const result = await listPlan([{ name: "view", arguments: { mode: "focus", card_id: "todo_week" } }], "聚焦购物清单");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "todo_week" }]);
  });

  it("refuses to execute a pick the sentence cannot back (sc-56)", async () => {
    // 「聚焦待办」 can only mean one of the two TodoCards, and nothing in it
    // proves which. The model's id would be a coin flip, so the host hands both
    // real candidates back and the *model* clarifies — the host never picks.
    const result = await listPlan([{ name: "view", arguments: { mode: "focus", card_id: "todo_week" } }], "聚焦待办");
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.issues[0]!.code).toBe("ambiguous-target");
    expect(result.issues[0]!.hint).toContain("clarify(missing=\"target\")");
    expect(result.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
    // The fallback question names the cards, never their ids.
    expect(result.message).toContain("1. 本周待办");
    expect(result.message).toContain("2. 购物清单");
    expect(result.message).not.toContain("todo_week");
  });

  it("recalls up to five real cards when the model's id is not on the canvas", async () => {
    const asked = await listPlan([{ name: "view", arguments: { mode: "focus", card_id: "todo_gone" } }], "聚焦待办");
    expect(asked.kind).toBe("invalid");
    expect(asked.actions).toEqual([]);
    expect(asked.created).toEqual([]);
    expect(asked.issues[0]!.code).toBe("unknown-card");
    expect(asked.issues[0]!.message).toContain("todo_gone");
    // The repair turn reads the issue text, so the real ids are named there too.
    expect(asked.issues[0]!.message).toContain("本周待办(todo_week)");
    expect(asked.issues[0]!.hint).toContain("card_id");
    expect(asked.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop", "note_meeting"]);
    expect(asked.targetCandidates?.map(candidate => candidate.title)).toEqual(["本周待办", "购物清单", "周会纪要：确认发布窗口"]);
    // The entries travel with their ids, so the model can name an item too.
    expect(asked.targetCandidates?.[0]?.items).toContain("交周报(item-1)");
    expect(asked.targetCandidates?.every(candidate => candidate.id !== candidate.title)).toBe(true);
    expect(asked.targetCandidates!.length).toBeLessThanOrEqual(5);
    // The numbered question is only the fallback when the repair cannot decide.
    expect(asked.message).toContain("1. 本周待办");
    expect(asked.message).not.toContain("todo_week");
  });

  it("recalls only the cards of the type the tool needs", async () => {
    const asked = await listPlan([{ name: "update_card", arguments: {
      card_id: "note_meeting", item_id: "交周报", action: "done",
    } }]);
    expect(asked.kind).toBe("invalid");
    expect(asked.issues[0]!.code).toBe("invalid-param");
    expect(asked.issues[0]!.message).toContain("TodoCard");
    expect(asked.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
  });

  it("keeps a model-chosen delete target and still only proposes it", async () => {
    const result = await listPlan([{ name: "delete_card", arguments: { card_id: "todo_week" } }], "删除购物清单");
    expect(result.kind).toBe("envelope");
    // The pipeline's confirmation gate stays the only way a delete runs.
    expect(envelope(result).actions).toEqual([{ type: "card.delete", targetId: "todo_week" }]);
  });

  it("keeps the model's id when the words name no card at all", async () => {
    const result = await listPlan([{ name: "delete_card", arguments: { card_id: "todo_shop" } }]);
    expect(envelope(result).actions).toEqual([{ type: "card.delete", targetId: "todo_shop" }]);
  });

  it("keeps the model's target for a title edit and for an arrange", async () => {
    const renamed = await listPlan([{ name: "update_card", arguments: {
      card_id: "todo_week", action: "set_title", title: "买东西",
    } }], "把购物清单改名为买东西");
    expect(renamed.kind, renamed.issues.join(" | ")).toBe("envelope");
    expect(envelope(renamed).actions).toEqual([
      { type: "card.update", targetId: "todo_week", displayProps: { title: "买东西" } },
    ]);
    const pinned = await listPlan([{ name: "arrange", arguments: { target: "todo_week", position: "pin" } }],
      "把购物清单固定住");
    expect(pinned.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: true });
  });
});

/**
 * sc-56 / sc-59: the sentence itself points at two or more real cards and holds
 * no unique evidence, so the model's `card_id` is a guess between them. The host
 * validates instead of deciding — it refuses the guess, returns the real
 * candidates, and the model clarifies. The evidence list (id / unique title /
 * unique entry / pointer + focus / direction) only ever *permits* the model's
 * pick; it never replaces it.
 */
describe("ambiguous picks: the host refuses a guess, never chooses", () => {
  /** listCanvas + a translated-name card and one focused note (sc-15's shape). */
  const googleCanvas = (): CanvasContext => {
    const context = listCanvas();
    context.focusHistory = ["note_meeting"];
    context.cards.push({
      id: "answer_google", type: "NewsCard", aliases: [],
      displayProps: { headline: "Google 公司介绍", summary: "一段摘要", summaryBy: "ai" },
      sourceDataSummary: {}, layout: { x: 800, y: 0, width: 320, height: 200 },
    });
    return context;
  };
  const googlePlan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
    planFromToolCalls(calls, googleCanvas(), NOW, utterance);

  it("lets the model's id stand when only one card holds the entry it named", async () => {
    const result = await listPlan([{ name: "view", arguments: { mode: "highlight", card_id: "todo_week", item_id: "item-2" } }],
      "高亮买牛奶那条");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.highlight", targetId: "todo_week", itemId: "item-2" }]);
  });

  it("treats a unique title as evidence, not as an order to swap the card", async () => {
    // 购物清单 is named, and the model's todo_week still wins: evidence proves the
    // sentence is answerable, it is not a second voter.
    const result = await listPlan([{ name: "arrange", arguments: { target: "todo_week", position: "pin" } }], "把购物清单固定住");
    expect(result.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: true });
  });

  it("lets it stand when a pointer has a focus (这张谷歌的卡片)", async () => {
    const result = await googlePlan([{ name: "view", arguments: { mode: "focus", card_id: "note_meeting" } }],
      "这张谷歌的卡片讲了什么");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "note_meeting" }]);
  });

  it("counts an id the user typed as proof of that card", async () => {
    const result = await listPlan([{ name: "view", arguments: { mode: "focus", card_id: "todo_week" } }],
      "聚焦 todo_week 这张待办");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "todo_week" }]);
  });

  it("counts an ordinal as a pick, so 第N张 is not a type-wide guess", async () => {
    // 「第2张待办」 names one card by number; the type word matching two lists is
    // not an ambiguity, otherwise find_cards' whole ordinal flow would break.
    const result = await listPlan([{ name: "view", arguments: { mode: "focus", card_id: "todo_shop" } }],
      "聚焦第2张待办");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(envelope(result).actions).toEqual([{ type: "card.focus", targetId: "todo_shop" }]);
  });

  it("keeps today's behaviour when the sentence names no card at all", async () => {
    // A pointer with nothing focused names nothing: there is no second card to be
    // ambiguous about, so the model's id stands (the host never fabricates a
    // candidate list out of "every card that is left").
    const context = listCanvas();
    context.focusHistory = [];
    const result = await planFromToolCalls([{ name: "arrange", arguments: { target: "todo_shop", position: "left" } }],
      context, NOW, "把它往左移");
    expect(result.hostOperation).toEqual({ kind: "card.move", targetId: "todo_shop", direction: "left" });
  });

  it("refuses the same guess for a transfer (sc-59)", async () => {
    const result = await listPlan([{ name: "arrange", arguments: { target: "todo_week", surface: "user" } }],
      "把待办传到用户页，我要编辑");
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("ambiguous-target");
    expect(result.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
  });

  it("refuses it for an update and a delete too", async () => {
    const updated = await listPlan([{ name: "update_card", arguments: {
      card_id: "todo_week", action: "set_title", title: "周末清单",
    } }], "把待办的标题改成周末清单");
    expect(updated.kind).toBe("invalid");
    expect(updated.issues[0]!.code).toBe("ambiguous-target");
    const deleted = await listPlan([{ name: "delete_card", arguments: { card_id: "todo_shop" } }], "把待办删掉");
    expect(deleted.kind).toBe("invalid");
    expect(deleted.issues[0]!.code).toBe("ambiguous-target");
    expect(deleted.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
  });
});

/**
 * `arrange(target, surface?)` is the tool entry for the contract's existing
 * `card.surface`: 用户页 / 展示页 already exist in the HostOperation schema and in
 * the canvas, only the tool surface never offered them — so the model could only
 * answer "做不到".
 */
describe("arrange: send a card to the user page or the display page", () => {
  const send = (args: Record<string, unknown>, utterance = "", ctx: CanvasContext = listCanvas()): Promise<ToolCallPlan> =>
    planFromToolCalls([{ name: "arrange", arguments: args }], ctx, NOW, utterance);

  it("maps surface=display onto the existing card.surface host operation", async () => {
    const focused = listCanvas();
    focused.focusHistory = ["todo_week"];
    const result = await send({ target: "todo_week", surface: "display" }, "把这张卡传到展示页", focused);
    expect(result.kind, result.issues.join(" | ")).toBe("host-operation");
    expect(result.hostOperation).toEqual({ kind: "card.surface", targetId: "todo_week", surface: "display" });
    expect(result.actions).toEqual([]);
    expect(result.routes).toEqual(["arrange"]);
    // The same confirmation the contract already has for this operation.
    expect(result.message).toBe("已送到展示页");
  });

  it("sends the card back to the user page", async () => {
    const result = await send({ target: "todo_shop", surface: "user" }, "把购物清单放回用户页");
    expect(result.hostOperation).toEqual({ kind: "card.surface", targetId: "todo_shop", surface: "user" });
    expect(result.message).toBe("已切到用户页");
  });

  it("needs no focus when the sentence names no card", async () => {
    const result = await send({ target: "todo_shop", surface: "display" });
    expect(result.hostOperation).toEqual({ kind: "card.surface", targetId: "todo_shop", surface: "display" });
  });

  it("still moves and pins a card with position", async () => {
    const pinned = await send({ target: "todo_shop", position: "pin" });
    expect(pinned.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_shop", pinned: true });
    const moved = await send({ target: "todo_shop", position: "down" });
    expect(moved.hostOperation).toEqual({ kind: "card.move", targetId: "todo_shop", direction: "down" });
  });

  it("refuses to move a pinned card instead of promising a move the canvas rejects", async () => {
    const context = listCanvas();
    context.cards[0] = { ...context.cards[0]!, layout: { ...context.cards[0]!.layout, pinned: true } };
    const refused = await planFromToolCalls([{ name: "arrange", arguments: { target: "todo_week", position: "left" } }],
      context, NOW, "把本周待办往左移");
    expect(refused.kind).toBe("invalid");
    expect(refused.hostOperation).toBeUndefined();
    expect(refused.issues[0]!.code).toBe("invalid-param");
    expect(refused.issues[0]!.message).toContain("已固定");
    expect(refused.issues[0]!.hint).toContain("unpin");
    // Unpinning is still allowed and is the repair the model should take.
    const unpinned = await planFromToolCalls([{ name: "arrange", arguments: { target: "todo_week", position: "unpin" } }],
      context, NOW, "把本周待办取消固定");
    expect(unpinned.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: false });
  });

  it("refuses position and surface in one call", async () => {
    const result = await send({ target: "todo_week", position: "pin", surface: "display" });
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("invalid-param");
    expect(result.issues[0]!.message).toContain("position 与 surface");
    expect(result.hostOperation).toBeUndefined();
  });

  it("refuses surface for the whole canvas and asks for one of the two", async () => {
    const canvasWide = await send({ target: "canvas", surface: "display" });
    expect(canvasWide.kind).toBe("invalid");
    expect(canvasWide.issues[0]!.message).toContain("target=canvas 不接受 surface");
    const bare = await send({ target: "todo_week" });
    expect(bare.kind).toBe("invalid");
    expect(bare.issues[0]!.code).toBe("missing-param");
    expect(bare.issues[0]!.message).toContain("surface");
  });

  it("refuses a surface value outside the two pages", async () => {
    const result = await send({ target: "todo_week", surface: "control" });
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("invalid-param");
  });

  it("keeps the tool description, catalog, prompt and feedback in sync", () => {
    const definition = TOOL_DEFINITIONS.find(item => item.function.name === "arrange")!;
    const properties = (definition.function.parameters as { properties: Record<string, { enum?: string[] }> }).properties;
    expect(properties.surface?.enum).toEqual(["user", "display"]);
    for (const section of ["做什么：", "输入：", "展示页", "传送"]) expect(definition.function.description).toContain(section);
    expect(TOOL_CATALOG.find(capability => capability.name === "arrange")?.actions)
      .toEqual(["pin", "unpin", "left", "right", "up", "down", "canvas", "surface:user", "surface:display"]);
    expect(toolFeedbackPhrase("arrange")).not.toBe("我正在处理");
    // The model has to be told the capability exists and that it is not a focus.
    const prompt = buildToolSystemPrompt(listCanvas());
    expect(prompt).toContain("surface=\"display\"");
    expect(prompt).toContain("传送不是聚焦");
  });
});

describe("weather: the model picks the day, the host does the calendar", () => {
  // The fixed clock is Sunday 2026-11-01 in Shanghai: 今天 11-01, 明天 11-02,
  // 后天 11-03, 下周一 11-02, 本周三 11-04, and everything past 11-07 is outside
  // the seven-day window. The verified adapter currently serves today/tomorrow.
  const weatherOf = async (args: Record<string, unknown>, utterance = ""): Promise<ToolCallPlan> =>
    plan([{ name: "weather", arguments: args }], canvas(), utterance);

  it("keeps today as the adapter default and sends 明天 as tomorrow", async () => {
    const today = await weatherOf({ city: "南京" });
    expect(today.kind).toBe("lookup");
    expect(today.lookup).toEqual({ kind: "weather", city: "南京" });
    expect((await weatherOf({ city: "南京", day: "今天" })).lookup).toEqual({ kind: "weather", city: "南京" });
    expect((await weatherOf({ city: "南京", day: "明天" })).lookup).toEqual({ kind: "weather", city: "南京", day: 1 });
    // An English day word is accepted too: the tool schema is no longer an enum.
    expect((await weatherOf({ city: "南京", day: "tomorrow" })).lookup).toEqual({ kind: "weather", city: "南京", day: 1 });
  });

  it("derives the user's own 明天 for a lone weather question", async () => {
    const result = await weatherOf({ city: "南京" }, "明天南京要穿外套吗");
    expect(result.lookup).toEqual({ kind: "weather", city: "南京", day: 1 });
    // A query must stand alone: the result reaches the model in the next turn, so
    // it cannot share the batch with a tool that would consume it.
    const mixed = await plan([{ name: "weather", arguments: { city: "南京" } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["带外套"] } } }], canvas(), "明天南京要穿外套吗，顺便记个待办");
    expect(mixed.kind).toBe("invalid");
    expect(String(mixed.issues[0])).toContain("必须单独调用");
  });

  it("resolves 后天 / 周X / MM-DD inside the window instead of guessing", async () => {
    // 后天 / 下周三 / 11-04 are all inside the seven days: the model picks the day
    // and the verified adapter serves that row (no separate two-day outlet).
    expect((await weatherOf({ city: "南京", day: "后天" })).lookup).toEqual({ kind: "weather", city: "南京", day: 2 });
    expect((await weatherOf({ city: "南京", day: "下周三" })).lookup).toEqual({ kind: "weather", city: "南京", day: 3 });
    expect((await weatherOf({ city: "南京", day: "11-04" })).lookup).toEqual({ kind: "weather", city: "南京", day: 3 });
    // 本周三 already passed (10-28): outside the window, not a silent "today".
    const thisWednesday = await weatherOf({ city: "南京", day: "本周三" });
    expect(thisWednesday.issues[0]!.code).toBe("invalid-param");
    expect(thisWednesday.issues[0]!.message).toContain("2026-10-28");
  });

  it("maps next week's Monday onto tomorrow (still one of the seven days)", async () => {
    // 下周一 is 11-02 here, i.e. tomorrow: the day words are calendar facts, and
    // the host resolves them inside the window.
    expect((await weatherOf({ city: "南京", day: "下周一" })).lookup)
      .toEqual({ kind: "weather", city: "南京", day: 1 });
    expect((await weatherOf({ city: "南京", day: "11-02" })).lookup)
      .toEqual({ kind: "weather", city: "南京", day: 1 });
  });

  it("refuses a day outside the seven-day window with the window hint", async () => {
    const far = await weatherOf({ city: "南京", day: "12-25" });
    expect(far.kind).toBe("invalid");
    expect(far.issues[0]!.code).toBe("invalid-param");
    expect(far.issues[0]!.hint).toContain("未来 7 天");
    // Yesterday is outside the window too: the adapter has no history at all.
    const past = await weatherOf({ city: "南京", day: "昨天" });
    expect(past.kind).toBe("invalid");
    expect(past.issues[0]!.code).toBe("invalid-param");
    expect(past.issues[0]!.message).toContain("不在未来 7 天内");
  });

  it("refuses a day word it cannot read instead of pretending it is today", async () => {
    const nonsense = await weatherOf({ city: "南京", day: "情人节" });
    expect(nonsense.kind).toBe("invalid");
    expect(nonsense.issues[0]!.code).toBe("invalid-param");
    expect(nonsense.issues[0]!.hint).toContain("今天/明天/后天");
  });

  it("states the range in the tool description and the prompt", () => {
    const description = TOOL_DEFINITIONS.find(item => item.function.name === "weather")!.function.description;
    expect(description).toContain("未来 7 天");
    expect(description).toContain("今天/明天/后天/周X/下周X");
    expect(description).toContain("create_card(kind=\"weather\")");
    const prompt = buildToolSystemPrompt(canvas());
    expect(prompt).toContain("范围是未来 7 天");
    // The query is read-only: facts are fed back, the model decides the output.
    expect(prompt).toContain("查询工具（search / weather / read_url / metal_price）只读");
    expect(prompt).toContain("要直接回答就用 chat(reply=…)");
    expect(prompt).toContain("查询之后（宿主已把事实回灌，是否展示、如何回答由你决定）");
  });
});

describe("structured issues: code + message + concrete hint", () => {
  it("tags an invalid argument and says what to change", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 0 } } }]);
    expect(result.kind).toBe("invalid");
    const issue = result.issues[0]!;
    expect(issue.code).toBe("invalid-param");
    expect(issue.message).toContain("参数不合法");
    expect(issue.hint).toContain("取值范围");
    // The legacy one-line form still carries both halves.
    expect(formatIssues(result.issues)).toContain("[invalid-param]");
    expect(formatIssues(result.issues)).toContain("下一步");
  });

  it("tags a missing canvas target as unknown-card and offers real cards", async () => {
    const result = await plan([{ name: "view", arguments: { mode: "focus", card_id: "note_missing" } }]);
    expect(result.issues[0]!.code).toBe("unknown-card");
    expect(result.issues[0]!.hint).toContain("card_id");
    // The candidates are readable in the issue text, which is what the repair
    // turn actually carries; `targetCandidates` is the structured copy.
    expect(result.issues[0]!.message).toContain("周会纪要：确认发布窗口(note_meeting)");
    expect(result.targetCandidates?.length).toBeGreaterThan(0);
    expect(result.targetCandidates?.every(candidate => candidate.title.length > 0)).toBe(true);
  });

  it("caps the fallback candidates at five", async () => {
    const many = canvas();
    many.cards = Array.from({ length: 8 }, (_, index) => ({
      id: `note_${index}`, type: "NoteCard", aliases: [`便笺${index}`],
      displayProps: { text: `内容${index}` }, sourceDataSummary: {},
      layout: { x: index * 340, y: 0, width: 320, height: 120 },
    }));
    const result = await plan([{ name: "view", arguments: { mode: "focus", card_id: "note_missing" } }], many);
    expect(result.issues[0]!.code).toBe("unknown-card");
    expect(result.targetCandidates).toHaveLength(5);
  });

  it("tags a wrong tool for the card as unsupported", async () => {
    const result = await plan([{ name: "update_card", arguments: {
      card_id: "note_meeting", action: "pause_countdown",
    } }]);
    expect(result.issues[0]!.code).toBe("unsupported");
    expect(result.issues[0]!.hint).toContain("action=done");
  });

  it("tags a grounding failure as ungrounded with the scene's field hint", async () => {
    const result = await plan([{ name: "create_card", arguments: { kind: "scene", fields: {
      scene_id: "habit_tracking", data: { habit: "背单词", checkins: ["2026-11-02"] },
    } } }], canvas(), "习惯打卡：每天背单词");
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("ungrounded");
    expect(result.issues[0]!.message).toContain("2026-11-02");
    expect(result.issues[0]!.hint).toContain("用户原话");
  });

  it("keeps the legacy text form readable through String() and formatIssues()", async () => {
    const result = await plan([{ name: "unknown_tool", arguments: {} }]);
    const issue = result.issues[0]!;
    expect(String(issue)).toBe(formatIssues([issue]));
    expect(String(issue)).toContain("未知工具");
    expect(formatIssues(["遗留字符串", issue])).toContain("遗留字符串");
  });
});

describe("unsupported: an honest text answer, never a card", () => {
  it("returns the model's explanation as a subtitle and creates nothing", async () => {
    const result = await listPlan([{ name: "unsupported", arguments: { reply: "我没法替你打电话，只能帮你设个提醒。" } }],
      "给张三打个电话");
    expect(result.kind).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.routes).toEqual(["unsupported"]);
    expect(result.actions).toEqual([{ type: "subtitle.show", text: "我没法替你打电话，只能帮你设个提醒。", durationMs: 12000 }]);
    expect(result.say).toBe("我没法替你打电话，只能帮你设个提醒。");
    envelope(result);
  });

  it("has an honest fallback line when the model gives none", async () => {
    const result = await listPlan([{ name: "unsupported", arguments: {} }], "帮我在淘宝下单");
    expect(result.actions).toEqual([{ type: "subtitle.show", text: expect.stringContaining("做不到"), durationMs: 12000 }]);
    expect(result.created).toEqual([]);
    // Never a fake completion.
    expect(result.say).not.toMatch(/已下单|已完成|已记账/);
  });

  it("can ride along with a card the same sentence asked for", async () => {
    const result = await listPlan([
      { name: "unsupported", arguments: { reply: "我没法替你打电话。" } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["提醒张三回电"] } } },
    ], "给张三打个电话，顺便记个待办提醒他回电");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.actions.some(action => action.type === "subtitle.show")).toBe(true);
  });
});

describe("invalid and boundary batches", () => {
  it("lets clarify ride with a create: the decided card is built and the question is spoken", async () => {
    // sc-52's old fork: clarify was exclusive, so the model could either ask
    // about the missing duration (dropping the note) or build the note (dropping
    // the countdown silently). A batch may now carry both: the decided half is
    // executed and the missing fact is one subtitle, never a second card.
    const result = await plan([
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
      { name: "clarify", arguments: { missing: "time", question: "倒计时设多长时间？" } },
    ], canvas(), "帮我记个便签明天交周报，然后设一个倒计时");
    expect(result.kind, JSON.stringify(result.issues)).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["NoteCard"]);
    expect(result.missing).toBe("time");
    expect(result.say).toBe("倒计时设多长时间？");
    expect(result.actions.filter(action => action.type === "subtitle.show"))
      .toEqual([{ type: "subtitle.show", text: "倒计时设多长时间？", durationMs: 12000 }]);
    // No card was built for the question itself.
    expect(result.created).toHaveLength(1);
    envelope(result);
  });

  it("keeps a lone clarify a plain question with no canvas action", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "time", question: "倒计时设多长时间？" } }],
      canvas(), "设一个倒计时");
    expect(result.kind).toBe("clarify");
    expect(result.actions).toEqual([]);
    expect(result.created).toEqual([]);
    expect(result.message).toBe("倒计时设多长时间？");
  });

  it("rejects two clarify calls in one batch", async () => {
    const issues = invalid(await plan([
      { name: "clarify", arguments: { missing: "time", question: "多久？" } },
      { name: "clarify", arguments: { missing: "content", question: "记什么？" } },
    ]));
    expect(issues).toContain("一次只能问一个问题");
  });

  it("allows chat beside a create: the chat clause never vetoes the card", async () => {
    // sc-45's old dead end: chat was exclusive, so an answer plus a card could
    // only ever return one of the two. The batch keeps the card and the chat
    // call contributes no action of its own.
    const result = await plan([
      { name: "chat", arguments: {} },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶"] } } },
    ], canvas(), "寒暄一句，再加个待办：买牛奶");
    expect(result.kind).toBe("envelope");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.routes).toEqual(["todo"]);
    expect(envelope(result).actions.filter(action => action.type !== "card.create" && action.type !== "card.focus")).toEqual([]);
  });

describe("the action receipt", () => {
  /**
   * The regression this pins: the host used to be the only voice for an action
   * batch, so "已创建 N 张卡片，请查看。" became the default spoken line
   * (34/60 in the local 60 instead of 57/60). An action without the model's own
   * sentence is now an `invalid` plan (`missing-say`) that spends the existing
   * one repair turn; only the turn after that falls back to the host's line.
   * These cases call the raw mapper: the `plan` helper above runs in
   * `sayFallback` mode on purpose.
   */
  const note = { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } };

  it("turns a question-shaped unsupported reply into a clear question", async () => {
    // sc-58: 模型用 unsupported 说“要我聚焦它吗？”，形态上就是一次澄清。
    const result = await planToolCalls(
      [{ name: "unsupported", arguments: { reply: "画布上还没找到日程卡，要我建一张吗？" } }],
      canvas(), NOW, "聚焦一下日程卡");
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("要我建一张吗");
    const statements = await planToolCalls(
      [{ name: "unsupported", arguments: { reply: "这个能力暂时做不了。" } }],
      canvas(), NOW, "帮我转账");
    expect(statements.kind).toBe("envelope");
  });

  it("keeps a silent action batch for the post-execution speaking turn", async () => {
    // act → observe → speak: the action is committed now, the sentence comes
    // from one more model turn whose input is the execution receipt.
    const result = await planToolCalls([note], canvas(), NOW, "记个便签明天交周报");
    expect(result.kind).toBe("envelope");
    expect(result.actions.map(action => action.type)).toEqual(["card.create", "card.focus"]);
    expect(result.receiptPending).toBe(true);
    expect(result.say).toBeUndefined();
    expect(result.sayFallback).toBeUndefined();
  });

  it("commits the same batch once the model writes its own line", async () => {
    const result = await planToolCalls([note, { name: "chat", arguments: { reply: "记好了：明天交周报。" } }],
      canvas(), NOW, "记个便签明天交周报");
    expect(result.kind, JSON.stringify(result.issues)).toBe("envelope");
    expect(result.say).toBe("记好了：明天交周报。");
    // The receipt is speech, not a second canvas action, and no host template
    // about how many cards exist ever reaches the user.
    expect(result.actions.map(action => action.type)).toEqual(["card.create", "card.focus"]);
    expect(result.sayFallback).toBeUndefined();
  });

  it("requires it for arrange/history too, and keeps the model's own line", async () => {
    const bare = await planToolCalls([{ name: "history", arguments: { action: "undo" } }], canvas(), NOW, "撤销");
    expect(bare.kind).toBe("host-operation");
    expect(bare.receiptPending).toBe(true);
    expect(bare.message).toBeUndefined();
    const spoken = await planToolCalls([{ name: "history", arguments: { action: "undo" } },
      { name: "chat", arguments: { reply: "撤销了刚才那一步。" } }], canvas(), NOW, "撤销");
    expect(spoken.kind).toBe("host-operation");
    expect(spoken.message).toBe("撤销了刚才那一步。");
  });

  it("requires it for focus/highlight, but not for a camera-only fit/restore", async () => {
    const focus = await planToolCalls([{ name: "view", arguments: { mode: "focus", card_id: "note_meeting" } }],
      canvas(), NOW, "打开会议记录");
    expect(focus.kind).toBe("envelope");
    expect(focus.receiptPending).toBe(true);
    expect(focus.actions.some(action => action.type === "card.focus")).toBe(true);
    const fit = await planToolCalls([{ name: "view", arguments: { mode: "fit" } }], canvas(), NOW, "显示全部");
    expect(fit.kind).toBe("envelope");
    expect(fit.say).toBe("已显示全部卡片");
  });

  it("uses the host's own line only after the repair chance, and flags it", async () => {
    const result = await planToolCalls([note], canvas(), NOW, "记个便签明天交周报", { sayFallback: true });
    expect(result.kind).toBe("envelope");
    expect(result.sayFallback).toBe(true);
    expect(result.say).toBe("卡片已经放到画布上了。");
    expect(result.say).not.toContain("已创建");
  });

  it("never lets a receipt excuse a dropped clause", async () => {
    const result = await planToolCalls([note, { name: "chat", arguments: { reply: "好了" } }],
      canvas(), NOW, "帮我记个便签明天交周报，然后设一个倒计时");
    expect(result.kind).toBe("invalid");
    expect(result.issues[0]!.code).toBe("dropped-clause");
  });

  it("leaves a pure chat or a pure clarify alone", async () => {
    const chat = await planToolCalls([{ name: "chat", arguments: { reply: "你好。" } }], canvas(), NOW, "你好");
    expect(chat.kind).toBe("envelope");
    expect(chat.issues).toEqual([]);
    const ask = await planToolCalls([{ name: "clarify", arguments: { missing: "time", question: "多久？" } }],
      canvas(), NOW, "设一个倒计时");
    expect(ask.kind).toBe("clarify");
    expect(ask.issues).toEqual([]);
  });
});

  it("rejects an unknown tool name", async () => {
    const issues = invalid(await plan([{ name: "unknown_tool", arguments: { card_id: "note_meeting" } }]));
    expect(issues).toContain("未知工具");
  });

  it("rejects focus_card pointing at a card that is not on the canvas", async () => {
    const issues = invalid(await plan([{ name: "view", arguments: { mode: "focus", card_id: "note_missing" } }]));
    expect(issues).toContain("note_missing");
  });

  it.each([0, -5])("rejects create_countdown minutes=%s", async minutes => {
    const issues = invalid(await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes } } }]));
    expect(issues).toContain("参数不合法");
  });

  it("rejects a countdown longer than a day instead of clamping arbitrarily", async () => {
    invalid(await plan([{ name: "create_card", arguments: { kind: "countdown", fields: { minutes: 1441 } } }]));
  });

  it("rejects an empty call list", async () => {
    invalid(await plan([]));
  });

  it("hands a missing required argument back and rejects empty or invalid values", async () => {
    const note = await plan([{ name: "create_card", arguments: { kind: "note", fields: {} } }]);
    expect(note.kind).toBe("invalid");
    // A note's content is `text` or `sections`: neither key is individually
    // required, so an empty note is the violated "exactly one" rule, which is an
    // invalid argument the model must fill rather than a single missing key.
    expect(note.issues[0]!.code).toBe("invalid-param");
    expect(note.issues[0]!.message).toContain("便笺");
    invalid(await plan([{ name: "create_card", arguments: { kind: "todo", fields: { items: [] } } }]));
    invalid(await plan([{ name: "create_card", arguments: { kind: "weekly_plan", fields: { topic: "  " } } }]));
  });

  it("is all-or-nothing: one bad call discards the cards that would have built", async () => {
    const issues = invalid(await plan([
      { name: "create_card", arguments: { kind: "note", fields: { text: "明天交周报" } } },
      { name: "create_card", arguments: { kind: "countdown", fields: { minutes: 0 } } },
    ]));
    // The failing call is named by its position so the caller can log the turn.
    expect(issues).toContain("#2 create_card(countdown)");
  });
});

/**
 * One test per capability variant, written against the new entry points only:
 * the factory must cover every card kind, `update_card` every action,
 * `view` every mode, and the external tools keep their own semantics.
 */
describe("capability coverage: one entry per capability", () => {
  const CREATE_CASES: Array<[string, string, string, Record<string, unknown>, string]> = [
    ["countdown", "CountdownCard", "countdown", { minutes: 5 }, ""],
    ["todo", "TodoCard", "todo", { items: ["买牛奶"] }, ""],
    ["note", "NoteCard", "note", { text: "记一下周会结论" }, ""],
    ["weekly_plan", "WeeklyScheduleCard", "generate", { topic: "健身计划" }, ""],
    ["schedule", "WeeklyScheduleCard", "generate", { title: "开会", day: "周四", time: "上午9点" }, ""],
    ["template", "TodoCard", "generate", { template_id: "weekly_report", fields: { done: ["调研"] } }, ""],
    ["scene", "QuoteCard", "generate", { scene_id: "quote_note", data: { text: "慢慢来，比较快" } }, ""],
    ["chart", "ChartCard", "generate", { chartKind: "bar", points: [{ x: "周一", y: 3 }] }, "把周一3做成柱状图"],
    ["notification", "NotificationCard", "generate", { title: "交材料" }, ""],
    ["habit", "HabitHeatmapCard", "generate", { habit: "跑步", checkins: ["昨天"] }, "昨天跑步打卡了"],
    ["answer", "NewsCard", "answer", { text: "宁德时代是一家做动力电池的公司。" }, ""],
  ];

  it.each(CREATE_CASES)("create_card(kind=%s) builds exactly one %s", async (kind, cardType, route, fields, utterance) => {
    const result = await plan([{ name: "create_card", arguments: { kind, fields } }], canvas(), utterance);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created).toHaveLength(1);
    expect(result.created[0]!.cardType).toBe(cardType);
    expect(result.created[0]!.tool).toBe("create_card");
    expect(result.routes).toEqual([route]);
    envelope(result);
  });

  const UPDATE_CASES: Array<[string, Record<string, unknown>, string]> = [
    ["set_title", { card_id: "todo_week", action: "set_title", title: "周末待办" }, "card.update"],
    ["pause_countdown", { card_id: "countdown_tea", action: "pause_countdown" }, "countdown.pause"],
    ["resume_countdown", { card_id: "countdown_tea", action: "resume_countdown" }, "countdown.resume"],
    ["done", { card_id: "todo_week", action: "done", item_id: "item-1" }, "card.update"],
    ["undone", { card_id: "todo_week", action: "undone", item_id: "item-1" }, "card.update"],
    ["rename", { card_id: "todo_week", action: "rename", item_id: "item-1", text: "交月报" }, "card.update"],
    ["remove", { card_id: "todo_week", action: "remove", item_id: "item-1" }, "card.update"],
  ];

  it.each(UPDATE_CASES)("update_card(action=%s) produces one %s", async (_action, args, outcome) => {
    // Entry actions need a list that can spare the entry they remove.
    const context = ["done", "undone", "rename", "remove"].includes(String(args.action)) ? listCanvas() : canvas();
    const result = await plan([{ name: "update_card", arguments: args }], context);
    if (outcome.startsWith("countdown.")) {
      expect(result.kind).toBe("host-operation");
      expect(result.hostOperation?.kind).toBe(outcome);
      return;
    }
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.actions.map(action => action.type)).toEqual(["card.update"]);
    envelope(result);
  });

  it("update_card sets the title a card actually exposes", async () => {
    const result = await plan([{ name: "update_card", arguments: { card_id: "todo_week", action: "set_title", title: "周末待办" } }]);
    expect(result.actions).toEqual([{ type: "card.update", targetId: "todo_week", displayProps: { title: "周末待办" } }]);
  });

  it("update_card's entry actions change only the targeted entry", async () => {
    const done = await plan([{ name: "update_card", arguments: { card_id: "todo_week", action: "done", item_id: "item-1" } }], listCanvas());
    const doneItems = (done.actions[0] as unknown as { displayProps: { items: Array<{ id: string; done: boolean }> } }).displayProps.items;
    expect(doneItems).toHaveLength(3);
    expect(doneItems[0]).toEqual({ id: "item-1", text: "交周报", done: true });
    const removed = await plan([{ name: "update_card", arguments: { card_id: "todo_week", action: "remove", item_id: "item-1" } }], listCanvas());
    expect((removed.actions[0] as unknown as { displayProps: { items: Array<{ id: string }> } }).displayProps.items.map(item => item.id)).toEqual(["item-2", "item-3"]);
  });

  it("update_card rejects an action's foreign field instead of ignoring it", async () => {
    const issues = invalid(await plan([{ name: "update_card", arguments: { card_id: "todo_week", action: "set_title", title: "新", item_id: "item-1" } }]));
    expect(issues).toContain("不接受参数 item_id");
  });

  const VIEW_CASES: Array<[string, string, string, Record<string, unknown>]> = [
    ["focus", "card.focus", "focus", { mode: "focus", card_id: "todo_week" }],
    ["highlight", "card.highlight", "highlight", { mode: "highlight", card_id: "todo_week" }],
    ["highlight", "card.highlight", "highlight", { mode: "highlight", card_id: "todo_week", item_id: "item-1" }],
    ["fit", "canvas.fit", "overview", { mode: "fit" }],
    ["restore", "canvas.restore", "restore", { mode: "restore" }],
  ];

  it.each(VIEW_CASES)("view(mode=%s) yields one %s action with no card change", async (_mode, actionType, route, args) => {
    const result = await plan([{ name: "view", arguments: args }]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.created).toEqual([]);
    expect(result.actions.map(action => action.type)).toEqual([actionType]);
    expect(result.routes).toEqual([route]);
    envelope(result);
  });

  it("view(fit/restore) rejects a card target instead of ignoring it", async () => {
    const issues = invalid(await plan([{ name: "view", arguments: { mode: "fit", card_id: "todo_week" } }]));
    expect(issues).toContain("不接受参数 card_id");
  });

  it("history maps undo and redo onto the host operation", async () => {
    const undo = await plan([{ name: "history", arguments: { action: "undo" } }]);
    expect(undo.kind).toBe("host-operation");
    expect(undo.hostOperation).toEqual({ kind: "history.undo" });
    expect(undo.routes).toEqual(["undo"]);
    const redo = await plan([{ name: "history", arguments: { action: "redo" } }]);
    expect(redo.hostOperation).toEqual({ kind: "history.redo" });
  });

  it("arrange handles one card and the whole canvas through one entry", async () => {
    const card = await plan([{ name: "arrange", arguments: { target: "todo_week", position: "left" } }]);
    expect(card.kind).toBe("host-operation");
    expect(card.hostOperation).toEqual({ kind: "card.move", targetId: "todo_week", direction: "left" });
    const canvasPlan = await plan([{ name: "arrange", arguments: { target: "canvas" } }]);
    expect(canvasPlan.hostOperation).toEqual({ kind: "canvas.arrange" });
    // A card without a position is a missing argument, not a silent pin.
    const missing = invalid(await plan([{ name: "arrange", arguments: { target: "todo_week" } }]));
    expect(missing).toContain("position");
  });

  it("keeps the three external tools' own semantics", async () => {
    const search = await plan([{ name: "search", arguments: { query: "AI 行业新闻 2026年11月" } }]);
    expect(search.kind).toBe("lookup");
    expect(search.lookup).toEqual({ kind: "search", query: "AI 行业新闻 2026年11月" });
    const weather = await plan([{ name: "weather", arguments: { city: "南京", day: "明天" } }], canvas(), "明天南京冷不冷");
    expect(weather.lookup).toEqual({ kind: "weather", city: "南京", day: 1 });
    const find = await plan([{ name: "find_cards", arguments: { query: "交周报" } }]);
    expect(find.kind).toBe("lookup");
    expect(find.lookup).toEqual({ kind: "cards", query: "交周报" });
  });

  it("runs several capabilities in one batch and keeps the user's order", async () => {
    const result = await plan([
      { name: "view", arguments: { mode: "focus", card_id: "todo_week" } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["买牛奶"] } } },
      { name: "arrange", arguments: { target: "todo_week", position: "pin" } },
    ], canvas(), "先打开本周待办，再记个买牛奶，然后固定它");
    expect(result.kind).toBe("composite");
    expect(result.created.map(item => item.cardType)).toEqual(["TodoCard"]);
    expect(result.hostOperation).toEqual({ kind: "card.pin", targetId: "todo_week", pinned: true });
    expect(focusIds(result)).toContain("todo_week");
    envelope(result);
  });

  it("hands a failed capability call back with its kind and the next step", async () => {
    const emptyTodo = invalid(await plan([{ name: "create_card", arguments: { kind: "todo", fields: { items: [] } } }]));
    expect(emptyTodo).toContain("create_card(todo)");
    expect(emptyTodo).toContain("待办条目不能为空");
    const unknownKind = invalid(await plan([{ name: "create_card", arguments: { kind: "gantt", fields: {} } }]));
    expect(unknownKind).toContain("kind 必须是 14 种卡型之一");
    const badAction = invalid(await plan([{ name: "update_card", arguments: { card_id: "todo_week", action: "archive" } }]));
    expect(badAction).toContain("update_card");
    const noTarget = await plan([{ name: "view", arguments: { mode: "focus" } }]);
    expect(noTarget.kind).toBe("invalid");
    expect(noTarget.issues[0]!.code).toBe("missing-param");
  });
});

/**
 * sc-56 / sc-59: two cards can answer the same reference. Old rule 11 let the
 * model pick "the most similar" one, so the sentence silently focused the wrong
 * list. The model must ask instead — and the host's job is to hand it the real
 * candidates so the question names cards the user can recognise.
 */
describe("multi-candidate references must be asked, not guessed (sc-56 / sc-59)", () => {
  /** "买牛奶" lives on both lists; "聚焦待办" matches both TodoCards. */
  const twinCanvas = (): CanvasContext => {
    const context = listCanvas();
    context.cards[0]!.displayProps = { title: "本周待办", items: [
      { id: "item-1", text: "交周报", done: false },
      { id: "item-2", text: "买牛奶", done: false },
    ] };
    context.cards[1]!.displayProps = { title: "购物清单", items: [
      { id: "item-1", text: "鸡蛋", done: false },
      { id: "item-2", text: "买牛奶", done: false },
    ] };
    return context;
  };
  const twinPlan = (calls: ToolCall[], utterance = ""): Promise<ToolCallPlan> =>
    planFromToolCalls(calls, twinCanvas(), NOW, utterance);

  it("returns the model's target question with both real candidates", async () => {
    const result = await twinPlan([{ name: "clarify", arguments: { missing: "target", question: "你要操作哪一张待办？" } }],
      "高亮一下买牛奶那条");
    expect(result.kind).toBe("clarify");
    expect(result.actions).toEqual([]);
    expect(result.missing).toBe("target");
    // The entry is on both lists: the question must list both, by visible name.
    expect(result.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
    expect(result.message).toContain("本周待办");
    expect(result.message).toContain("购物清单");
  });

  it("lists both lists when the sentence names only the card type", async () => {
    const result = await twinPlan([{ name: "clarify", arguments: { missing: "target", question: "你要聚焦哪张卡？" } }], "聚焦待办");
    expect(result.kind).toBe("clarify");
    expect(result.targetCandidates?.map(candidate => candidate.id)).toEqual(["todo_week", "todo_shop"]);
  });

  it("keeps a question without candidates when the words name no real card", async () => {
    const result = await plan([{ name: "clarify", arguments: { missing: "target", question: "你要操作哪张卡？" } }], canvas(), "清空画布");
    expect(result.kind).toBe("clarify");
    expect(result.targetCandidates).toBeUndefined();
    expect(result.message).toBe("你要操作哪张卡？");
  });
});

/**
 * sc-60: "查一下明天上海天气，要是下雨就提醒我带伞". The host cannot run
 * "remind me only if it rains", so a batch that quietly does only the weather
 * half loses a clause. The mapper hands it back once with an issue; the model
 * then explains or asks. The host never writes that sentence itself.
 */
describe("a compound sentence cannot silently drop a clause (sc-60)", () => {
  const SC60 = "查一下明天上海天气，要是下雨就提醒我带伞";
  /** The verified facts a weather follow-up turn receives. */
  const withWeatherEvidence = (calls: ToolCall[], utterance = SC60) => planFromToolCalls(calls, canvas(), NOW, utterance,
    { lookupSatisfied: true, evidence: { kind: "weather", cards: [{
      id: "weather_test", type: "WeatherCard", variant: "minimal",
      displayProps: { tempC: 12, conditionIcon: "rain" },
      sourceData: { location: { name: "上海" }, forecastDay: { date: "2026-11-06", tempMaxC: 12, tempMinC: 8 } },
      sources: [], layout: { x: 0, y: 0, width: 320, height: 240, pinned: false },
      metadata: { createdAt: "2026-11-05T00:00:00.000Z", updatedAt: "2026-11-05T00:00:00.000Z" },
    }] } });

  it("lets the conditional sentence reach its query first instead of asking at the plan stage", async () => {
    // The facts have to reach the model before it can explain the condition; a
    // query-only plan is a lookup, not a dropped clause.
    const result = await plan([{ name: "weather", arguments: { city: "上海", day: "明天" } }], canvas(), SC60);
    expect(result.kind).toBe("lookup");
    expect(result.lookup).toEqual({ kind: "weather", city: "上海", day: 1 });
    expect(result.issues).toEqual([]);
  });

  it("rejects the follow-up that builds the card but stays silent about the condition", async () => {
    const result = await withWeatherEvidence([{ name: "create_card", arguments: { kind: "weather", fields: {} } }]);
    expect(result.kind).toBe("invalid");
    expect(result.actions).toEqual([]);
    expect(result.issues[0]!.code).toBe("unsupported");
    expect(result.issues[0]!.message).toContain("要是下雨就提醒我带伞");
    expect(result.issues[0]!.hint).toContain("静默");
    expect(result.message).toContain("条件");
  });

  it("accepts the follow-up once the model adds an explanation", async () => {
    const result = await withWeatherEvidence([
      { name: "create_card", arguments: { kind: "weather", fields: {} } },
      { name: "unsupported", arguments: { reply: "条件提醒暂时做不了，只能先给你看天气。" } },
    ]);
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.actions).toContainEqual({ type: "subtitle.show", text: "条件提醒暂时做不了，只能先给你看天气。", durationMs: 12000 });
    expect(result.created.map(item => item.cardType)).toEqual(["WeatherCard"]);
  });

  it("does not flag an unconditional two-action follow-up", async () => {
    const result = await withWeatherEvidence([
      { name: "create_card", arguments: { kind: "weather", fields: {} } },
      { name: "create_card", arguments: { kind: "todo", fields: { items: ["带伞"] } } },
    ], "查一下明天上海天气，再记个待办带伞");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
    expect(result.actions.some(action => action.type === "card.create")).toBe(true);
  });

  it("does not flag a note that records the conditional text verbatim", async () => {
    // "记个便签：如果…" stores the clause; nothing is executed, nothing is lost.
    const result = await plan([{ name: "create_card", arguments: { kind: "note", fields: { text: "如果下雨就提醒我带伞" } } }],
      canvas(), "记个便签：如果下雨就提醒我带伞");
    expect(result.kind, result.issues.join(" | ")).toBe("envelope");
  });
});
