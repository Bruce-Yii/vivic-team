import { describe, expect, it } from "vitest";
import { ActionSchema, CARD_TYPE_LABELS, HostOperationSchema } from "@vivic/contracts";
import { TOOL_CATALOG, TOOL_DEFINITIONS } from "../src/intent/toolCalls.js";

/**
 * The two reconciliation tables from
 * `docs/audits/2026-11-04-capability-and-validation-inventory.md`, encoded.
 *
 * Every executable capability is either reachable from the model-facing tool
 * surface or listed here as deliberately closed with the reason. A new
 * HostOperation / Action / CardType therefore cannot be added without classifying
 * it: this test fails and names the unclassified capability, instead of the gap
 * being discovered later by an acceptance run.
 */

type Option = { shape: Record<string, unknown> };
const literalValues = (schema: unknown, key: string): string[] =>
  ((schema as { options: Option[] }).options)
    .map(option => String((option.shape[key] as { value: unknown }).value));

const hostKinds = literalValues(HostOperationSchema, "kind");
const actionTypes = literalValues(ActionSchema, "type");
const cardTypes = Object.keys(CARD_TYPE_LABELS);

/** Reachable from a tool call (directly, or as the action a tool emits). */
const OPEN_HOST_KINDS = {
  "card.move": "arrange(position=left|right|up|down)",
  "card.pin": "arrange(position=pin|unpin)",
  "card.surface": "arrange(surface=user|display)",
  "history.undo": "history(action=undo)",
  "history.redo": "history(action=redo)",
  "canvas.arrange": "arrange(target=\"canvas\")",
  "countdown.pause": "update_card(action=pause_countdown)",
  "countdown.resume": "update_card(action=resume_countdown)",
} as const;

/** Executable somewhere in the product, but deliberately not model-facing. */
const CLOSED_HOST_KINDS: Record<string, string> = {
  "ambient.control": "设备/视觉偏好：只保留整句闭合口令（exactHostOperation），不让模型改写用户光效",
  "canvas.organize.preview": "apps/web 执行器当前固定拒绝（整理与分区已暂时关闭）；契约保留待恢复，模型面不宣传",
};

/** Tool-emitted actions, plus the ones the host itself adds around a tool plan. */
const OPEN_ACTIONS: Record<string, string> = {
  "stage.awaken": "宿主在 STANDBY 建卡/聚焦前自动加入（build.ts / rules）",
  "card.create": "create_card",
  "card.delete": "delete_card（经确认门）",
  "card.focus": "view(mode=focus) + 新卡自动聚焦",
  "card.highlight": "view(mode=highlight)",
  "card.update": "update_card + create_card(kind=todo, card_id=…) 追加",
  "canvas.fit": "view(mode=fit)",
  "canvas.restore": "view(mode=restore)",
  "subtitle.show": "unsupported(reply) / 提醒口播",
};

/** Executable, but with a non-model entry (or internal-only). */
const CLOSED_ACTIONS: Record<string, string> = {
  "cards.delete": "批量删除只走整句规则（清空画布）与决策任务，避免模型一次删多张",
  "card.subcard.set": "子卡片绑定行锚点，只能由控制端编辑器写入（intent/validation.ts 拒绝模型动作）",
  "card.subcard.delete": "子卡片绑定行锚点，只能由控制端编辑器删除（intent/validation.ts 拒绝模型动作）",
  "canvas.switch": "空间路由属于用户界面/手机权限，不由模型决定",
  "canvas.create": "空间创建属于用户界面，不由模型决定",
  "ambient.setPreset": "设备主题偏好，来自设置/URL 主题",
  "subtitle.hide": "内部表现动作，没有独立用户意图",
  "stage.sleep": "进入待机由用户界面触发，不由模型决定",
};

/**
 * How every registered card type can be produced. A card type with no producer
 * would be a renderer nobody can reach; one with no model entry is listed with
 * its real (non-tool) producer.
 */
const CARD_TYPE_ENTRIES: Record<string, string> = {
  FileCard: "文件上传（files/routes），不交给模型",
  TravelOffersCard: "旅行查询入口（scenes/travel），create_card 明确拒绝 travel_offers",
  ExtensionCard: "扩展安装（extensionDefinitions），不交给模型",
  CountdownCard: "create_card(kind=countdown) / create_card(kind=scene, scene_id=countdown)",
  TodoCard: "create_card(kind=todo)",
  NoteCard: "create_card(kind=note)",
  SearchResultCard: "search（已验证的检索事实）→ create_card(kind=search_results) / read_url → kind=article",
  WeatherCard: "weather（已验证的天气事实）→ create_card(kind=weather)",
  TableCard: "data 适配器（用户给出的数值），不交给模型",
  ChartCard: "create_card(kind=chart) / scene data_visualization",
  PaperCard: "create_card(kind=scene, scene_id=academic_paper)",
  GalleryCard: "create_card(kind=scene, scene_id=photo_gallery)",
  WeeklyScheduleCard: "create_card(kind=weekly_plan|schedule)",
  RoadmapCard: "create_card(kind=scene, scene_id=project_roadmap)",
  NewsCard: "create_card(kind=answer) / scene news_summary",
  TimelineCard: "create_card(kind=scene, scene_id=historical_timeline)",
  QuoteCard: "create_card(kind=scene, scene_id=quote_note)",
  StoryCarouselCard: "create_card(kind=scene, scene_id=photo_story)",
  ActivityFeedCard: "create_card(kind=scene, scene_id=activity_feed)",
  ProgressRingCard: "create_card(kind=scene, scene_id=goal_progress)",
  HabitHeatmapCard: "create_card(kind=habit) / scene habit_tracking",
  BookCard: "create_card(kind=scene, scene_id=book_record)",
  MonthCalendarCard: "create_card(kind=scene, scene_id=monthly_calendar)",
  ComparisonCard: "create_card(kind=scene, scene_id=option_comparison)",
  LinkPreviewCard: "create_card(kind=scene, scene_id=web_bookmark)",
  PhotoCoverCard: "create_card(kind=scene, scene_id=photo_memory)",
  NotificationCard: "create_card(kind=notification) / scene single_notification",
};

describe("capability inventory: every host capability is open or explicitly closed", () => {
  it("classifies every HostOperation kind exactly once", () => {
    expect(new Set([...Object.keys(OPEN_HOST_KINDS), ...Object.keys(CLOSED_HOST_KINDS)]).size).toBe(hostKinds.length);
    expect([...Object.keys(OPEN_HOST_KINDS), ...Object.keys(CLOSED_HOST_KINDS)].sort()).toEqual([...hostKinds].sort());
    for (const reason of Object.values(CLOSED_HOST_KINDS)) expect(reason.length).toBeGreaterThan(10);
  });

  it("classifies every Action type exactly once", () => {
    expect(new Set([...Object.keys(OPEN_ACTIONS), ...Object.keys(CLOSED_ACTIONS)]).size).toBe(actionTypes.length);
    expect([...Object.keys(OPEN_ACTIONS), ...Object.keys(CLOSED_ACTIONS)].sort()).toEqual([...actionTypes].sort());
    for (const reason of Object.values(CLOSED_ACTIONS)) expect(reason.length).toBeGreaterThan(10);
  });

  it("gives every registered CardType a producer entry", () => {
    expect(Object.keys(CARD_TYPE_ENTRIES).sort()).toEqual([...cardTypes].sort());
    for (const entry of Object.values(CARD_TYPE_ENTRIES)) expect(entry.length).toBeGreaterThan(5);
  });

  it("keeps the catalog in step with the tool definitions", () => {
    expect(TOOL_CATALOG.map(capability => capability.name))
      .toEqual(TOOL_DEFINITIONS.map(definition => definition.function.name));
    // A capability that is open in the table must have a tool entry that names it.
    for (const entry of Object.values(OPEN_HOST_KINDS)) {
      const tool = entry.split("(")[0]!;
      expect(TOOL_DEFINITIONS.map(definition => definition.function.name)).toContain(tool);
    }
  });
});
