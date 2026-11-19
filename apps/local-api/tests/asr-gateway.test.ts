import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { createAsrGateway } from "../src/asrGateway.js";
import { ASR_BACKPRESSURE_MAX_CHUNKS } from "@vivic/contracts";

class FakeSocket {
  sent: any[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;
  private messageHandlers: ((d: string) => void)[] = [];
  private closeHandlers: ((c?: number, r?: string) => void)[] = [];
  send(m: unknown) { this.sent.push(m); }
  close(c?: number, r?: string) {
    this.closed = true;
    this.closeCode = c;
    this.closeReason = r;
    for (const h of this.closeHandlers) h(c, r);
  }
  onMessage(h: (d: string) => void) { this.messageHandlers.push(h); }
  onClose(h: (c?: number, r?: string) => void) { this.closeHandlers.push(h); }
  isOpen() { return !this.closed; }
  emitMessage(obj: unknown) {
    const raw = JSON.stringify(obj);
    for (const h of this.messageHandlers) h(raw);
  }
}

const PCM = (n: number) => Buffer.alloc(n).toString("base64");
const FORMAT = { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 };

describe("ASR gateway auth", () => {
  it("rejects unauthenticated socket", () => {
    const gw = createAsrGateway();
    const sock = new FakeSocket();
    const ok = gw.attach(sock, { ok: false, code: 401, error: "asr-unauthorized" });
    expect(ok).toBe(false);
    expect(sock.closed).toBe(true);
  });
});

describe("ASR gateway session lifecycle", () => {
  it("starts, acks chunk, and ends with final", async () => {
    const gw = createAsrGateway();
    const sock = new FakeSocket();
    gw.attach(sock, { ok: true, accountId: "a", deviceId: "d", spaceId: "s" });
    const sid = randomUUID();
    sock.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10, partialDelayMs: 10 } });
    await new Promise((r) => setTimeout(r, 0));
    const started = sock.sent.find((m) => m.type === "session.started");
    expect(started).toBeTruthy();
    expect(started.resume).toBe(false);

    sock.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: PCM(3200) });
    await new Promise((r) => setTimeout(r, 0));
    const ack = sock.sent.find((m) => m.type === "chunk.ack" && m.seq === 0);
    expect(ack).toBeTruthy();

    sock.emitMessage({ type: "session.end", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, reason: "done" });
    await new Promise((r) => setTimeout(r, 50));
    const ended = sock.sent.find((m) => m.type === "session.ended");
    expect(ended).toBeTruthy();
    expect(sock.sent.some((m) => m.type === "final")).toBe(true);
  });
});

describe("ASR gateway cancel", () => {
  it("cancels and emits cancelled ended", () => {
    const gw = createAsrGateway();
    const sock = new FakeSocket();
    gw.attach(sock, { ok: true, accountId: "a", deviceId: "d", spaceId: "s" });
    const sid = randomUUID();
    sock.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    sock.emitMessage({ type: "cancel", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, reason: "user" });
    const ended = sock.sent.find((m) => m.type === "session.ended");
    expect(ended).toBeTruthy();
    expect(ended.reason).toBe("cancelled");
  });
});

describe("ASR gateway backpressure", () => {
  it("emits asr-backpressure when buffer exceeds cap", () => {
    const gw = createAsrGateway({ limits: { backpressureMaxChunks: 100, backpressureMaxBytes: 1000000 } });
    const sock = new FakeSocket();
    gw.attach(sock, { ok: true, accountId: "a", deviceId: "d", spaceId: "s" });
    const sid = randomUUID();
    sock.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10, backpressureAfterChunks: 2 } });
    // burst 3 chunks synchronously; provider applies backpressure on the 2nd
    sock.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: PCM(100) });
    sock.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 1, audio: PCM(100) });
    sock.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 2, audio: PCM(100) });
    const bp = sock.sent.find((m) => m.type === "error" && m.code === "asr-backpressure");
    expect(bp).toBeTruthy();
  });
});

describe("ASR gateway reconnection", () => {
  it("resumes within grace window", () => {
    const gw = createAsrGateway({ limits: { graceMs: 1000, idleTimeoutMs: 100000 } });
    const sock1 = new FakeSocket();
    gw.attach(sock1, { ok: true, accountId: "a", deviceId: "d", spaceId: "s" });
    const sid = randomUUID();
    sock1.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    sock1.close(1000, "done");

    const sock2 = new FakeSocket();
    gw.attach(sock2, { ok: true, accountId: "a", deviceId: "d", spaceId: "s" });
    sock2.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, resumeSessionId: sid, mock: { finalDelayMs: 10 } });
    const started = sock2.sent.find((m) => m.type === "session.started");
    expect(started).toBeTruthy();
    expect(started.resume).toBe(true);
  });
});
describe("ASR resume sequence rebase", () => {
  it("accepts frames after resume when the client rebases its sequence", () => {
    const gw = createAsrGateway({ limits: { graceMs: 1000, idleTimeoutMs: 100000 } });
    const auth = { ok: true, accountId: "acct-r", deviceId: "dev-r" };
    const sid = randomUUID();
    const sock1 = new FakeSocket();
    gw.attach(sock1, auth);
    sock1.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    // Three frames delivered before the drop.
    for (const seq of [0, 1, 2]) sock1.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq, audio: PCM(100) });
    sock1.close(1000, "drop");

    const sock2 = new FakeSocket();
    gw.attach(sock2, auth);
    // Reconnect and continue from seq 3 without replaying 0..2.
    sock2.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, resumeSessionId: sid, resumeSeq: 3, mock: { finalDelayMs: 10 } });
    sock2.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 3, audio: PCM(100) });

    const ack = sock2.sent.find((m) => m.type === "chunk.ack" && m.seq === 3);
    expect(ack).toBeTruthy();
    expect(sock2.sent.some((m) => m.type === "error")).toBe(false);
  });

  it("rebases even when the client restarts numbering at zero", () => {
    const gw = createAsrGateway({ limits: { graceMs: 1000, idleTimeoutMs: 100000 } });
    const auth = { ok: true, accountId: "acct-z", deviceId: "dev-z" };
    const sid = randomUUID();
    const sock1 = new FakeSocket();
    gw.attach(sock1, auth);
    sock1.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    for (const seq of [0, 1, 2, 3]) sock1.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq, audio: PCM(100) });
    sock1.close(1000, "drop");

    const sock2 = new FakeSocket();
    gw.attach(sock2, auth);
    sock2.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, resumeSessionId: sid, resumeSeq: 0, mock: { finalDelayMs: 10 } });
    sock2.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: PCM(100) });

    expect(sock2.sent.find((m) => m.type === "chunk.ack" && m.seq === 0)).toBeTruthy();
  });
});

describe("ASR gateway reconnection audio", () => {
  it("binds a new socket within grace and acks audio", () => {
    const gw = createAsrGateway({ limits: { graceMs: 1000, idleTimeoutMs: 100000 } });
    const auth = { ok: true, accountId: "acct-a", deviceId: "dev-a" };
    const sock1 = new FakeSocket();
    gw.attach(sock1, auth);
    const sid = randomUUID();
    sock1.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    sock1.close(1000, "done");

    const sock2 = new FakeSocket();
    gw.attach(sock2, auth);
    sock2.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: PCM(100) });
    const ack = sock2.sent.find((m) => m.type === "chunk.ack" && m.seq === 0);
    expect(ack).toBeTruthy();
  });

  it("rejects cross-identity resume and operation", () => {
    const gw = createAsrGateway({ limits: { graceMs: 1000, idleTimeoutMs: 100000 } });
    const authA = { ok: true, accountId: "acct-a", deviceId: "dev-a" };
    const authB = { ok: true, accountId: "acct-b", deviceId: "dev-b" };
    const sock1 = new FakeSocket();
    gw.attach(sock1, authA);
    const sid = randomUUID();
    sock1.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, audio: { format: FORMAT }, mock: { finalDelayMs: 10 } });
    sock1.close(1000, "done");

    const sock2 = new FakeSocket();
    gw.attach(sock2, authB);
    sock2.emitMessage({ type: "session.start", protocolVersion: "vivic-asr-protocol@1", sessionId: randomUUID(), audio: { format: FORMAT }, resumeSessionId: sid, mock: { finalDelayMs: 10 } });
    const resumeErr = sock2.sent.find((m) => m.type === "error" && (m.code === "asr-unauthorized" || m.code === "session-not-found"));
    expect(resumeErr).toBeTruthy();

    const sock3 = new FakeSocket();
    gw.attach(sock3, authB);
    sock3.emitMessage({ type: "audio.chunk", protocolVersion: "vivic-asr-protocol@1", sessionId: sid, seq: 0, audio: PCM(100) });
    const opErr = sock3.sent.find((m) => m.type === "error" && (m.code === "asr-unauthorized" || m.code === "session-not-found"));
    expect(opErr).toBeTruthy();
  });
});
