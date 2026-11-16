import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type PipelineDeps } from "../src/intent/pipeline.js";
import { buildToolSystemPrompt, planFromToolCalls, TOOL_DEFINITIONS } from "../src/intent/toolCalls.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * sc-19: the model sent the user's spoken sentence as the search query
 * (「最近 AI 大新闻」). Bing's Chinese tokenizer made 最近 the head and returned a
 * song and a dictionary entry, no AI news. The fix is a keyword contract plus a
 * deterministic backstop: the host refuses the two shapes it can prove are not
 * keywords and hands the call back for one repair turn. It never rewrites the
 * model's query itself.
 *
 * These tests use the pure mapper: no model, no network.
 */

const canvas = (): CanvasContext => ({
  canvasId: "TEST-search-query-rewrite", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [],
});

const search = (query: string, utterance: string) =>
  planFromToolCalls([{ name: "search", arguments: { query } }], canvas(), Date.now(), utterance);

describe("search query must be keywords, not the user's sentence", () => {
  it("rejects the whole spoken sentence verbatim", async () => {
    const plan = await search("最近有什么 AI 大新闻？", "最近有什么 AI 大新闻？");
    expect(plan.kind).toBe("invalid");
    expect(plan.issues[0]!.code).toBe("invalid-param");
    expect(String(plan.issues[0])).toContain("整句原话");
    expect(plan.issues[0]!.hint).toContain("AI 行业新闻 2026年11月");
    expect(plan.lookup).toBeUndefined();
  });

  it("rejects a long query that opens with a conversational filler", async () => {
    const plan = await search("最近 AI 大新闻", "最近有什么 AI 大新闻");
    expect(plan.kind).toBe("invalid");
    expect(plan.issues[0]!.code).toBe("invalid-param");
    expect(String(plan.issues[0])).toContain("最近");
    expect(plan.issues[0]!.hint).toContain("黄金价格 今日");
  });

  it("rejects 帮我/我想知道 openers too", async () => {
    for (const query of ["帮我查一下今天黄金价格多少", "我想知道最近 AI 有什么进展"]) {
      const plan = await search(query, "帮我查一下");
      expect(plan.kind, query).toBe("invalid");
      expect(plan.issues[0]!.code).toBe("invalid-param");
    }
  });

  it("lets a keyword query through untouched", async () => {
    const plan = await search("AI 行业新闻 2026年11月", "最近有什么 AI 大新闻");
    expect(plan.kind).toBe("lookup");
    expect(plan.lookup).toEqual({ kind: "search", query: "AI 行业新闻 2026年11月" });
  });

  it("does not misfire on the short original 天气", async () => {
    const plan = await search("天气", "天气");
    expect(plan.kind).toBe("lookup");
    expect(plan.lookup).toEqual({ kind: "search", query: "天气" });
  });

  it("ignores punctuation, spaces and case when comparing with the utterance", async () => {
    const plan = await search("最近有什么AI大新闻", "最近有什么 AI 大新闻！");
    expect(plan.kind).toBe("invalid");
    expect(plan.issues[0]!.code).toBe("invalid-param");
  });
});

describe("the keyword contract is written into the prompt and the tool description", () => {
  it("gives both positive and negative examples", () => {
    const prompt = buildToolSystemPrompt(canvas());
    for (const example of ["AI 行业新闻 2026年11月", "黄金价格 今日"]) expect(prompt).toContain(example);
    for (const anti of ["最近有什么 AI 大新闻", "查一下现在黄金多少钱一克"]) expect(prompt).toContain(anti);
    const description = TOOL_DEFINITIONS.find(tool => tool.function.name === "search")!.function.description;
    expect(description).toContain("关键词");
    for (const example of ["AI 行业新闻 2026年11月", "黄金价格 今日"]) expect(description).toContain(example);
    for (const anti of ["最近有什么 AI 大新闻", "查一下现在黄金多少钱一克"]) expect(description).toContain(anti);
  });

  it("keeps the query schema keyword-oriented in its example", () => {
    const query = (TOOL_DEFINITIONS.find(tool => tool.function.name === "search")!.function.parameters
      .properties as Record<string, { description?: string }>).query;
    expect(query?.description).toContain("AI 行业新闻 2026年11月");
  });
});

describe("a rejected sentence costs one repair turn, not a silent search", () => {
  const credential = { apiKey: "TEST-search-query-key", models: ["deepseek-flash"],
    defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };
  interface ToolReply { name: string; args: Record<string, unknown> }
  interface ChatBody { messages: Array<{ role: string; content: string }> }

  it("refuses the sentence, carries the issue, and searches the corrected keywords once", async () => {
    const replies: ToolReply[][] = [
      [{ name: "search", args: { query: "最近有什么 AI 大新闻？" } }],
      [{ name: "search", args: { query: "AI 行业新闻 2026年11月" } }],
      [{ name: "chat", args: { reply: "最近的 AI 新闻集中在多模态和推理成本。" } }],
    ];
    const calls: ChatBody[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as ChatBody);
      const batch = replies.shift();
      if (!batch) throw new Error("unexpected extra model turn");
      return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(batch).map((reply, index) => ({
        index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
      })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const deps: PipelineDeps = { credentials: new CredentialStore(),
      stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
      planner: { provider: "deepseek", connected: true, isCurrent: () => true,
        generate: async () => ({ ok: true, value: { reply: "unused planner" } }) },
      mainProvider: "deepseek", toolCalls: true, toolCredential: credential };
    const webSearch = vi.fn(async (_query: string) => [{
      title: "AI 新闻综述", url: "https://example.com/ai-news", snippet: "多模态模型与推理成本进展。",
      fetchedAt: new Date().toISOString(), provider: "pi-web-access/exa-mcp-keyless" as const, readFullPage: false as const,
    }]);
    const result = await runIntent({ text: "最近有什么 AI 大新闻？", canvasContext: canvas() },
      { ...deps, search: { webSearch } });
    // The repair turn saw the keyword rule; only the corrected query reached Bing.
    expect(calls).toHaveLength(3);
    expect(calls[1]!.messages.at(-1)!.content).toContain("关键词");
    expect(webSearch).toHaveBeenCalledTimes(1);
    expect(String(webSearch.mock.calls[0]![0])).toBe("AI 行业新闻 2026年11月");
    expect(result.kind).toBe("envelope");
    expect(result.envelope?.actions.some(action => action.type === "card.create")).toBe(false);
  });
});
