import { describe, expect, it, vi } from "vitest";
import type { CardRecord } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { habitFastPath } from "../src/intent/habitFast.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import type { CanvasContext } from "../src/schemas.js";
import type { StepfunResult } from "../src/stepfun.js";
import { emptyContext } from "./helpers.js";

/**
 * A fixed-shape habit record already contains the habit and the checked days.
 * It must build a HabitHeatmapCard with zero model calls instead of letting the
 * model ask "这周哪几天打了卡"; a habit with no days, a question, a negation or
 * a second action must still go to the model.
 */

const NOW = Date.parse("2026-11-03T10:00:00+08:00"); // Tuesday in Shanghai
const MONDAY_FIRST_WEEK = ["2026-11-02", "2026-11-03", "2026-11-04"];
const habitCtx = (): CanvasContext => ({ ...emptyContext(), timeZone: "Asia/Shanghai" });

const cardsOf = (hit: ReturnType<typeof habitFastPath>): CardRecord[] =>
  hit?.envelope.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];

describe("habitFastPath: fixed-shape check-in records are deterministic", () => {
  it.each([
    ["习惯打卡：每天背单词，本周一到周三做到了", "背单词"],
    ["打卡：跑步，这周一二三完成", "跑步"],
    ["习惯：背单词 本周一到周三", "背单词"],
    ["每天背单词，本周一到周三都做到了", "背单词"],
    ["打卡：跑步，本周一到周三", "跑步"],
    ["习惯：早睡早起 本周一至周三", "早睡早起"],
    ["每天读书，本周一、二、三", "读书"],
    ["每天背单词 本周一到周三", "背单词"],
  ])("builds a HabitHeatmapCard for %s", (text, habit) => {
    const hit = habitFastPath(text, habitCtx(), NOW);
    expect(hit, text).not.toBeNull();
    expect(hit!.kind).toBe("envelope");
    expect(hit!.usedProvider).toBe("rules");
    const cards = cardsOf(hit);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.type).toBe("HabitHeatmapCard");
    expect(cards[0]!.displayProps).toMatchObject({ habit, checkins: MONDAY_FIRST_WEEK });
  });

  it.each([
    "每天背单词",
    "习惯：背单词",
    "不要打卡：每天背单词，本周一到周三",
    "打卡了吗？",
    "打卡：跑步，这周一二三完成，然后建待办",
    "本周一到周三",
    "本周一到周三每天背单词",
    "习惯：背单词，本周一到周三的计划",
    "打卡：跑步，下周一到周三",
  ])("leaves %s to the model", text => {
    expect(habitFastPath(text, habitCtx(), NOW)).toBeNull();
  });
});

describe("habitFastPath is reached by runIntent before tool calling", () => {
  const setup = () => {
    const generate = vi.fn(async (): Promise<StepfunResult<unknown>> => ({ ok: true, value: { clarify: "请补充要求。" } }));
    const deps: PipelineDeps = {
      toolCalls: true,
      credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://unused.test" },
      planner: { provider: "gpt", connected: true, isCurrent: () => true, generate },
    };
    return { deps, generate };
  };

  it("returns the envelope with zero model calls", async () => {
    const f = setup();
    const result = await runIntent({ text: "习惯打卡：每天背单词，本周一到周三做到了", canvasContext: habitCtx() }, f.deps);
    expect(result.kind).toBe("envelope");
    expect(result.usedProvider).toBe("rules");
    const cards = result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];
    expect(cards.map(card => card.type)).toEqual(["HabitHeatmapCard"]);
    expect(cards[0]!.displayProps).toMatchObject({ habit: "背单词" });
    expect((cards[0]!.displayProps as { checkins: string[] }).checkins).toHaveLength(3);
    expect((cards[0]!.displayProps as { checkins: string[] }).checkins.every(date => /^\d{4}-\d{2}-\d{2}$/u.test(date))).toBe(true);
    expect(f.generate).not.toHaveBeenCalled();
  });

  it("still asks the model when the sentence names no days", async () => {
    const f = setup();
    const result = await runIntent({ text: "每天背单词", canvasContext: habitCtx() }, f.deps);
    expect(result.kind).not.toBe("envelope");
    expect(f.generate).toHaveBeenCalled();
  });
});
