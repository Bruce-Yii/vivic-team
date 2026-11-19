import { afterEach, describe, expect, it, vi } from "vitest";
import { AsrGatewayClient } from "../asrGatewayClient";
import { createSpeechSegmentDetector, interruptByUi } from "../fullDuplex";
import { projectTask } from "../taskProjection";
import {
  appendWorkingConstraint,
  buildInterruptedSpeechContext,
  classifyTaskCancellationSafety,
  clearWorkingConstraints,
  consumeWorkingConstraints,
  getWorkingConstraints,
} from "../turnTaking";

afterEach(() => {
  clearWorkingConstraints();
  vi.restoreAllMocks();
});

describe("createSpeechSegmentDetector (VAD onset debounce + silence hangover)", () => {
  it("ignores transient noise spikes shorter than onsetMs and fires speech_start after sustained voice", () => {
    const detector = createSpeechSegmentDetector({ threshold: 0.02, onsetMs: 160, hangoverMs: 500 });
    // Single 40ms click spike followed by silence must not trigger speech_start
    expect(detector.step(0.08, 40)).toEqual({ speaking: false, event: "none" });
    expect(detector.step(0.005, 40)).toEqual({ speaking: false, event: "none" });

    // Sustained 4 x 40ms = 160ms voice triggers speech_start on the 4th frame
    expect(detector.step(0.05, 40)).toEqual({ speaking: false, event: "none" });
    expect(detector.step(0.05, 40)).toEqual({ speaking: false, event: "none" });
    expect(detector.step(0.05, 40)).toEqual({ speaking: false, event: "none" });
    expect(detector.step(0.05, 40)).toEqual({ speaking: true, event: "speech_start" });
  });

  it("bridges brief inter-syllable pauses and commits only after hangoverMs of continuous silence", () => {
    const detector = createSpeechSegmentDetector({ threshold: 0.02, onsetMs: 100, hangoverMs: 400 });
    expect(detector.step(0.05, 100)).toEqual({ speaking: true, event: "speech_start" });
    // 200ms pause followed by resumed speech must stay speaking
    expect(detector.step(0.001, 200)).toEqual({ speaking: true, event: "none" });
    expect(detector.step(0.05, 50)).toEqual({ speaking: true, event: "none" });
    // 200ms + 200ms continuous silence hits hangoverMs -> speech_end
    expect(detector.step(0.001, 200)).toEqual({ speaking: true, event: "none" });
    expect(detector.step(0.001, 200)).toEqual({ speaking: false, event: "speech_end" });
  });
});

describe("buildInterruptedSpeechContext (playback truncation accounting)", () => {
  it("truncates to exact wordRange boundary when available", () => {
    const ctx = buildInterruptedSpeechContext({
      status: "playing",
      requestId: "req-1",
      text: "明天下午有三班直飞上海，最低六百八十元。",
      wordRange: { start: 4, end: 8 },
      playbackLedger: {
        mode: "mse",
        firstByteMs: 120,
        firstAudibleFrameMs: 180,
        timeToFirstPlayingMs: 180,
        playedMs: 900,
        audioBytesReceived: 4096,
        segmentsReceived: 2,
        segmentsAppended: 2,
        completed: false,
      },
    }, "voice");
    expect(ctx).toEqual({
      interrupted: true,
      reason: "voice",
      requestId: "req-1",
      fullText: "明天下午有三班直飞上海，最低六百八十元。",
      spokenText: "明天下午有三班直",
      truncated: true,
      playedMs: 900,
    });
  });

  it("marks loading interruption as empty spokenText and returns null when idle", () => {
    expect(buildInterruptedSpeechContext({
      status: "loading",
      requestId: "req-2",
      text: "正在查询天气",
      wordRange: null,
      playbackLedger: null,
    }, "ui")).toMatchObject({ interrupted: true, reason: "ui", spokenText: "", truncated: true });

    expect(buildInterruptedSpeechContext({
      status: "idle",
      requestId: null,
      text: "已完成",
      wordRange: null,
      playbackLedger: null,
    })).toBeNull();
  });
});

describe("write-operation safe cancellation boundary", () => {
  it("allows superseding active read-only tasks but protects mutating and unknown tasks", () => {
    const readOnly = projectTask({ id: "t1", status: "running", message: "查航班", mutationClass: "read_only" });
    const mutating = projectTask({ id: "t2", status: "running", message: "删除卡片", mutationClass: "mutating" });
    const defaultTask = projectTask({ id: "t3", status: "running", message: "处理中" });

    expect(readOnly.canSafelySupersede).toBe(true);
    expect(mutating.canSafelySupersede).toBe(false);
    expect(defaultTask.canSafelySupersede).toBe(false);

    expect(classifyTaskCancellationSafety("read_only", true)).toBe("abort_immediately");
    expect(classifyTaskCancellationSafety("mutating", false)).toBe("abort_immediately");
    expect(classifyTaskCancellationSafety("mutating", true)).toBe("report_result_no_silent_drop");
    expect(classifyTaskCancellationSafety("unknown", true)).toBe("report_result_no_silent_drop");
    expect(classifyTaskCancellationSafety("unknown", false)).toBe("require_confirmation");
  });
});

describe("Working Context constraints queue", () => {
  it("appends, bounds, and consumes queued constraints cleanly", () => {
    appendWorkingConstraint("  要下午的航班  ", 1, 100);
    appendWorkingConstraint("不要红眼航班", 2, 200);
    expect(getWorkingConstraints().map((c) => c.text)).toEqual(["要下午的航班", "不要红眼航班"]);

    const consumed = consumeWorkingConstraints();
    expect(consumed).toHaveLength(2);
    expect(getWorkingConstraints()).toHaveLength(0);
  });
});

describe("AsrGatewayClient multi-turn session rotation and error forwarding", () => {
  it("rotates to a new sessionId after commit and forwards server error frames", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const fakeWs = {
      readyState: WebSocket.OPEN as number,
      onopen: null as (() => void) | null,
      onmessage: null as ((event: { data: string }) => void) | null,
      onerror: null as (() => void) | null,
      onclose: null as (() => void) | null,
      send(raw: string) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        sent.push(parsed);
        if (parsed.type === "session.start") {
          this.onmessage?.({ data: JSON.stringify({ type: "session.started", sessionId: parsed.sessionId }) });
        }
      },
      close() {
        this.readyState = WebSocket.CLOSED;
        this.onclose?.();
      },
    };

    const onError = vi.fn();
    const client = new AsrGatewayClient(
      { onPartial: vi.fn(), onFinal: vi.fn(), onError, onEnded: vi.fn() },
      { provider: "stepfun", autoReconnect: false, createWebSocket: () => fakeWs as unknown as WebSocket },
    );

    const connecting = client.connect();
    fakeWs.onopen?.();
    expect(await connecting).toBe(true);

    const firstSession = client.getSessionId();
    expect(firstSession).toBeTruthy();
    expect(sent[0]).toMatchObject({ type: "session.start", provider: "stepfun" });

    client.sendAudio(new Float32Array([0.1, -0.1]));
    client.commit();
    expect(client.isSessionActive()).toBe(false);

    // Second turn automatically starts a fresh sessionId with seq reset to 0
    client.sendAudio(new Float32Array([0.2, -0.2]));
    const secondSession = client.getSessionId();
    expect(secondSession).toBeTruthy();
    expect(secondSession).not.toBe(firstSession);
    const secondChunk = sent.filter((m) => m.type === "audio.chunk")[1];
    expect(secondChunk).toMatchObject({ sessionId: secondSession, seq: 0 });

    // Server error frame is forwarded to onError
    fakeWs.onmessage?.({ data: JSON.stringify({ type: "error", code: "asr-backpressure", message: "音频积压" }) });
    expect(onError).toHaveBeenCalledWith("asr-backpressure", "音频积压");

    client.close();
  });
});

describe("interruptByUi", () => {
  it("returns null safely when speech is idle", () => {
    expect(interruptByUi("click")).toBeNull();
  });
});
