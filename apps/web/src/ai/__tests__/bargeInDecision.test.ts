import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getFullDuplexSnapshot, setFullDuplexCommandHandler, startFullDuplex, stopFullDuplex } from "../fullDuplex";

/**
 * C1 barge-in at the real decision point.
 *
 * Everything below the device boundary is the production code that ships:
 * `startFullDuplex` -> AudioWorklet packet handler -> `createSpeechSegmentDetector`
 * -> `AsrGatewayClient` callbacks -> the `onFinal` playback branch ->
 * `looksLikeSelfEcho` / `classifyIntent` / `handleUserTranscript`.
 *
 * Only three device/network boundaries are faked, because this suite runs on a
 * machine with no microphone and must never call a paid API:
 *   - `AudioContext` / `AudioWorkletNode` / `getUserMedia` (a 2048-sample packet
 *     stream is injected by hand, exactly like `audio-capture-worklet.js`),
 *   - the WebSocket ASR transport (the real callback object is captured),
 *   - the `<audio>` element behind `speech.ts` (its barge-in calls are recorded).
 *
 * Measured with the real stack on 2026-11-20: VAD onset fires after 256ms of
 * frame time (160ms configured onset, quantized by 128ms AudioWorklet packets),
 * `duckSpeech()` runs in the same tick, and `confirmBargeIn()` only runs once the
 * ASR final transcript arrives.
 */

const FRAME_SAMPLES = 2048; // audio-capture-worklet.js packet size
const FRAME_MS = (FRAME_SAMPLES / 16000) * 1000; // 128ms
const PLAYING = "明天下午三点提醒你开会，到时候我会提前十分钟通知你。";

const bi = vi.hoisted(() => {
  const events: string[] = [];
  const snapshot: Record<string, unknown> = {
    enabled: true,
    status: "playing",
    loading: false,
    playing: true,
    requestId: "req-1",
    text: "明天下午三点提醒你开会，到时候我会提前十分钟通知你。",
    kind: "feedback",
    source: "stepfun",
    amplitude: 0.4,
    wordRange: null,
    error: null,
    preferences: { voice: "wenrounvsheng", speed: 1.3, volume: 1 },
    preferenceError: null,
    playbackLedger: {
      mode: "mse", firstByteMs: 120, firstAudibleFrameMs: 180, timeToFirstPlayingMs: 180,
      playedMs: 900, audioBytesReceived: 4096, segmentsReceived: 2, segmentsAppended: 2, completed: false,
    },
  };
  const asr = { callbacks: null as null | Record<string, (...args: unknown[]) => void>, commits: 0, frames: 0 };
  return { events, snapshot, asr, record: (name: string) => events.push(name) };
});

vi.mock("../speech", () => ({
  getSpeechSnapshot: () => bi.snapshot,
  subscribeSpeech: () => () => undefined,
  duckSpeech: () => bi.record("duck"),
  unduckSpeech: () => bi.record("unduck"),
  confirmBargeIn: () => bi.record("confirmBargeIn"),
  cancelSpeech: () => bi.record("cancelSpeech"),
  pauseSpeech: () => { bi.record("pauseSpeech"); return { pausedAtMs: 640, ledger: null }; },
  resumeSpeech: async () => { bi.record("resumeSpeech"); return true; },
  recordBargeInCandidate: () => { bi.record("recordBargeInCandidate"); return { interruptedAtMs: 640, ledger: null }; },
}));

vi.mock("../asrGatewayClient", () => ({
  AsrGatewayClient: class {
    constructor(callbacks: Record<string, (...args: unknown[]) => void>) { bi.asr.callbacks = callbacks; }
    async connect() { return true; }
    sendAudio() { bi.asr.frames += 1; }
    commit() { bi.asr.commits += 1; }
    isConnected() { return true; }
    isSessionActive() { return true; }
    getSessionId() { return "session-1"; }
    close() {}
  },
}));

const recorder = () => (globalThis as { __recorder?: { port: { onmessage: (event: { data: unknown }) => void } } }).__recorder!;

/** One RMS>threshold packet, 128ms of 220Hz tone, as the real worklet delivers it. */
function voicePacket(): Float32Array {
  const frame = new Float32Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / 16000);
  return frame;
}
const silentPacket = () => new Float32Array(FRAME_SAMPLES);

describe("C1 barge-in: duck first, stop only on the semantic final", () => {
  beforeAll(async () => {
    class FakeAudioContext {
      sampleRate = 16000;
      state = "running";
      audioWorklet = { addModule: async () => undefined };
      async resume() {}
      createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
      createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; }
      get destination() { return {}; }
      async close() {}
    }
    class FakeAudioWorkletNode {
      port = { onmessage: null as ((event: { data: unknown }) => void) | null, close() {} };
      constructor() { (globalThis as { __recorder?: unknown }).__recorder = this; }
      connect() {}
      disconnect() {}
    }
    Object.assign(globalThis, { AudioContext: FakeAudioContext, AudioWorkletNode: FakeAudioWorkletNode });
    Object.defineProperty(globalThis, "window", {
      value: { isSecureContext: true, addEventListener() {}, location: { protocol: "http:", host: "127.0.0.1" } },
      configurable: true,
    });
    Object.defineProperty(globalThis, "document", { value: { addEventListener() {}, hidden: false }, configurable: true });
    Object.defineProperty(globalThis, "navigator", {
      value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
      configurable: true,
    });
    expect(await startFullDuplex({ vad: { threshold: 0.015, onsetMs: 160, hangoverMs: 500 } })).toBe(true);
    setFullDuplexCommandHandler(() => undefined);
    bi.events.length = 0;
  });

  afterAll(() => {
    stopFullDuplex();
    delete (globalThis as { __recorder?: unknown }).__recorder;
  });

  it("ducks at VAD onset without stopping playback", () => {
    const packets: Array<Float32Array> = [
      silentPacket(), silentPacket(), // silence before the user speaks
      voicePacket(), voicePacket(), voicePacket(), // 384ms of voice
    ];
    let speechStartFrame = -1;
    for (const [index, packet] of packets.entries()) {
      const before = bi.events.length;
      recorder().port.onmessage({ data: packet });
      if (speechStartFrame < 0 && bi.events.slice(before).includes("duck")) speechStartFrame = index;
    }
    // 160ms configured onset over 128ms packets: 2 voiced packets = 256ms.
    expect(speechStartFrame).toBe(3);
    expect((speechStartFrame + 1) * FRAME_MS - 2 * FRAME_MS).toBe(256);
    expect(bi.events.filter((name) => name === "duck")).toHaveLength(1);
    expect(bi.events).not.toContain("confirmBargeIn");
    expect(bi.asr.commits).toBe(0);
  });

  it("commits after the hangover and stops only when the transcript arrives", () => {
    for (let frame = 0; frame < 4; frame += 1) recorder().port.onmessage({ data: silentPacket() });
    expect(bi.asr.commits).toBe(1);
    expect(bi.events).not.toContain("confirmBargeIn");

    const before = bi.events.length;
    bi.asr.callbacks!.onFinal("停一下");
    expect(bi.events.slice(before)).toContain("confirmBargeIn");
  });

  it("ignores the assistant's own line leaking back instead of interrupting itself", () => {
    const spoken = "已经取消这个限购提醒，其他内容保持不变。";
    bi.snapshot.text = spoken;
    bi.events.length = 0;
    bi.asr.callbacks!.onFinal(spoken);
    expect(getFullDuplexSnapshot().lastIntent).toBe("self_echo");
    expect(bi.events).not.toContain("confirmBargeIn");
    expect(bi.events).not.toContain("pauseSpeech");
  });

  it("keeps a pure backchannel from interrupting playback", () => {
    bi.snapshot.text = PLAYING;
    bi.events.length = 0;
    bi.asr.callbacks!.onFinal("对");
    expect(getFullDuplexSnapshot().lastIntent).toBe("backchannel");
    expect(bi.events).not.toContain("confirmBargeIn");
  });
});

