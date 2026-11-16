import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema, type Action } from "@vivic/contracts";
import { createApp } from "../src/app.js";
import { CredentialStore } from "../src/credentials.js";
import type { LocalApiConfig } from "../src/config.js";
import { IntentResponseSchema, type CanvasContext } from "../src/schemas.js";
import type { IntentResult } from "../src/intent/pipeline.js";
import { assessDeletion, deicticDeletion } from "../src/decision/deleteTarget.js";

/**
 * Product rule: a clear pointer ("它/这个/那个/刚才那个") deletes the card the user
 * was just looking at. Only a pointer with nothing to point at explains itself —
 * it never answers "哪张卡片".
 */

const origin = "https://unit.test", token = "TEST-delete-target-token-12345678";
const config: LocalApiConfig = { host: "127.0.0.1", port: 0, token, tokenPath: "", tokenGenerated: false,
  allowedOrigins: [origin], stepfunBaseUrl: "https://model.test/v1", modelApiBaseUrl: "https://unused.test/v1",
  bodyLimitBytes: 65536, requestTimeoutMs: 60000, managedDecisionEnabled: false, decisionProviderEnabled: false };
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.dispose(); vi.restoreAllMocks(); });

type CanvasCard = CanvasContext["cards"][number];
const card = (id: string, title: string, type = "NoteCard", x = 0): CanvasCard => ({
  id, type, aliases: [title], displayProps: type === "TodoCard"
    ? { title, items: [{ id: `${id}-item`, text: "买牛奶", done: false }] } : { text: title },
  sourceDataSummary: {}, layout: { x, y: 0, width: 320, height: 120, pinned: false },
});

const canvas = (): CanvasContext => ({ canvasId: "TEST-delete-target", version: 7, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: ["note_meeting"], cards: [
    card("note_meeting", "会议记录", "NoteCard", 0), card("note_book", "读书笔记", "NoteCard", 400),
    card("note_weekly", "周报", "NoteCard", 800), card("todo_week", "本周待办", "TodoCard", 1200),
  ] });
const unfocused = (): CanvasContext => ({ ...canvas(), focusHistory: [] });
const emptyCanvas = (): CanvasContext => ({ ...canvas(), cards: [], focusHistory: [] });

function setup() {
  const credentials = new CredentialStore();
  credentials.set({ apiKey: "TEST-delete-target-key", defaultModel: "step-3.7-flash", models: ["step-3.7-flash"], checkedAt: new Date().toISOString() });
  // A model that proposes one delete; the host still has to validate the target
  // and freeze destructive work. A pure pointer must never reach it at all.
  const model = vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    actions: [{ type: "card.delete", targetId: "note_meeting" }], spokenText: "已删除。" }) } }] }));
  const app = createApp({ config, mode: "online", credentials, fetchImpl: model as typeof fetch });
  apps.push(app);
  let tasks = 0;
  async function post(body: Record<string, unknown>): Promise<IntentResult> {
    // ChatPage sends a task id on every request, so the task manager is the
    // default deletion-safety wrapper; the test sends one too.
    const request = { ...body, task: body.task ?? { id: `delete-target-${++tasks}` } };
    const response = await app.fetch(new Request(`${origin}/api/intent`, { method: "POST",
      headers: { authorization: `Bearer ${token}`, origin, "content-type": "application/json" }, body: JSON.stringify(request) }));
    expect(response.status).toBe(200);
    return IntentResponseSchema.parse(await response.json()) as IntentResult;
  }
  return { post, model };
}

const proposal = (ctx: CanvasContext, actions: Action[]): IntentResult => ({ kind: "envelope", usedProvider: "rules",
  envelope: ActionEnvelopeSchema.parse({ schemaVersion: "0.6", requestId: "req_delete_target", canvasId: ctx.canvasId, actions }) });

describe("a pure pointer deletes the focused card directly", () => {
  it("删了它 deletes the focused card without a question", async () => {
    const f = setup();
    const result = await f.post({ text: "删了它", canvasContext: canvas() });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
    expect(result.task?.status).toBe("awaiting_execution");
    expect(result.task?.executionId).toBeTruthy();
    expect(result.message ?? "").not.toMatch(/哪张|哪一张/);
    expect(f.model).not.toHaveBeenCalled();
  });

  it("删掉刚才那个 deletes the focused card without a question", async () => {
    const f = setup();
    const result = await f.post({ text: "删掉刚才那个", canvasContext: canvas() });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
    expect(f.model).not.toHaveBeenCalled();
  });

  it("把这张删了 deletes the focused card directly", async () => {
    const f = setup();
    const result = await f.post({ text: "把这张删了", canvasContext: canvas() });
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
  });

  it("uses the newest focus entry when the history has several", async () => {
    const ctx = canvas();
    ctx.focusHistory = ["note_meeting", "note_book"];
    const f = setup();
    const result = await f.post({ text: "删了它", canvasContext: ctx });
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_book" }]);
  });
});

describe("a pointer with nothing to point at explains instead of asking", () => {
  it("删了 without a focus history says what is missing, not 哪张卡片", async () => {
    const f = setup();
    const result = await f.post({ text: "删了", canvasContext: unfocused() });
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
    expect(result.message).toBeTruthy();
    expect(result.message).not.toMatch(/哪张|哪一张/);
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    expect(f.model).not.toHaveBeenCalled();
  });

  it("删了 on an empty canvas reports there is nothing to delete", async () => {
    const f = setup();
    const result = await f.post({ text: "删了", canvasContext: emptyCanvas() });
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("画布上没有可删除的卡片");
    expect(result.message).not.toMatch(/哪张|哪一张/);
    expect(result.envelope).toBeUndefined();
  });

  it("explains a focused card that has already left the canvas", async () => {
    const stale = canvas();
    stale.focusHistory = ["ghost_card"];
    const f = setup();
    const result = await f.post({ text: "删了它", canvasContext: stale });
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("不在画布上");
    expect(result.message).not.toMatch(/哪张|哪一张/);
    expect(result.envelope).toBeUndefined();
  });

  it("删除这个 on a one-card canvas asks once, then deletes on 确定", async () => {
    const one = { ...canvas(), focusHistory: [], cards: [canvas().cards[0]!] };
    const f = setup();
    const first = await f.post({ text: "删除这个", canvasContext: one });
    expect(first.kind).toBe("clarify");
    expect(first.message).toContain("确定删除");
    expect(first.envelope).toBeUndefined();
    const confirmed = await f.post({ text: "确定", canvasContext: one, task: { id: first.task!.id } });
    expect(confirmed.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
    expect(confirmed.task?.status).toBe("awaiting_execution");
  });
});

describe("content deletes keep the existing matching path", () => {

  it("删除会议记录 deletes the named card, not the focused one", async () => {
    const ctx = canvas();
    ctx.focusHistory = ["note_book"];
    const f = setup();
    const result = await f.post({ text: "删除会议记录", canvasContext: ctx });
    expect(result.envelope?.actions).toEqual([{ type: "card.delete", targetId: "note_meeting" }]);
  });

  it("still asks when two cards match the named content", async () => {
    const ctx = canvas();
    ctx.cards.push(card("note_weekly2", "周报（下周）", "NoteCard", 1600));
    const f = setup();
    const result = await f.post({ text: "删除周报", canvasContext: ctx });
    expect(result.kind).toBe("clarify");
    expect(result.envelope).toBeUndefined();
  });
});

describe("assessDeletion: the verdict names the focused card", () => {
  it("returns direct/focus for a pure pointer", async () => {
    const ctx = canvas();
    expect(await assessDeletion(proposal(ctx, [{ type: "card.delete", targetId: "note_meeting" }]), ctx, "删了它"))
      .toEqual({ mode: "direct", reason: "focus" });
  });

  it("moves a proposal that points elsewhere onto the focused card", async () => {
    const ctx = canvas();
    expect(await assessDeletion(proposal(ctx, [{ type: "card.delete", targetId: "note_book" }]), ctx, "删掉刚才那个"))
      .toEqual({ mode: "direct", reason: "focus", targetId: "note_meeting" });
  });

  it("refuses a pointer with no focus without asking which card", async () => {
    const ctx = unfocused();
    const verdict = await assessDeletion(proposal(ctx, [{ type: "card.delete", targetId: "note_meeting" }]), ctx, "删了");
    expect(verdict?.mode).toBe("refuse");
    if (verdict?.mode !== "refuse") return;
    expect(verdict.message).not.toMatch(/哪张|哪一张/);
    expect(verdict.message).toContain("没有删除");
  });

  it("keeps content matching direct for a unique title", async () => {
    const ctx = canvas();
    expect(await assessDeletion(proposal(ctx, [{ type: "card.delete", targetId: "note_weekly" }]), ctx, "删除周报"))
      .toEqual({ mode: "direct", reason: "content" });
  });

  it("still confirms a batch delete", async () => {
    const ctx = canvas();
    expect(await assessDeletion(proposal(ctx, [{ type: "cards.delete", targetIds: ctx.cards.map(item => item.id) }]), ctx, "删除全部卡片"))
      .toEqual({ mode: "confirm", reason: "batch" });
  });

  it("still confirms a composite delete", async () => {
    const ctx = canvas();
    expect(await assessDeletion(proposal(ctx, [{ type: "card.delete", targetId: "note_meeting" },
      { type: "card.focus", targetId: "note_meeting" }]), ctx, "删了它再聚焦另一张"))
      .toEqual({ mode: "confirm", reason: "composite" });
  });

  it("recognises a bare verb as a pointer but not a negated or scoped sentence", () => {
    const ctx = canvas();
    expect(deicticDeletion("删了", ctx)).toEqual({ targetId: "note_meeting", mode: "direct" });
    expect(deicticDeletion("删了它", ctx)).toEqual({ targetId: "note_meeting", mode: "direct" });
    expect(deicticDeletion("删掉刚才那个", ctx)).toEqual({ targetId: "note_meeting", mode: "direct" });
    expect(deicticDeletion("不要删了它", ctx)).toBeUndefined();
    // A question about a deletion is not a deletion command.
    expect(deicticDeletion("删了它了吗", ctx)).toBeUndefined();
    expect(deicticDeletion("删了它呢？", ctx)).toBeUndefined();
    expect(deicticDeletion("删除全部卡片", ctx)).toBeUndefined();
    expect(deicticDeletion("删除周报", ctx)).toBeUndefined();
    // A lone card is the only possible referent but nothing was focused: the
    // delete still asks once instead of refusing or deleting silently.
    const one = { ...ctx, focusHistory: [], cards: [ctx.cards[0]!] };
    expect(deicticDeletion("删除这个", one)).toEqual({ targetId: "note_meeting", mode: "confirm" });
  });
});
