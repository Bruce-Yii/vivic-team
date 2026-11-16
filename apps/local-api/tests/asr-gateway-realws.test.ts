import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { createAsrGatewayServer } from "../src/asrGatewayServer.js";
import { testConfig } from "./helpers.js";

type ServerHandle = ReturnType<typeof createAsrGatewayServer> & { port: number };

const handles: Array<ServerHandle> = [];

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await new Promise<void>((resolve) => h.server.close(() => resolve()));
  }
});

async function startServer(config = testConfig()) {
  const handle = createAsrGatewayServer({ config, port: 0 }) as ServerHandle;
  await new Promise<void>((resolve) => handle.server.listen(0, "127.0.0.1", () => resolve()));
  const addr = handle.server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  handle.port = port;
  handles.push(handle);
  return handle;
}

function connect(port: number, options: { origin?: string; token?: string } = {}) {
  const token = options.token ?? "test-token-0123456789";
  const url = `ws://127.0.0.1:${port}/asr?token=${encodeURIComponent(token)}`;
  return new Promise<{ ws: WebSocket | null; opened: boolean; code?: number; error?: Error }>((resolve) => {
    const ws = new WebSocket(url, { origin: options.origin ?? "http://localhost:5173" });
    let settled = false;
    const finish = (result: { ws: WebSocket | null; opened: boolean; code?: number; error?: Error }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    ws.on("open", () => finish({ ws, opened: true }));
    ws.on("unexpected-response", (_req, res) => finish({ ws: null, opened: false, code: res.statusCode }));
    ws.on("error", (err) => finish({ ws: null, opened: false, error: err }));
    ws.on("close", (code) => finish({ ws: null, opened: false, code }));
    setTimeout(() => finish({ ws: null, opened: false, code: 1006 }), 2000);
  });
}

describe("ASR gateway real WebSocket upgrade security", () => {
  it("rejects direct HTTP access without upgrade", async () => {
    const handle = await startServer();
    const res = await fetch(`http://127.0.0.1:${handle.port}/asr`);
    expect(res.status).toBe(404);
  });

  it("rejects cross-origin upgrade", async () => {
    const handle = await startServer();
    const result = await connect(handle.port, { origin: "http://evil.example" });
    expect(result.opened).toBe(false);
  });

  it("rejects invalid token upgrade", async () => {
    const handle = await startServer();
    const result = await connect(handle.port, { token: "wrong-token" });
    expect(result.opened).toBe(false);
  });

  it("accepts valid upgrade and starts a session", async () => {
    const handle = await startServer();
    const result = await connect(handle.port);
    expect(result.opened).toBe(true);
    const ws = result.ws!;
    const sid = randomUUID();
    const FORMAT = { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 };
    ws.send(JSON.stringify({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT } }));
    const started = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session.started") resolve(msg);
      });
    });
    expect(started).toBeTruthy();
    expect(started.protocolVersion).toBeTruthy();
    ws.close();
  });

  it("rejects expired session reuse", async () => {
    const handle = await startServer();
    const result = await connect(handle.port);
    expect(result.opened).toBe(true);
    const ws = result.ws!;
    const sid = randomUUID();
    const FORMAT = { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 };
    ws.send(JSON.stringify({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT } }));
    await new Promise((r) => setTimeout(r, 50));
    const sid2 = randomUUID();
    ws.send(JSON.stringify({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid2, audio: { format: FORMAT }, resumeSessionId: "00000000-0000-0000-0000-000000000000" }));
    const err = await new Promise<any>((resolve) => {
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "error") resolve(msg);
      });
      setTimeout(() => resolve(null), 500);
    });
    expect(err).toBeTruthy();
    ws.close();
  });
  it("rebinds a new socket within grace and continues the session", async () => {
    const handle = await startServer();
    const first = await connect(handle.port);
    expect(first.opened).toBe(true);
    const ws1 = first.ws!;
    const sid = randomUUID();
    const FORMAT = { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 };
    ws1.send(JSON.stringify({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT } }));
    await new Promise((r) => setTimeout(r, 50));
    ws1.close();
    await new Promise((r) => setTimeout(r, 50));

    const second = await connect(handle.port);
    expect(second.opened).toBe(true);
    const ws2 = second.ws!;
    ws2.send(JSON.stringify({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: Buffer.alloc(100).toString("base64") }));
    const ack = await new Promise<any>((resolve) => {
      ws2.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "chunk.ack") resolve(msg);
      });
      setTimeout(() => resolve(null), 500);
    });
    expect(ack).toBeTruthy();
    expect(ack.sessionId).toBe(sid);
    ws2.close();
  });

});