import { describe, expect, it } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { createApp } from "../src/app.js";
import { assembleEnvelope, mergeEnvelopes } from "../src/intent/envelope.js";
import { authed, emptyContext, fetchStub, testConfig } from "./helpers.js";

/**
 * C4 acceptance, keyless half: "短语音反馈 + 卡片承载主信息".
 *
 * The real Playwright/live checks (success rate, first-audio latency, TTS) need a
 * model key and stay out of CI. What can be guaranteed offline is the product
 * contract those checks rest on:
 *
 *   ① a spoken card command must return an envelope with real actions,
 *   ③ the spoken sentence is a short status confirmation (never a read-out of the
 *     card), and
 *   ④ every user-supplied detail lives on the card, not in the sentence.
 *
 * The deterministic fast path is the right subject: it is the 0-model route a
 * voice turn takes, and its speech/card split is the same split the planner
 * follows. A fetch stub proves the model was never called.
 */

type IntentBody = {
  kind?: string;
  usedProvider?: string;
  envelope?: {
    spokenText?: string;
    actions?: Array<{ type: string; card?: { type?: string; displayProps?: Record<string, unknown>; sourceData?: Record<string, unknown> } }>;
  };
};

const setup = () => {
  const calls: string[] = [];
  const app = createApp({ config: testConfig(), fetchImpl: fetchStub({}, url => calls.push(url)) });
  return { app, calls };
};

const postIntent = async (app: ReturnType<typeof createApp>, text: string, canvas = emptyContext()) => {
  const response = await app.request("/api/intent", {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ text, canvasContext: canvas }),
  });
  return { status: response.status, body: (await response.json()) as IntentBody };
};

const createActions = (body: IntentBody) => (body.envelope?.actions ?? [])
  .filter((action): action is { type: string; card: NonNullable<typeof action.card> } =>
    action.type === "card.create" && Boolean(action.card));

/** ①② deterministic voice turns: every one must still produce a real action. */
const CARD_TURNS: Array<{ text: string; cards: number; spoken: string; cardType: string; detail: string[] }> = [
  { text: "30分钟倒计时", cards: 1, spoken: "30分倒计时已就位", cardType: "CountdownCard", detail: [] },
  { text: "帮我记一下待办：买牛奶、交电费、取快递", cards: 1, spoken: "已记下 3 条待办", cardType: "TodoCard", detail: ["买牛奶", "交电费", "取快递"] },
  { text: "提醒我30分钟后喝水、吃药", cards: 2, spoken: "已设置 2 项提醒", cardType: "CountdownCard", detail: ["喝水", "吃药"] },
  { text: "两小时后提醒我开会", cards: 1, spoken: "已设置 1 项提醒", cardType: "CountdownCard", detail: ["开会"] },
  { text: "记一条便签：明天带伞和充电宝", cards: 1, spoken: "已记下便笺", cardType: "NoteCard", detail: ["明天带伞和充电宝"] },
];

describe("C4 ①: a spoken card command always returns an executable envelope", () => {
  it.each(CARD_TURNS)("$text", async ({ text, cards, spoken, cardType }) => {
    const { app, calls } = setup();
    try {
      const { status, body } = await postIntent(app, text);
      expect(status).toBe(200);
      expect(body.kind).toBe("envelope");
      expect(body.usedProvider).toBe("rules");
      // An envelope is only executable when it carries concrete actions.
      expect(ActionEnvelopeSchema.safeParse(body.envelope).success).toBe(true);
      // Single-card rules emit the create (a reminder adds focus/fit); every turn
      // must still carry at least its card-creating action.
      expect(body.envelope?.actions?.length ?? 0).toBeGreaterThanOrEqual(cards);
      expect(createActions(body)).toHaveLength(cards);
      expect(createActions(body).every(action => action.card.type === cardType)).toBe(true);
      expect(body.envelope?.spokenText).toBe(spoken);
      // The deterministic route must not spend a model call on a plain card command.
      expect(calls).toHaveLength(0);
    } finally { app.dispose(); }
  });
});

describe("C4 ③: voice only says one short status confirmation", () => {
  it.each(CARD_TURNS)("$text stays inside one sentence", async ({ text, spoken }) => {
    const { app } = setup();
    try {
      const { body } = await postIntent(app, text);
      const sentence = body.envelope?.spokenText ?? "";
      expect(sentence).toBe(spoken);
      // The planner prompt asks for "40字内"; one spoken sentence is the product rule.
      expect(sentence.length).toBeLessThanOrEqual(40);
      expect(sentence.split(/[。！？!?]/).filter(Boolean)).toHaveLength(1);
    } finally { app.dispose(); }
  });
});

describe("C4 ④: the card carries the detail, the sentence does not read it out", () => {
  it.each(CARD_TURNS.filter(turn => turn.detail.length > 0))("$text", async ({ text, detail }) => {
    const { app } = setup();
    try {
      const { body } = await postIntent(app, text);
      const spoken = body.envelope?.spokenText ?? "";
      const actions = createActions(body);
      const carried = actions.flatMap(({ card }) => {
        const props = card.displayProps as { items?: Array<{ text?: string }>; text?: string };
        const source = card.sourceData as { reminderText?: string };
        return [
          ...(props.items ?? []).map(item => item.text ?? ""),
          ...(props.text ? [props.text] : []),
          ...(source.reminderText ? [source.reminderText] : []),
        ];
      }).filter(Boolean);
      // Every user detail is on a card ...
      for (const item of detail) expect(carried).toContain(item);
      // ... and the sentence never repeats it, so the audio stays a one-liner.
      for (const item of detail) expect(spoken).not.toContain(item);
    } finally { app.dispose(); }
  });

  it("CountdownCard keeps its detail in sourceData, not displayProps", async () => {
    const { app } = setup();
    try {
      const { body } = await postIntent(app, "30分钟倒计时");
      const card = createActions(body)[0]!.card;
      // Contract: the renderer reads targetAt; displayProps is empty on purpose.
      expect(card.displayProps).toEqual({});
      const source = card.sourceData as { targetAt?: string; startedAt?: string };
      expect(Date.parse(source.targetAt!) - Date.parse(source.startedAt!)).toBe(30 * 60 * 1000);
    } finally { app.dispose(); }
  });

  it("a note body lives on the card, so a shorter spoken line is still complete", async () => {
    const { app } = setup();
    try {
      const { body } = await postIntent(app, "记一条便签：明天带伞和充电宝");
      expect(createActions(body)[0]!.card.displayProps).toEqual({ text: "明天带伞和充电宝" });
      expect(body.envelope?.spokenText).toBe("已记下便笺");
    } finally { app.dispose(); }
  });
});

describe("C4 ③: the spoken-text cap is enforced by the contracts, not by luck", () => {
  it("merging two planned sentences still fits the envelope cap", () => {
    const first = assembleEnvelope([{ type: "canvas.fit" }], "c1", "甲".repeat(150));
    const second = assembleEnvelope([{ type: "canvas.restore" }], "c1", "乙".repeat(150));
    expect(first && second).toBeTruthy();
    const merged = mergeEnvelopes(first!, second!);
    expect(merged?.spokenText?.length ?? 0).toBeLessThanOrEqual(180);
    expect(merged?.spokenText).toContain("，");
  });

  it("the envelope schema rejects a spokenText over 180 characters", () => {
    const envelope = { schemaVersion: "0.6", requestId: "llm_x", canvasId: "c1",
      spokenText: "长".repeat(181), actions: [{ type: "canvas.fit" }] };
    expect(ActionEnvelopeSchema.safeParse(envelope).success).toBe(false);
    expect(ActionEnvelopeSchema.safeParse({ ...envelope, spokenText: "长".repeat(180) }).success).toBe(true);
  });
});
