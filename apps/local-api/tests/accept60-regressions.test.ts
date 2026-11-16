import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { handleDataIntent } from "../src/data/index.js";
import { parseWeatherInput } from "../src/data/weatherInput.js";
import { lookupWeather } from "../src/data/weather.js";
import { hostOperationIssue } from "../src/decision/hostOperations.js";
import type { ChatMessage, StepfunResult } from "../src/stepfun.js";
import type { CanvasContext } from "../src/schemas.js";
import type { IntentRouteId } from "@vivic/contracts";

type Card = CanvasContext["cards"][number];
const card = (id: string, title: string, type = "NoteCard", x = 0): Card => ({
  id, type, aliases: [title], displayProps: type === "TodoCard"
    ? { title, items: [{ id: `${id}-item`, text: "买牛奶", done: false }] } : { text: title },
  sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 120, pinned: false },
});
/** The acceptance canvas: seven cards, one focused note, two todos. */
const canvas = (): CanvasContext => ({ canvasId: "TEST-accept60", version: 7, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: ["note_meeting"], cards: [
    card("todo_week", "本周待办", "TodoCard", 0), card("todo_shop", "购物清单", "TodoCard", 900),
    card("note_meeting", "会议记录", "NoteCard", 300), card("note_book", "读书笔记", "NoteCard", 600),
    card("cd_water", "喝水提醒", "CountdownCard", 0), card("weather_sh", "上海天气", "WeatherCard", 300),
    card("answer_google", "Google 公司介绍", "AnswerCard", 900),
  ] });
/** Fake planner: no real model, one canned output per call. */
function setup(_routes: IntentRouteId[], outputs: unknown[]) {
  let index = 0;
  const generate = vi.fn(async (_messages: ChatMessage[]): Promise<StepfunResult<unknown>> =>
    ({ ok: true, value: outputs[Math.min(index++, outputs.length - 1)] }));
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-accept60-key", defaultModel: "deepseek-flash", models: ["deepseek-flash"], checkedAt: new Date().toISOString() });
  const deps: PipelineDeps = { credentials, stepfun: { baseUrl: "https://unused.test/v1" },
    planner: { provider: "gpt", connected: true, isCurrent: () => true, generate } };
  return { deps, generate };
}
const reminderText = (item: { sourceData: unknown }) => (item.sourceData as { reminderText?: string }).reminderText;
const created = (result: IntentResult) => result.envelope?.actions.flatMap(action =>
  action.type === "card.create" ? [action.card] : []) ?? [];
const actions = (result: IntentResult) => result.envelope?.actions ?? [];

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("accept60: enumerated reminder items are built as one card per item", () => {
  it("sc-12 五分钟后提醒我喝水和吃药 needs no model and creates both reminders", async () => {
    const f = setup(["countdown"], [{ slots: { seconds: 300, text: "喝水和吃药" } }]);
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard"]);
    expect(created(result).map(reminderText)).toEqual(["喝水", "吃药"]);
    // The deterministic grammar must not pay for (or depend on) a planner call.
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("sc-12 also splits deterministically on the default (off) routing path", async () => {
    const f = setup(["countdown"], [{ clarify: "模型不应被调用" }]);
    const legacy: PipelineDeps = { ...f.deps };
    const result = await runIntent({ text: "五分钟后提醒我喝水和吃药", canvasContext: canvas() }, legacy);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(created(result).map(item => item.type)).toEqual(["CountdownCard", "CountdownCard"]);
    expect(created(result).map(reminderText)).toEqual(["喝水", "吃药"]);
    expect(f.generate).not.toHaveBeenCalled();
  });

});

describe("accept60: a trailing bare append command joins the clause before it", () => {


  it("does not merge an operation sentence into a todo item", async () => {
    const f = setup(["arrange"], [{ clarify: "模型不应被调用" }]);
    const result = await runIntent({ text: "显示全部，加个待办", canvasContext: canvas() }, f.deps);
    expect(created(result).map(item => item.type)).not.toEqual(["TodoCard"]);
  });
});


describe("accept60: weekly plan content is generation, not invented user facts", () => {
  it("sc-16 builds the next week's plan without inventing clock times", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-17T02:00:00.000Z"));
    const f = setup(["generate"], [{ contract: "weekly_schedule", slots: { title: "下周健身计划",
      events: [{ day: 1, title: "力量训练" }, { day: 3, title: "有氧" }, { day: 5, title: "拉伸" }] } }]);
    const result = await runIntent({ text: "帮我做一个下周的健身计划", canvasContext: canvas() }, f.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    const weekly = created(result)[0];
    expect(weekly?.type).toBe("WeeklyScheduleCard");
    if (weekly?.type !== "WeeklyScheduleCard") return;
    expect(weekly.displayProps.weekStart).toBe("2026-10-19");
    expect(weekly.displayProps.events.map(event => event.day)).toEqual([1, 3, 5]);
    for (const event of weekly.displayProps.events) {
      expect(event).not.toHaveProperty("start");
      expect(event).not.toHaveProperty("end");
    }
  });
});





describe("accept60: 南京 is one place, not a question (D)", () => {
  /** Geocoding rows for the real 南京 homonym set (GeoNames shape). */
  const nanjing = { results: [
    { id: 1799962, name: "南京", latitude: 32.06167, longitude: 118.77778, country: "中国", country_code: "CN",
      admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "PPLA", population: 9314685 },
    { id: 9924292, name: "南京", latitude: 23.4071, longitude: 99.7757, country: "中国", country_code: "CN",
      admin1: "云南", admin2: "临沧市", timezone: "Asia/Shanghai", feature_code: "PPL" },
    { id: 9931976, name: "南京", latitude: 23.7873, longitude: 101.084, country: "中国", country_code: "CN",
      admin1: "云南", admin2: "思茅市", timezone: "Asia/Shanghai", feature_code: "PPL" },
    // The same place as row 1, returned again as its administrative area: this is
    // what made the old message say 「南京 / 江苏 / 中国」 twice.
    { id: 1799963, name: "南京", latitude: 32.06167, longitude: 118.77778, country: "中国", country_code: "CN",
      admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "ADM2", population: 9314685 },
  ] };
  const forecast = () => ({
    latitude: 32.06, longitude: 118.78, utc_offset_seconds: 0,
    current_units: { time: "unixtime", temperature_2m: "°C" },
    current: { time: Math.floor(Date.now() / 1000), interval: 900, temperature_2m: 18.5, weather_code: 3, is_day: 1 },
  });
  const stub = (geo: unknown) => (async (input: string | URL | Request) => String(input).includes("forecast")
    ? Response.json(forecast()) : Response.json(geo)) as typeof fetch;

  it("sc-21 answers 南京 without asking: dedupe by place, then rank by level and population", async () => {
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024, fetchImpl: stub(nanjing) });
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.location.name).toBe("南京");
    // 江苏 (PPLA, 9.3M) beats the two 云南 villages (PPL, no population).
    expect(result.location.admin1).toBe("江苏");
    expect(result.sources.some(source => source.provider === "open-meteo/geocoding")).toBe(true);
  });

  it("asks with numbered, de-duplicated candidates only for a real tie", async () => {
    const tie = { results: [
      { id: 1, name: "新城", latitude: 30, longitude: 110, country: "中国", country_code: "CN",
        admin1: "湖北", timezone: "Asia/Shanghai", feature_code: "PPLA3", population: 120_000 },
      { id: 2, name: "新城", latitude: 34, longitude: 108, country: "中国", country_code: "CN",
        admin1: "陕西", timezone: "Asia/Shanghai", feature_code: "PPLA3", population: 110_000 },
      { id: 3, name: "新城", latitude: 34, longitude: 108, country: "中国", country_code: "CN",
        admin1: "陕西", timezone: "Asia/Shanghai", feature_code: "ADM3", population: 110_000 },
    ] };
    const result = await lookupWeather("新城", { signal: new AbortController().signal, maxBytes: 128 * 1024, fetchImpl: stub(tie) });
    expect(result.kind).toBe("clarify");
    if (result.kind !== "clarify") return;
    // Two genuinely different 新城: the 陕西 PPL/ADM pair counts once.
    expect(result.candidates).toHaveLength(2);
    expect(result.message).toContain("新城 / 湖北 / 中国");
    expect(result.message).toContain("新城 / 陕西 / 中国");
    expect(result.message.match(/新城 \/ 陕西 \/ 中国/gu)).toHaveLength(1);
  });
});
