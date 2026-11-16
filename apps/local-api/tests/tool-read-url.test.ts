import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { planFromToolCalls } from "../src/intent/toolCalls.js";
import { createIntentLogSink } from "../src/observability/intentLog.js";
import { SearchError } from "../src/search/errors.js";
import type { FetchEvidence } from "../src/search/client.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * End-to-end model tool call: the fake model transport chooses `read_url`, the
 * host reads one page, hands the title + excerpt back in exactly one turn, and
 * the model then creates its own card. No live provider, no real page.
 */

const canvas = (): CanvasContext => ({ canvasId: "TEST-read-url", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [] });

const page = (): FetchEvidence => ({ url: "https://example.com/a", title: "示例文章",
  text: "第一段正文。第二段正文。", contentType: "text/markdown", format: "extracted-text",
  fetchedAt: new Date().toISOString(), provider: "vivic-bounded-https", readFullPage: true,
  truncated: false, trust: "untrusted-web-data" });

type Call = { name: string; args: Record<string, unknown> };

/** A model transport that answers each turn with the given tool calls. */
function modelTransport(turns: Call[][], bodies: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const turn = turns.shift();
    if (!turn) throw new Error("unexpected extra model turn");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(turn).map((call, index) => ({
      index, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const credential = { apiKey: "TEST-read-url-tool-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: "TEST" };

function setup(args: { turns: Call[][]; readUrl?: (url: string) => Promise<FetchEvidence> }) {
  const bodies: string[] = [];
  const fetchImpl = modelTransport(args.turns, bodies);
  const readUrl = vi.fn(args.readUrl ?? (async () => page()));
  const deps: PipelineDeps = {
    credentials: new CredentialStore(),
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    mainProvider: "deepseek",
    // A connected planner keeps the offline gate from ending the turn; the tool
    // layer still owns it because `toolCalls` is on and a tool credential exists.
    planner: { provider: "deepseek", connected: true, isCurrent: () => true,
      generate: async () => ({ ok: true, value: { reply: "unused" } }) },
    toolCalls: true,
    toolCredential: credential,
    intentLog: createIntentLogSink(),
    search: { webSearch: async () => [], fetchContent: async () => { throw new Error("unused"); }, readUrl },
  };
  return { deps, bodies, readUrl, fetchImpl };
}

const cards = (result: Awaited<ReturnType<typeof runIntent>>) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card.type] : []) ?? [];

describe("read_url model tool call", () => {
  it("reads once, feeds the excerpt back, and commits the model's own card", async () => {
    const h = setup({ turns: [
      [{ name: "read_url", args: { url: "https://example.com/a" } }],
      [{ name: "create_card", args: { kind: "note", fields: { title: "网页摘要", sections: [{ title: "正文", items: ["第一段正文"] }] } } }],
    ] });
    const result = await runIntent({ text: "读一下 https://example.com/a 并总结成便签", canvasContext: canvas() }, h.deps);
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(result.toolCalls).toBe(true);
    expect(cards(result)).toEqual(["NoteCard"]);
    expect(h.readUrl).toHaveBeenCalledTimes(1);
    expect(h.readUrl).toHaveBeenCalledWith("https://example.com/a", expect.any(AbortSignal));
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
    // The second model turn actually saw the page excerpt (not raw HTML).
    expect(h.bodies[1]).toContain("示例文章");
    expect(h.bodies[1]).toContain("第一段正文");
    expect(h.deps.intentLog).toMatchObject({ path: "tool-lookup", lookup: { tool: "read_url", outcome: "ok" } });
  });

  it("never publishes the page card on its own: a bare chat is pushed to answer from the facts", async () => {
    const h = setup({ turns: [
      [{ name: "read_url", args: { url: "https://example.com/a" } }],
      [{ name: "chat", args: {} }],
      [{ name: "chat", args: { reply: "这篇讲的是两段示例正文。" } }],
    ] });
    const result = await runIntent({ text: "读一下这个链接 https://example.com/a", canvasContext: canvas() }, h.deps);
    expect(result.kind).toBe("envelope");
    // The article card is the model's decision now; a chat without text does not
    // commit the host's page card behind the model's back.
    expect(cards(result)).toEqual([]);
    expect(result.envelope?.spokenText).toBe("这篇讲的是两段示例正文。");
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
    expect(h.bodies[2]).toContain("chat 缺少 reply");
  });

  it("fails honestly when the page cannot be read", async () => {
    const h = setup({
      turns: [[{ name: "read_url", args: { url: "https://example.com/a" } }]],
      readUrl: async () => { throw new SearchError("search-blocked-url", "仅可读取公开 HTTPS 网页。", 400); },
    });
    const result = await runIntent({ text: "读一下 https://example.com/a", canvasContext: canvas() }, h.deps);
    expect(result.kind).toBe("clarify");
    expect(result.message).toContain("网页没读成");
    expect(result.message).toContain("仅可读取公开 HTTPS 网页");
    expect(cards(result)).toEqual([]);
  });

  it("rejects a read_url mixed with card tools at plan validation", async () => {
    const plan = await planFromToolCalls([
      { name: "read_url", arguments: { url: "https://example.com/a" } },
      { name: "create_card", arguments: { kind: "note", fields: { text: "摘要" } } },
    ], canvas(), Date.now(), "读一下 https://example.com/a 并建个便签");
    expect(plan.kind).toBe("invalid");
    expect(plan.issues.join("；")).toContain("read_url 必须单独调用");
  });
});
