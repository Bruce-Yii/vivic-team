import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, HostOperationSchema } from "@vivic/contracts";
import { DecisionTaskManager } from "../src/decision/taskV2.js";
import { exactHostOperation, hostOperationIssue } from "../src/decision/hostOperations.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { IntentRequest, IntentResult } from "../src/intent/pipeline.js";
import type { Attachment } from "../src/images.js";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, chatOk, emptyContext, fetchStub, testConfig } from "./helpers.js";
import { testPng } from "./images.fixture.js";

// The task manager has one planning path: the injected `legacy` (the real
// `runIntent` model + tools pipeline). These fixtures assert flow state only —
// receipt, idempotency, clarification, deletion freeze, image pass-through.
// No native state/questions provider, probability score or calibration exists.

const note = (id: string, text = "同名便笺", x = 0) => ({ id, type: "NoteCard", displayProps: { text },
  sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 200, pinned: false } });
const context = (cards: CanvasContext["cards"] = [note("note-1"), note("note-2", "会议记录", 400)]): CanvasContext =>
  ({ ...emptyContext(cards), version: 7, totalCardCount: cards.length });
const request = (text = "聚焦左边便笺", id = "task-test"): IntentRequest => ({ text, canvasContext: context(), task: { id } });
const focus = (targetId = "note-1", given: CanvasContext = context()): IntentResult => ({ kind: "envelope", usedProvider: "stepfun",
  envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `TEST-${randomUUID()}`, canvasId: given.canvasId,
    actions: [{ type: "card.focus", targetId }] }) });
const deletion = (targetId = "note-1", given: CanvasContext = context()): IntentResult => ({ kind: "envelope", usedProvider: "stepfun",
  envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `TEST-${randomUUID()}`, canvasId: given.canvasId,
    actions: [{ type: "card.delete", targetId }] }) });
const image = (): Attachment => ({ type: "image", mime: "image/png", data: testPng(2, 1).toString("base64") });

describe("one model path plus task flow", () => {
  it("plans once, awaits the real receipt and deduplicates it", async () => {
    const tasks = new DecisionTaskManager(), legacy = vi.fn(async () => focus());
    const first = await tasks.run(request(), { legacy });
    expect(first.kind).toBe("envelope"); expect(first.task?.status).toBe("awaiting_execution");
    expect(first.task?.canvasVersion).toBe(7); expect(first.task?.executionId).toBeTruthy();
    // Wire compatibility only: the label can never be native-v2 any more.
    expect(first.task?.decision).toBe("legacy-fallback");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await tasks.run(request(), { legacy })).toEqual(first);
    expect(legacy).toHaveBeenCalledTimes(1);
    const receipt = { executionId: first.task!.executionId!, status: "succeeded" as const };
    const complete = await tasks.run({ ...request(), canvasContext: { ...context(), version: 8 }, task: { id: "task-test", receipt } }, { legacy });
    expect(complete.task?.status).toBe("completed");
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(await tasks.run({ ...request(), task: { id: "task-test", receipt } }, { legacy })).toEqual(complete);
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not accept the wrong receipt or a failed execution", async () => {
    const tasks = new DecisionTaskManager(), legacy = vi.fn(async () => focus());
    const first = await tasks.run(request(), { legacy });
    const wrong = await tasks.run({ ...request(), task: { id: "task-test", receipt: { executionId: "wrong", status: "succeeded" } } }, { legacy });
    expect(wrong.kind).toBe("error"); expect(wrong.task?.status).toBe("awaiting_execution");
    const failed = await tasks.run({ ...request(), task: { id: "task-test",
      receipt: { executionId: first.task!.executionId!, status: "failed", error: "保存失败" } } }, { legacy });
    expect(failed.task?.status).toBe("failed"); expect(failed.message).toContain("保存失败");
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("does not complete a created card until the receipt and canvas both confirm it", async () => {
    const card = { id: "TEST-created-note", type: "NoteCard", variant: "minimal", displayProps: { text: "TEST 新卡" },
      sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 320, height: 200, pinned: false },
      metadata: { createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" } };
    const tasks = new DecisionTaskManager(), legacy = vi.fn(async (): Promise<IntentResult> => ({ kind: "envelope", usedProvider: "stepfun",
      envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: `TEST-${randomUUID()}`, canvasId: context().canvasId,
        actions: [{ type: "card.create", card }] }) }));
    const first = await tasks.run(request("记一张 TEST 新卡"), { legacy });
    expect(first.task?.status).toBe("awaiting_execution");
    const receipt = { executionId: first.task!.executionId!, status: "succeeded" as const, createdCardIds: [] };
    const unconfirmed = await tasks.run({ ...request("记一张 TEST 新卡"), canvasContext: { ...context(), version: 8 },
      task: { id: "task-test", receipt } }, { legacy });
    expect(unconfirmed.kind).toBe("error"); expect(unconfirmed.task?.status).toBe("awaiting_execution");
    const confirmed = await tasks.run({ ...request("记一张 TEST 新卡"),
      canvasContext: { ...context([...context().cards, { ...card, sourceDataSummary: {} }]), version: 8 },
      task: { id: "task-test", receipt: { ...receipt, createdCardIds: [card.id] } } }, { legacy });
    expect(confirmed.task?.status).toBe("completed");
  });

  it("rejects a receipt whose canvas is older than the proposal", async () => {
    const tasks = new DecisionTaskManager(), legacy = vi.fn(async () => focus());
    const first = await tasks.run(request(), { legacy });
    const stale = await tasks.run({ ...request(), canvasContext: { ...context(), version: 6 },
      task: { id: "task-test", receipt: { executionId: first.task!.executionId!, status: "succeeded" } } }, { legacy });
    expect(stale.kind).toBe("error"); expect(stale.task?.status).toBe("awaiting_execution");
  });

  it("cancels in-flight planning and never executes the late proposal", async () => {
    let resolve!: (value: IntentResult) => void;
    const legacy = vi.fn(() => new Promise<IntentResult>(done => { resolve = done; }));
    const tasks = new DecisionTaskManager(), running = tasks.run(request(), { legacy });
    await vi.waitFor(() => expect(legacy).toHaveBeenCalled());
    const cancelled = await tasks.run({ ...request(), task: { id: "task-test", cancel: true } }, { legacy });
    expect(cancelled.task?.status).toBe("cancelled");
    resolve(focus());
    expect((await running).task?.status).toBe("cancelled");
    expect((await running).envelope).toBeUndefined();
  });

  it("expires a task instead of replaying its pending action", async () => {
    let now = 0;
    const tasks = new DecisionTaskManager({ now: () => now, ttlMs: 10 }), legacy = vi.fn(async () => focus());
    expect((await tasks.run(request(), { legacy })).task?.status).toBe("awaiting_execution");
    now = 20;
    const expired = await tasks.run(request(), { legacy });
    expect(expired.task?.status).toBe("failed"); expect(expired.envelope).toBeUndefined();
    expect(legacy).toHaveBeenCalledTimes(1);
  });

  it("bounds total task time even when the model ignores the abort signal", async () => {
    const legacy = vi.fn(() => new Promise<IntentResult>(() => {}));
    const result = await new DecisionTaskManager({ maxActiveMs: 5 }).run(request(), { legacy });
    expect(result.task?.status).toBe("failed"); expect(result.envelope).toBeUndefined();
  });

  it("freezes the numbered candidates of a clarification and replays the original goal", async () => {
    const calls: IntentRequest[] = [];
    const legacy = vi.fn(async (sent: IntentRequest) => {
      calls.push(sent);
      if (!sent.resolvedTargetId) return { kind: "clarify" as const, message: "你要操作哪一张？",
        targetCandidates: [{ id: "note-1", label: "同名便笺" }, { id: "note-2", label: "会议记录" }], targetClause: 0 };
      return focus(sent.resolvedTargetId);
    });
    const tasks = new DecisionTaskManager();
    const first = await tasks.run(request("聚焦那个便笺"), { legacy });
    expect(first.task?.status).toBe("awaiting_clarification");
    expect(first.task?.clarification?.candidates.map(candidate => candidate.id)).toEqual(["note-1", "note-2"]);
    const reordered = { ...context(), cards: [...context().cards].reverse() };
    const second = await tasks.run({ text: "2号", canvasContext: reordered, task: { id: first.task!.id } }, { legacy });
    expect(second.envelope?.actions).toEqual([{ type: "card.focus", targetId: "note-2" }]);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.text).toBe("聚焦那个便笺");
    expect(calls[1]!.resolvedTargetId).toBe("note-2");
    expect(calls[1]!.continuation).toBeUndefined();
  });

  it("requires a separate whole-utterance affirmative before a frozen deletion", async () => {
    const legacy = vi.fn(async () => deletion());
    const tasks = new DecisionTaskManager();
    const first = await tasks.run(request("删除便笺"), { legacy, safetyMode: true });
    expect(first.kind).toBe("clarify"); expect(first.message).toContain("确定删除");
    expect(first.envelope).toBeUndefined(); expect(first.task?.status).toBe("awaiting_clarification");
    expect(legacy).toHaveBeenCalledTimes(1);
    const cancelled = await tasks.run({ text: "不是", canvasContext: context(), task: { id: first.task!.id } }, { legacy, safetyMode: true });
    expect(cancelled.task?.status).toBe("cancelled"); expect(cancelled.envelope).toBeUndefined();
    expect(legacy).toHaveBeenCalledTimes(1);

    const confirming = new DecisionTaskManager(), deleteLegacy = vi.fn(async () => deletion());
    const question = await confirming.run(request("删除便笺"), { legacy: deleteLegacy, safetyMode: true });
    const confirmed = await confirming.run({ text: "是的", canvasContext: context(), task: { id: question.task!.id } },
      { legacy: deleteLegacy, safetyMode: true });
    expect(confirmed.kind).toBe("envelope"); expect(confirmed.task?.status).toBe("awaiting_execution");
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note-1" }]);
  });

  it("never reroutes an image task: the model decides whether a card is built", async () => {
    const attachment = image(), tasks = new DecisionTaskManager(), seen: IntentRequest[] = [];
    const legacy = vi.fn(async (sent: IntentRequest) => { seen.push(sent); return focus(undefined, sent.canvasContext); });
    const result = await tasks.run({ text: "看看这张图，要不要建张卡", canvasContext: context(), attachments: [attachment],
      task: { id: "image-task" } }, { legacy });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attachments).toEqual([attachment]);
    expect(seen[0]!.text).toBe("看看这张图，要不要建张卡");
    expect(result.kind).toBe("envelope"); expect(result.task?.status).toBe("awaiting_execution");
    // The model's own "no card" answer is preserved verbatim instead of a host
    // fallback("vision_requires_planner") reroute.
    const clarifyLegacy = vi.fn(async (): Promise<IntentResult> => ({ kind: "clarify", message: "这张图没有需要建卡的内容。" }));
    const answer = await new DecisionTaskManager().run({ text: "看看这张图", canvasContext: context(), attachments: [attachment],
      task: { id: "image-clarify" } }, { legacy: clarifyLegacy });
    expect(answer.kind).toBe("clarify"); expect(answer.envelope).toBeUndefined();
    expect(answer.task?.status).toBe("awaiting_clarification");
    expect(clarifyLegacy).toHaveBeenCalledTimes(1);
  });

  it("sends an image turn through the same model plan over the real API", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-image-task-key", models: ["step-3.7-flash"], defaultModel: "step-3.7-flash", checkedAt: "TEST" });
    const bodies: Array<Record<string, unknown>> = [];
    const app = createApp({ config: testConfig({ requestTimeoutMs: 2000 }), mode: "online", credentials,
      imageDecoder: async () => ({ width: 2, height: 1 }),
      fetchImpl: fetchStub({ "/chat/completions": init => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return chatOk({ actions: [{ type: "canvas.fit" }], spokenText: "已查看图片" });
      } }) });
    const attachment = image();
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({
      text: "看看这张图，要不要建张卡", canvasContext: emptyContext(), attachments: [attachment], task: { id: "image-http-task" } }) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.kind).toBe("envelope"); expect(result.task?.status).toBe("awaiting_execution");
    expect(result.task?.decision).toBe("legacy-fallback");
    expect(bodies).toHaveLength(1);
    const serialized = JSON.stringify(bodies[0]);
    expect(serialized).toContain("image_url");
    expect(serialized).toContain(attachment.data);
    app.dispose();
  });
});

describe("the task request keeps the existing host safeguards", () => {
  it("rejects movement of pinned cards and pauses of date/conditional reminders", () => {
    expect(hostOperationIssue({ kind: "card.move", targetId: "note-1", direction: "left" },
      { ...context(), cards: [{ ...note("note-1"), layout: { ...note("note-1").layout, pinned: true } }] })).not.toBeNull();
    const timer = { ...note("timer"), type: "CountdownCard", sourceDataSummary: { targetAt: "2026-11-01T00:00:00Z", event: { title: "生日" } } };
    expect(hostOperationIssue({ kind: "countdown.pause", targetId: "timer" }, emptyContext([timer]))).not.toBeNull();
    expect(exactHostOperation("解释‘撤销’")).toBeNull(); expect(exactHostOperation("不要撤销")).toBeNull();
  });

  it("keeps the host union separate from the legacy envelope", () => {
    expect(HostOperationSchema.safeParse({ kind: "card.move", targetId: "n", direction: "left", x: 10 }).success).toBe(false);
    expect(IntentResponseSchema.safeParse({ kind: "host-operation", hostOperation: { kind: "history.undo" },
      envelope: { schemaVersion: "0.6", requestId: "x", canvasId: "c1", actions: [{ type: "canvas.fit" }] } }).success).toBe(false);
  });

  it("connects a validated main-model host operation through the task request", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const app = createApp({ config: testConfig(), credentials,
      fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ hostOperation: { kind: "card.pin", targetId: "note-1", pinned: true } }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify(request("将左边的笔记固定住")) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.hostOperation).toEqual({ kind: "card.pin", targetId: "note-1", pinned: true });
    expect(result.usedProvider).toBe("stepfun");
    expect(result.task?.decision).toBe("legacy-fallback"); expect(result.task?.status).toBe("awaiting_execution");
    app.dispose();
  });

  it("normalizes the observed live NoteCard-under-cards format through the original action checks", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const card = { id: "note-1", type: "NoteCard", variant: "standard", displayProps: { text: "周五交付界面评审材料" }, sourceData: {}, sources: [],
      layout: { x: 0, y: 0, width: 264, height: 120, pinned: false }, metadata: { createdAt: "2026-10-23T14:26:39.265Z", updatedAt: "2026-10-23T14:26:39.265Z" } };
    const app = createApp({ config: testConfig(), credentials,
      fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ cards: [card], spokenText: "已创建便笺" }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({
      ...request("创建便笺，内容是：周五交付界面评审材料。"), canvasContext: { ...emptyContext(), version: 0, totalCardCount: 0 } }) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.envelope?.actions).toContainEqual({ type: "card.create", card });
    app.dispose();
  });

  it("does not use core-card format normalization to bypass scene-only data validation", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "synthetic-unit-key", models: ["step-3"], defaultModel: "step-3", checkedAt: new Date().toISOString() });
    const app = createApp({ config: testConfig(), credentials, fetchImpl: fetchStub({ "/chat/completions": () => chatOk({ cards: [{
      id: "fake-weather", type: "WeatherCard", variant: "standard", displayProps: { location: "虚构地点", tempC: 99, condition: "sun" },
      sourceData: {}, sources: [], layout: { x: 0, y: 0, width: 264, height: 120, pinned: false },
      metadata: { createdAt: "2026-10-23T14:26:39.265Z", updatedAt: "2026-10-23T14:26:39.265Z" } }] }) }) });
    const response = await app.request("/api/intent", { method: "POST", headers: authed, body: JSON.stringify({
      ...request("根据这些资料创建一个卡片"), canvasContext: emptyContext() }) });
    const result = IntentResponseSchema.parse(await response.json());
    expect(result.kind).toBe("clarify"); expect(result.envelope).toBeUndefined();
    app.dispose();
  });
});
