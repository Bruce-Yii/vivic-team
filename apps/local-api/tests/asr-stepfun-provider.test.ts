import { describe, expect, it, vi } from "vitest";
import { ASR_TRANSPORT_VERSION, AsrErrorCode } from "@vivic/contracts";
import { CredentialStore } from "../src/credentials.js";
import { createAsrGatewayServer } from "../src/asrGatewayServer.js";
import { StepfunAsrProvider } from "../src/asrStepfunProvider.js";
import { createAsrGateway, type AsrSocket } from "../src/asrGateway.js";

class FakeSocket implements AsrSocket {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private messageHandler?: (data: string) => void;
  private closeHandler?: (code?: number, reason?: string) => void;

  send(message: unknown) {
    this.sent.push(message as Record<string, unknown>);
  }
  close(code?: number, reason?: string) {
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.closeHandler?.(code, reason);
  }
  onMessage(handler: (data: string) => void) {
    this.messageHandler = handler;
  }
  onClose(handler: (code?: number, reason?: string) => void) {
    this.closeHandler = handler;
  }
  isOpen() {
    return !this.closed;
  }
  emit(msg: unknown) {
    this.messageHandler?.(JSON.stringify(msg));
  }
}

const sseResponse = (events: Array<Record<string, unknown>>) => {
  const payload = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(payload));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
};

// contracts 要求 sessionId 为 UUID；网关在协议校验阶段即拒绝非 UUID。
const TEST_SESSION_ID = crypto.randomUUID();

describe("StepfunAsrProvider & AsrGatewayServer wiring", () => {
  it("streams PCM chunks and emits partial/final from StepFun SSE on commit", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        { type: "transcript.text.delta", delta: "明天" },
        { type: "transcript.text.delta", delta: "北京天气" },
        { type: "transcript.text.done", text: "明天北京天气" },
      ]),
    );

    const gateway = createAsrGateway({
      providerFactory: () =>
        new StepfunAsrProvider({
          resolveBackend: () => ({
            baseUrl: "https://api.stepfun.com/step_plan/v1",
            model: "stepaudio-2.5-asr",
            headers: { authorization: "Bearer test-key" },
            protocol: "sse",
          }),
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
    });

    const socket = new FakeSocket();
    gateway.attach(socket, { ok: true, accountId: "a1", deviceId: "d1", spaceId: "s1" });

    socket.emit({
      type: "session.start",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: TEST_SESSION_ID,
      provider: "stepfun",
      language: "zh",
      audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
    });

    expect(socket.sent.some((m) => m.type === "session.started" && m.provider === "stepfun")).toBe(true);

    const pcmChunk = new Uint8Array(640).fill(1);
    socket.emit({
      type: "audio.chunk",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: TEST_SESSION_ID,
      seq: 0,
      audio: Buffer.from(pcmChunk).toString("base64"),
    });

    expect(socket.sent.some((m) => m.type === "chunk.ack" && m.seq === 0)).toBe(true);

    socket.emit({
      type: "session.end",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: TEST_SESSION_ID,
    });

    await vi.waitFor(() => {
      expect(socket.sent.some((m) => m.type === "final" && m.text === "明天北京天气")).toBe(true);
    });

    expect(socket.sent.some((m) => m.type === "partial" && m.text === "明天北京天气")).toBe(true);
    expect(socket.sent.some((m) => m.type === "session.ended")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    gateway.dispose();
  });

  it("keeps buffered audio across a dropped socket and transcribes the resumed turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (_url: string, init?: { body?: unknown }) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return sseResponse([
        { type: "transcript.text.delta", delta: "完整" },
        { type: "transcript.text.done", text: "完整一句话" },
      ]);
    });

    const gateway = createAsrGateway({
      providerFactory: () =>
        new StepfunAsrProvider({
          resolveBackend: () => ({
            baseUrl: "https://api.stepfun.com/v1",
            model: "stepaudio-2.5-asr",
            headers: { authorization: "Bearer test-key" },
            protocol: "sse",
          }),
          fetchImpl: fetchMock as unknown as typeof fetch,
        }),
      limits: { graceMs: 5000, idleTimeoutMs: 100000 },
    });
    const auth = { ok: true, accountId: "a1", deviceId: "d1", spaceId: "s1" };
    const format = { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 };
    const sid = crypto.randomUUID();

    const first = new FakeSocket();
    gateway.attach(first, auth);
    first.emit({ type: "session.start", protocolVersion: ASR_TRANSPORT_VERSION, sessionId: sid, provider: "stepfun", language: "zh", audio: { format } });
    for (const seq of [0, 1]) {
      first.emit({ type: "audio.chunk", protocolVersion: ASR_TRANSPORT_VERSION, sessionId: sid, seq, audio: Buffer.alloc(640, 1).toString("base64") });
    }
    expect(first.sent.filter((m) => m.type === "chunk.ack")).toHaveLength(2);
    // Transport drop: the gateway closes the provider, the turn is not over yet.
    first.close();

    const second = new FakeSocket();
    gateway.attach(second, auth);
    second.emit({
      type: "session.start",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: sid,
      provider: "stepfun",
      language: "zh",
      resumeSessionId: sid,
      resumeSeq: 2,
      audio: { format },
    });
    const started = second.sent.find((m) => m.type === "session.started");
    expect(started?.resume).toBe(true);
    for (const seq of [2, 3]) {
      second.emit({ type: "audio.chunk", protocolVersion: ASR_TRANSPORT_VERSION, sessionId: sid, seq, audio: Buffer.alloc(640, 1).toString("base64") });
    }
    expect(second.sent.filter((m) => m.type === "chunk.ack")).toHaveLength(2);
    expect(second.sent.some((m) => m.type === "error")).toBe(false);

    second.emit({ type: "session.end", protocolVersion: ASR_TRANSPORT_VERSION, sessionId: sid });
    await vi.waitFor(() => {
      expect(second.sent.some((m) => m.type === "final" && m.text === "完整一句话")).toBe(true);
    });
    // Pre-drop frames were retained and committed with the resumed tail.
    const audio = (bodies[0] as { audio?: { data?: string } }).audio;
    expect(Buffer.from(String(audio?.data ?? ""), "base64")).toHaveLength(4 * 640);
    gateway.dispose();
  });

  it("fails session.start cleanly with ProviderUnavailable when credentials are missing", () => {
    const credentials = new CredentialStore();
    const { gateway } = createAsrGatewayServer({ credentials });
    const socket = new FakeSocket();
    gateway.attach(socket, { ok: true, accountId: "a1", deviceId: "d1", spaceId: "s1" });

    socket.emit({
      type: "session.start",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: crypto.randomUUID(),
      provider: "stepfun",
      language: "zh",
      audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
    });

    expect(socket.sent.some((m) => m.type === "error" && m.code === AsrErrorCode.ProviderUnavailable)).toBe(true);
    expect(socket.sent.some((m) => m.type === "session.ended" && m.reason === "provider-start-failed")).toBe(true);
    gateway.dispose();
  });

  it("rejects unsupported local provider explicitly instead of falling back to mock", () => {
    const { gateway } = createAsrGatewayServer();
    const socket = new FakeSocket();
    gateway.attach(socket, { ok: true, accountId: "a1", deviceId: "d1", spaceId: "s1" });

    socket.emit({
      type: "session.start",
      protocolVersion: ASR_TRANSPORT_VERSION,
      sessionId: crypto.randomUUID(),
      provider: "local",
      language: "zh",
      audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
    });

    expect(socket.sent.some((m) => m.type === "error" && m.code === AsrErrorCode.ProviderUnavailable)).toBe(true);
    expect(socket.sent.some((m) => m.type === "session.ended" && m.reason === "provider-start-failed")).toBe(true);
    gateway.dispose();
  });
});
