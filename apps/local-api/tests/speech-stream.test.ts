import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { STEPFUN_PLAN_BASE_URL } from "../src/config.js";
import { CredentialStore } from "../src/credentials.js";
import { authed, fetchStub, testConfig } from "./helpers.js";

const SECRET = "unit-speech-stream-key-only";
const PART = Buffer.from([0x49, 0x44, 0x33, 0x01]);
const TAIL = Buffer.from([0x02, 0x03, 0x04]);
const TEXT = "你好";

const setup = (fetchImpl: typeof fetch) => {
  const credentials = new CredentialStore();
  credentials.set({ apiKey: SECRET, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
  return createApp({
    config: testConfig({ stepfunBaseUrl: STEPFUN_PLAN_BASE_URL, speechTimeoutMs: 1000 }),
    credentials, fetchImpl,
  });
};

const sse = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`;
const delta = (bytes: Buffer) => sse({ type: "speech.audio.delta", audio: bytes.toString("base64") });
const finished = (...buffers: Buffer[]) => [
  ...buffers.map(delta), sse({ type: "speech.audio.done", audio: "" }), sse("[DONE]"),
].join("");
const encoder = new TextEncoder();

/** An upstream SSE body whose second half is withheld until `release()`. */
const gatedUpstream = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let completed = false;
  const response = new Response(new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(delta(PART)));
      await gate;
      controller.enqueue(encoder.encode(finished(TAIL)));
      completed = true;
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
  return { response, release, isCompleted: () => completed };
};

/** Minimal SSE line reader so a test can observe events while upstream is open. */
const readerFor = (body: ReadableStream<Uint8Array> | null) => {
  const reader = body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  const next = async (): Promise<Record<string, unknown> | null> => {
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (data) return JSON.parse(data) as Record<string, unknown>;
        continue;
      }
      if (ended) return null;
      const part = await reader.read();
      if (part.done) { ended = true; buffer = ""; return null; }
      buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, "\n");
    }
  };
  return { next, cancel: () => reader.cancel() };
};

const speak = (app: ReturnType<typeof createApp>, query = "", accept?: string, body: unknown = { text: TEXT }) =>
  app.request(`/api/speech${query}`, {
    method: "POST",
    headers: { ...authed, ...(accept ? { accept } : {}) },
    body: JSON.stringify(body),
  });

const captureLogs = () => {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    for (const line of String(chunk).split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (parsed.event === "speech") lines.push(parsed);
      } catch { /* not our line */ }
    }
    return true;
  });
  return { lines, restore: () => spy.mockRestore() };
};

describe("POST /api/speech streaming", () => {
  it("relays each audio delta before the upstream stream finishes", async () => {
    const upstream = gatedUpstream();
    const app = setup(fetchStub({ "/audio/speech": () => upstream.response }));
    const response = await speak(app, "?stream=1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = readerFor(response.body);

    // The first delta must be observable while the fake upstream is still gated.
    const first = await events.next();
    expect(first).toEqual({ delta: PART.toString("base64") });
    expect(upstream.isCompleted()).toBe(false);

    upstream.release();
    expect(await events.next()).toEqual({ delta: TAIL.toString("base64") });
    expect(await events.next()).toEqual({ done: true, audioBytes: PART.length + TAIL.length });
    expect(await events.next()).toBeNull();
  });

  it("accepts Accept: text/event-stream and logs an opaque metrics line", async () => {
    const logs = captureLogs();
    try {
      const upstream = gatedUpstream();
      const app = setup(fetchStub({ "/audio/speech": () => upstream.response }));
      const response = await speak(app, "", "text/event-stream");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const requestId = response.headers.get("x-request-id");
      expect(requestId).toBeTruthy();

      const events = readerFor(response.body);
      expect(await events.next()).toEqual({ delta: PART.toString("base64") });
      await new Promise(resolve => setTimeout(resolve, 30));
      upstream.release();
      while (await events.next() !== null) { /* drain */ }

      const line = logs.lines.find(entry => entry.requestId === requestId);
      expect(line).toMatchObject({
        event: "speech", requestId, textChars: TEXT.length, stream: true, audioBytes: PART.length + TAIL.length, error: null,
      });
      expect(typeof line?.firstByteMs).toBe("number");
      expect(line!.firstByteMs!).toBeLessThanOrEqual(line!.totalMs as number);
      expect(JSON.stringify(line)).not.toContain(TEXT);
    } finally {
      logs.restore();
    }
  });

  it("reports a malformed upstream stream as a terminal SSE error", async () => {
    const logs = captureLogs();
    try {
      const app = setup(fetchStub({ "/audio/speech": () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(delta(PART)));
          controller.enqueue(encoder.encode(sse({ type: "speech.audio.error", error: "TEST private upstream body" })));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } }) }));
      const response = await speak(app, "?stream=1");
      const events = readerFor(response.body);
      expect(await events.next()).toEqual({ delta: PART.toString("base64") });
      const failure = await events.next();
      expect(failure).toMatchObject({ error: { code: "speech-invalid-stream" } });
      expect(JSON.stringify(failure)).not.toContain("TEST private upstream body");
      expect(await events.next()).toBeNull();
      expect(logs.lines.at(-1)).toMatchObject({ stream: true, error: "speech-invalid-stream" });
    } finally {
      logs.restore();
    }
  });

  it("returns a real JSON error before opening SSE when the Plan route is invalid", async () => {
    const logs = captureLogs();
    try {
      const credentials = new CredentialStore();
      credentials.set({ apiKey: SECRET, models: ["step-3.5-flash"], defaultModel: "step-3.5-flash", checkedAt: "now" });
      const app = createApp({
        config: testConfig({ stepfunBaseUrl: "https://api.stepfun.com/v1", speechTimeoutMs: 1000 }),
        credentials, fetchImpl: vi.fn<typeof fetch>(),
      });
      const response = await speak(app, "?stream=1");
      expect(response.status).toBe(503);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toMatchObject({ ok: false, code: "speech-plan-required" });
      expect(logs.lines.at(-1)).toMatchObject({ stream: true, error: "speech-plan-required" });
    } finally {
      logs.restore();
    }
  });

  it("returns an SSE error when upstream rejects the request", async () => {
    const logs = captureLogs();
    try {
      const app = setup(fetchStub({ "/audio/speech": () => new Response("upstream echo", { status: 500 }) }));
      const response = await speak(app, "?stream=1");
      expect(response.status).toBe(200);
      const events = readerFor(response.body);
      expect(await events.next()).toMatchObject({ error: { code: "speech-unavailable" } });
      expect(await events.next()).toBeNull();
      expect(logs.lines.at(-1)).toMatchObject({ stream: true, error: "speech-unavailable" });
    } finally {
      logs.restore();
    }
  });

  it("streams validated timestamps in the terminal event when requested", async () => {
    const calls: string[] = [];
    const app = setup(fetchStub({ "/audio/speech": (init) => {
      calls.push(String(init?.body));
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "stepaudio-2.5-tts", input: TEXT, timestamp: true, stream_format: "sse",
      });
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode([
            delta(PART),
            sse({ type: "response.subtitle", data: { text: TEXT, items: [
              { text: "你", start_time: 0, end_time: 100 }, { text: "好", start_time: 100, end_time: 200 },
            ] } }),
            delta(TAIL), sse({ type: "speech.audio.done", audio: "" }), sse("[DONE]"),
          ].join("")));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    } }));
    const response = await speak(app, "?stream=1", "text/event-stream", { text: TEXT, timestamps: true });
    const events = readerFor(response.body);
    expect(await events.next()).toEqual({ delta: PART.toString("base64") });
    expect(await events.next()).toEqual({ delta: TAIL.toString("base64") });
    expect(await events.next()).toEqual({
      done: true, audioBytes: PART.length + TAIL.length,
      words: [{ startMs: 0, endMs: 100, charStart: 0, charEnd: 1 }, { startMs: 100, endMs: 200, charStart: 1, charEnd: 2 }],
    });
    expect(calls).toHaveLength(1);
  });

  it("keeps the buffered binary response for clients that do not opt in", async () => {
    const logs = captureLogs();
    try {
      const audio = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0]);
      const app = setup(fetchStub({ "/audio/speech": () => new Response(audio, { headers: { "content-type": "audio/mpeg" } }) }));
      const response = await speak(app);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/mpeg");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
      // The response is fully returned before the middleware logs.
      await vi.waitFor(() => expect(logs.lines.length).toBe(1));
      expect(logs.lines[0]).toMatchObject({
        stream: false, textChars: TEXT.length, audioBytes: audio.byteLength, error: null,
      });
      expect(typeof logs.lines[0]?.firstByteMs).toBe("number");
    } finally {
      logs.restore();
    }
  });
});
