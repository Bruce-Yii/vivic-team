import { describe, expect, it, vi } from "vitest";
import { consumeSpeechSse, MSE_MAX_QUEUED_BYTES, MSE_MAX_QUEUED_CHUNKS } from "../speech";

const response = (chunks: string[]) => new Response(new ReadableStream({
  start(controller) { chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk))); controller.close(); },
}), { headers: { "content-type": "text/event-stream" } });

const sse = (...events: string[]) => events.map((event) => `${event}\n\n`).join("");

describe("streaming speech SSE terminal enforcement", () => {
  it("accepts a terminal done event", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    await consumeSpeechSse(response([sse('data: {"done":true}')]), new AbortController().signal, onDelta, onDone, onError);
    expect(onDone).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("rejects premature EOF without a terminal event", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    await expect(consumeSpeechSse(response([sse('data: {"delta":"AAAA"}')]), new AbortController().signal, onDelta, onDone, onError))
      .rejects.toThrow("语音流提前结束。");
  });

  it("rejects data after a terminal event", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    await expect(consumeSpeechSse(
      response([sse('data: {"done":true}', 'data: {"delta":"BBBB"}')]),
      new AbortController().signal, onDelta, onDone, onError,
    )).rejects.toThrow("语音流在结束事件后仍有数据。");
  });

  it("propagates a terminal error event", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn((payload: any) => { throw new Error(String(payload?.message ?? payload)); });
    await expect(consumeSpeechSse(
      response([sse('data: {"error":{"message":"boom"}}')]),
      new AbortController().signal, onDelta, onDone, onError,
    )).rejects.toThrow("boom");
    expect(onError).toHaveBeenCalled();
  });

  it("requires [DONE] to count as terminal", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    await consumeSpeechSse(response([sse("data: [DONE]")]), new AbortController().signal, onDelta, onDone, onError);
    expect(onDone).toHaveBeenCalledWith({ done: true });
  });
});

describe("streaming speech backpressure constants", () => {
  it("defines bounded queue limits", () => {
    expect(MSE_MAX_QUEUED_CHUNKS).toBeGreaterThan(0);
    expect(MSE_MAX_QUEUED_BYTES).toBeGreaterThan(0);
    expect(MSE_MAX_QUEUED_CHUNKS).toBeLessThanOrEqual(1024);
  });
});

describe("streaming speech slow consumer and network pause", () => {
  it("does not lose deltas when the consumer is slow", async () => {
    const seen: string[] = [];
    const onDelta = vi.fn(async (chunk: Uint8Array) => {
      seen.push(new TextDecoder().decode(chunk));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    const onDone = vi.fn();
    const onError = vi.fn();
    const events = ['data: {"delta":"QQ=="}', 'data: {"delta":"Qg=="}', 'data: {"done":true}'];
    await consumeSpeechSse(response([sse(...events)]), new AbortController().signal, onDelta, onDone, onError);
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("completes after a mid-flight network stall", async () => {
    const onDelta = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();
    const chunks = [
      sse('data: {"delta":"QQ=="}'),
      // stall represented by separate late chunk
    ];
    const late = sse('data: {"delta":"Qg=="}', 'data: {"done":true}');
    await consumeSpeechSse(response([chunks[0], late]), new AbortController().signal, onDelta, onDone, onError);
    expect(onDelta).toHaveBeenCalledTimes(2);
    expect(onDone).toHaveBeenCalled();
  });
});

describe("streaming speech backpressure", () => {
  it("aborts when a delta handler throws (simulated queue overflow)", async () => {
    const onDelta = vi.fn(async () => { throw new Error("queue overflow"); });
    const onDone = vi.fn();
    const onError = vi.fn();
    await expect(consumeSpeechSse(
      response([sse('data: {"delta":"QQ=="}', 'data: {"done":true}')]),
      new AbortController().signal, onDelta, onDone, onError,
    )).rejects.toThrow("queue overflow");
  });
});

describe("streaming speech cancel", () => {
  it("cancelSpeech does not throw when idle", async () => {
    const { cancelSpeech, getSpeechSnapshot } = await import("../speech");
    expect(() => cancelSpeech()).not.toThrow();
    expect(getSpeechSnapshot().status).toBe("idle");
  });
});