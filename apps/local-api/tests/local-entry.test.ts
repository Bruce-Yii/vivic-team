import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalApp } from "../src/index.js";
import { CredentialStore } from "../src/credentials.js";
import type { CanvasContext } from "../src/schemas.js";
import { authed, testConfig } from "./helpers.js";

const apps: Array<ReturnType<typeof createLocalApp>> = [];
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const note = (id: string, text: string): CanvasContext["cards"][number] => ({
  id, type: "NoteCard", displayProps: { text }, sourceDataSummary: {},
  layout: { x: 0, y: 0, width: 320, height: 120, pinned: false },
});
const canvas = (): CanvasContext => ({ canvasId: "TEST-local-entry", version: 2, stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], cards: [note("note-1", "读书笔记")] });

describe("the local default entry deletes through the host task manager", () => {
  it("deletes a uniquely named card once when the planner proposes it", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-local-entry", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ actions: [{ type: "card.delete", targetId: "note-1" }], spokenText: "已删除。" }) } }],
    }));
    const app = createLocalApp({ config: testConfig(), credentials, fetchImpl, providerPersist: false });
    apps.push(app);
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "删除读书笔记", canvasContext: canvas(), task: { id: "local-entry-2" } }) });
    const result = await response.json() as { kind: string; envelope?: { actions?: unknown[] }; message?: string };
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions).toContainEqual({ type: "card.delete", targetId: "note-1" });
    expect(result.message ?? "").not.toContain("确定删除");
  });

  it("explains a pointer that has no focused card instead of asking which card", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-local-entry", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ actions: [{ type: "card.delete", targetId: "note-1" }], spokenText: "已删除。" }) } }],
    }));
    const app = createLocalApp({ config: testConfig(), credentials, fetchImpl, providerPersist: false });
    apps.push(app);
    const twoNotes = { ...canvas(), cards: [note("note-1", "读书笔记"), note("note-2", "会议记录")] };
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "把刚才那张删除", canvasContext: twoNotes, task: { id: "local-entry-3" } }) });
    const result = await response.json() as { kind: string; envelope?: unknown; message?: string;
      task?: { clarification?: { candidates?: unknown[] } } };
    expect(result.kind).toBe("clarify");
    // Nothing to point at, so the host says so; it never answers a clear
    // "刚才那张" with "要删除哪张卡片？".
    expect(result.message).toContain("没有删除");
    expect(result.message).not.toContain("确定删除");
    expect(result.message).not.toMatch(/哪张|哪一张/);
    expect(result.task?.clarification?.candidates ?? []).toHaveLength(0);
    expect(result.envelope).toBeUndefined();
  });

  it("still asks before a delete that only names a shared card type", async () => {
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "TEST-local-entry", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "TEST" });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({
      choices: [{ message: { content: JSON.stringify({ actions: [{ type: "card.delete", targetId: "note-1" }], spokenText: "已删除。" }) } }],
    }));
    const app = createLocalApp({ config: testConfig(), credentials, fetchImpl, providerPersist: false });
    apps.push(app);
    const twoNotes = { ...canvas(), cards: [note("note-1", "读书笔记"), note("note-2", "会议记录")] };
    const response = await app.request("/api/intent", { method: "POST", headers: authed,
      body: JSON.stringify({ text: "删除便笺", canvasContext: twoNotes, task: { id: "local-entry-4" } }) });
    const result = await response.json() as { kind: string; envelope?: unknown; message?: string };
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("确定删除");
    expect(result.envelope).toBeUndefined();
  });
});
