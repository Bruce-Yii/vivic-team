import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createAsrGatewayServer } from "../src/asrGatewayServer.js";
import { loadConfig } from "../src/config.js";
import WebSocket from "ws";

/**
 * Live probe: synthetic Chinese speech (Windows SAPI, 16 kHz mono PCM) through
 * the real gateway → StepFunAsrProvider → StepFun `/v1/audio/asr/sse`.
 *
 * Skipped unless VIVIC_STEPFUN_API_KEY is present, so CI (no credentials) stays
 * green. It costs one short transcription run when enabled.
 */

const KEY = process.env.VIVIC_STEPFUN_API_KEY?.trim();
const fixture = fileURLToPath(new URL("./fixtures/asr-probe-zh.wav", import.meta.url));
const PROTOCOL = "vivic-asr-protocol@1";

function pcmFromWav(path: string): Buffer {
  const wav = readFileSync(path);
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") return wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error("no data chunk in fixture");
}

describe.skipIf(!KEY)("live StepFun ASR through the gateway", () => {
  it("transcribes synthetic speech end to end", async () => {
    const pcm = pcmFromWav(fixture);
    const token = `probe-${randomUUID()}`;
    const { server } = createAsrGatewayServer({ config: { ...loadConfig(), token }, port: 0 });
    const address = await new Promise<{ port: number }>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve(server.address() as { port: number }));
    });
    const frames: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/asr`, {
      headers: { authorization: `Bearer ${token}`, "x-device-id": "vitest" },
    });
    const settled = new Promise<void>((resolve) => {
      const done = () => resolve();
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        frames.push(frame);
        if (frame.type === "session.ended" || frame.type === "error") done();
      });
      setTimeout(done, 45_000);
    });
    try {
      await new Promise<void>((resolve) => socket.on("open", () => resolve()));
      const sessionId = randomUUID();
      socket.send(JSON.stringify({ type: "session.start", protocolVersion: PROTOCOL, sessionId,
        provider: "stepfun", language: "zh",
        audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } } }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      const acks = new Map<number, () => void>();
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw)) as { type?: string; seq?: number };
        if (frame.type === "chunk.ack" && typeof frame.seq === "number") acks.get(frame.seq)?.();
      });
      const CHUNK = 3200;
      let seq = 0;
      for (let i = 0; i < pcm.length; i += CHUNK) {
        const current = seq++;
        const acked = new Promise<void>((resolve) => { acks.set(current, resolve); setTimeout(resolve, 3000); });
        socket.send(JSON.stringify({ type: "audio.chunk", protocolVersion: PROTOCOL, sessionId, seq: current,
          audio: pcm.subarray(i, i + CHUNK).toString("base64") }));
        await acked;
        acks.delete(current);
      }
      socket.send(JSON.stringify({ type: "session.end", protocolVersion: PROTOCOL, sessionId }));
      await settled;
    } finally {
      socket.terminate();
      server.close();
    }

    const started = frames.find((f) => f.type === "session.started");
    expect(started, JSON.stringify(frames.slice(0, 3))).toMatchObject({ provider: "stepfun" });
    const final = frames.find((f) => f.type === "final") as { text?: string } | undefined;
    expect(final?.text, JSON.stringify(frames.filter((f) => f.type === "error"))).toContain("开会");
    expect(frames.some((f) => f.type === "partial")).toBe(true);
    expect(frames.find((f) => f.type === "session.ended")).toMatchObject({ reason: "completed" });
  }, 60_000);
});
