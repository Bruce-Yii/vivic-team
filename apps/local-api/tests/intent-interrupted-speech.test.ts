import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { formatInterruptedSpeechContext, runIntent } from "../src/intent/pipeline.js";
import { buildUserPrompt } from "../src/intent/prompt.js";
import { emptyContext } from "./helpers.js";

describe("interruptedSpeech backend consumption", () => {
  it("omits interruptedSpeech from buildUserPrompt when absent and includes it when present", () => {
    const ctx = emptyContext();
    const without = JSON.parse(buildUserPrompt("继续", ctx)) as Record<string, unknown>;
    expect("interruptedSpeech" in without).toBe(false);

    const interrupted = {
      reason: "voice" as const,
      requestId: "req-123",
      spokenText: "明天北京晴，最低",
      truncated: true,
      playedMs: 850,
    };
    const withCtx = JSON.parse(buildUserPrompt("那后天呢", ctx, undefined, interrupted)) as {
      interruptedSpeech?: typeof interrupted;
    };
    expect(withCtx.interruptedSpeech).toEqual(interrupted);
  });

  it("formats voice and ui interruption notes accurately", () => {
    expect(formatInterruptedSpeechContext({
      reason: "voice",
      requestId: "req-1",
      spokenText: "明天有三班直飞",
      truncated: true,
      playedMs: 700,
    })).toContain("语音打断");
    expect(formatInterruptedSpeechContext({
      reason: "ui",
      requestId: null,
      spokenText: "",
      truncated: true,
      playedMs: 0,
    })).toContain("界面操作打断");
  });

  it("forwards interruptedSpeech into the legacy planner user payload", async () => {
    const captured: string[] = [];
    const credentials = new CredentialStore();
    credentials.set({ apiKey: "test-key", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "2026-11-19T00:00:00Z" });

    const result = await runIntent(
      {
        text: "换成后天",
        canvasContext: emptyContext(),
        interruptedSpeech: {
          reason: "voice",
          requestId: "req-abc",
          spokenText: "明天下午有三班",
          truncated: true,
          playedMs: 900,
        },
      },
      {
        credentials,
        stepfun: { baseUrl: "https://api.stepfun.com/v1" },
        planner: {
          provider: "stepfun",
          connected: true,
          isCurrent: () => true,
          generate: async (messages) => {
            const userMsg = messages.find((m) => m.role === "user");
            if (typeof userMsg?.content === "string") captured.push(userMsg.content);
            return { ok: true, value: { reply: "好的，已按您的要求调整。" } };
          },
        },
      },
    );

    expect(result.kind).toBe("envelope");
    expect(captured).toHaveLength(1);
    const parsed = JSON.parse(captured[0]!) as { interruptedSpeech?: { spokenText: string; truncated: boolean } };
    expect(parsed.interruptedSpeech).toMatchObject({
      spokenText: "明天下午有三班",
      truncated: true,
    });
  });

  it("injects interruptedSpeech context into the tool-calling user message only when present", async () => {
    const sentBodies: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentBodies.push(JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> });
      return new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "chat", arguments: JSON.stringify({ reply: "好的，只看早上的航班。" }) },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const credentials = new CredentialStore();
    credentials.set({ apiKey: "test-key", models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "2026-11-19T00:00:00Z" });

    await runIntent(
      {
        text: "只要早上的",
        canvasContext: emptyContext(),
        interruptedSpeech: {
          reason: "ui",
          requestId: "req-xyz",
          spokenText: "下午两点有一班",
          truncated: true,
          playedMs: 650,
        },
      },
      {
        credentials,
        stepfun: { baseUrl: "https://api.stepfun.com/v1", fetchImpl: fetchMock as unknown as typeof fetch },
        toolCalls: true,
      },
    );

    expect(sentBodies).toHaveLength(1);
    const userMessage = sentBodies[0]!.messages.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("界面操作打断");
    expect(userMessage).toContain("下午两点有一班");
    expect(userMessage).toContain("只要早上的");
  });
});
