import { getSpeechSnapshot, subscribeSpeech, duckSpeech, unduckSpeech, confirmBargeIn, cancelSpeech } from "./speech";
import {
  appendWorkingConstraint,
  buildInterruptedSpeechContext,
  classifyIntent,
  clearWorkingConstraints,
  consumeWorkingConstraints,
  getWorkingConstraints,
  handleUserTranscript,
  resumeFromPause,
  type InterruptedSpeechContext,
} from "./turnTaking";
import type { TaskProjection } from "./taskProjection";
import { AsrGatewayClient, type AsrGatewayClientOptions } from "./asrGatewayClient";

export type FullDuplexStatus =
  | "idle"
  | "starting"
  | "listening"
  | "speech"
  | "processing"
  | "error";

export type UiInterruptReason = "click" | "typing" | "focus" | "navigation";

export interface FullDuplexCommandOptions {
  cancelRunning?: boolean;
  turnId?: number;
  interruptedContext?: InterruptedSpeechContext | null;
  constraints?: string[];
}

export interface SpeechSegmentDetectorConfig {
  /** RMS threshold for voice energy. */
  threshold?: number;
  /** Minimum continuous voice duration (ms) before triggering speech_start (filters clicks/coughs). */
  onsetMs?: number;
  /** Silence duration (ms) required before ending a speech segment (prevents mid-word cuts). */
  hangoverMs?: number;
}

export interface SpeechSegmentStep {
  speaking: boolean;
  event: "none" | "speech_start" | "speech_end";
}

export interface FullDuplexStartOptions {
  asr?: AsrGatewayClientOptions;
  vad?: SpeechSegmentDetectorConfig;
}

export interface FullDuplexSnapshot {
  enabled: boolean;
  status: FullDuplexStatus;
  turnId: number;
  userSpeaking: boolean;
  aiSpeaking: boolean;
  lastTranscript: string | null;
  lastIntent: string | null;
  interruptedContext: InterruptedSpeechContext | null;
  pendingConstraints: string[];
  error: string | null;
}

export const DEFAULT_VAD_THRESHOLD = 0.015;
export const DEFAULT_VAD_ONSET_MS = 160;
export const DEFAULT_VAD_HANGOVER_MS = 500;

/**
 * Pure debounce + hangover detector for streaming PCM frames.
 * Prevents single-frame noise spikes from ducking TTS and brief inter-syllable
 * pauses from prematurely committing the ASR utterance.
 */
export function createSpeechSegmentDetector(config: SpeechSegmentDetectorConfig = {}) {
  const threshold = config.threshold ?? DEFAULT_VAD_THRESHOLD;
  const onsetMs = Math.max(0, config.onsetMs ?? DEFAULT_VAD_ONSET_MS);
  const hangoverMs = Math.max(0, config.hangoverMs ?? DEFAULT_VAD_HANGOVER_MS);

  let speaking = false;
  let voicedMs = 0;
  let silentMs = 0;

  return {
    step(rms: number, frameDurationMs: number): SpeechSegmentStep {
      const dt = Number.isFinite(frameDurationMs) && frameDurationMs > 0 ? frameDurationMs : 0;
      const above = Number.isFinite(rms) && rms > threshold;

      if (!speaking) {
        if (above) {
          voicedMs += dt;
          if (voicedMs >= onsetMs) {
            speaking = true;
            voicedMs = 0;
            silentMs = 0;
            return { speaking: true, event: "speech_start" };
          }
        } else {
          voicedMs = 0;
        }
        return { speaking: false, event: "none" };
      }

      if (above) {
        silentMs = 0;
        return { speaking: true, event: "none" };
      }

      silentMs += dt;
      if (silentMs >= hangoverMs) {
        speaking = false;
        voicedMs = 0;
        silentMs = 0;
        return { speaking: false, event: "speech_end" };
      }
      return { speaking: true, event: "none" };
    },
    reset(): void {
      speaking = false;
      voicedMs = 0;
      silentMs = 0;
    },
    isSpeaking(): boolean {
      return speaking;
    },
  };
}

let snapshot: FullDuplexSnapshot = {
  enabled: false,
  status: "idle",
  turnId: 0,
  userSpeaking: false,
  aiSpeaking: false,
  lastTranscript: null,
  lastIntent: null,
  interruptedContext: null,
  pendingConstraints: [],
  error: null,
};

const listeners = new Set<() => void>();
const update = (patch: Partial<FullDuplexSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((l) => l());
};

export const getFullDuplexSnapshot = (): FullDuplexSnapshot => snapshot;
export const subscribeFullDuplex = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

let enabled = false;
let generation = 0;
let turnCounter = 0;
let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let source: MediaStreamAudioSourceNode | null = null;
let recorder: AudioWorkletNode | null = null;
let sink: GainNode | null = null;
let speechUnsub: (() => void) | null = null;
let segmentDetector = createSpeechSegmentDetector();

let segmentWasSpeaking = false;
let segmentTaskId: string | null = null;
let currentTaskProjection: TaskProjection | null = null;

let onCommand: ((text: string, options?: FullDuplexCommandOptions) => void) | null = null;
export const setFullDuplexCommandHandler = (
  handler: ((text: string, options?: FullDuplexCommandOptions) => void) | null,
) => {
  onCommand = handler;
};

let onCancelTaskById: ((taskId: string) => void) | null = null;
export const setFullDuplexCancelTaskByIdHandler = (handler: ((taskId: string) => void) | null) => {
  onCancelTaskById = handler;
};

let getTaskId: (() => string | null) | null = null;
export const setFullDuplexTaskIdGetter = (handler: (() => string | null) | null) => {
  getTaskId = handler;
};

export const setFullDuplexTaskProjection = (projection: TaskProjection | null) => {
  currentTaskProjection = projection;
};

export const getFullDuplexTaskProjection = (): TaskProjection | null => currentTaskProjection;

let gatewayClient: AsrGatewayClient | null = null;

const isSpeechActive = () => {
  const s = getSpeechSnapshot().status;
  return s === "playing" || s === "loading";
};

const dispatchCommand = (
  text: string,
  options: { cancelRunning?: boolean; interruptedContext?: InterruptedSpeechContext | null } = {},
) => {
  const nextTurnId = ++turnCounter;
  const queued = consumeWorkingConstraints().map((item) => item.text);
  update({
    turnId: nextTurnId,
    pendingConstraints: [],
    ...(options.interruptedContext !== undefined ? { interruptedContext: options.interruptedContext } : {}),
  });
  if (onCommand) {
    onCommand(text, {
      cancelRunning: options.cancelRunning,
      turnId: nextTurnId,
      interruptedContext: options.interruptedContext ?? null,
      ...(queued.length > 0 ? { constraints: queued } : {}),
    });
  }
};

/**
 * UI-triggered barge-in (card click, composer typing, focus change, navigation).
 * Immediately stops active TTS and records the truncated playback context
 * without tearing down the microphone listener.
 */
export const interruptByUi = (reason: UiInterruptReason = "click"): InterruptedSpeechContext | null => {
  const current = getSpeechSnapshot();
  const interrupted = buildInterruptedSpeechContext(current, "ui");
  unduckSpeech();
  if (current.status === "playing" || current.status === "loading" || current.status === "paused") {
    cancelSpeech();
  }
  if (interrupted) {
    update({
      aiSpeaking: false,
      interruptedContext: interrupted,
      lastIntent: `ui:${reason}`,
    });
  }
  return interrupted;
};

const releaseCapture = () => {
  segmentDetector.reset();
  if (recorder) {
    recorder.port.onmessage = null;
    try { recorder.disconnect(); } catch { /* ignore */ }
    try { recorder.port.close(); } catch { /* ignore */ }
  }
  recorder = null;
  source?.disconnect();
  source = null;
  sink?.disconnect();
  sink = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const old = context;
  context = null;
  if (old && old.state !== "closed") void old.close().catch(() => undefined);
  if (gatewayClient) {
    gatewayClient.close();
    gatewayClient = null;
  }
};

const captureError = (error: unknown): string => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "麦克风权限未开启。";
  if (name === "NotFoundError") return "没有找到麦克风。";
  return "无法启动全双工监听。";
};

export const startFullDuplex = async (options: FullDuplexStartOptions = {}): Promise<boolean> => {
  if (enabled) return true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    update({ status: "error", error: "浏览器不支持安全录音。" });
    return false;
  }
  const token = ++generation;
  segmentDetector = createSpeechSegmentDetector(options.vad);
  update({ status: "starting", error: null });
  let acquired: MediaStream | null = null;
  let audio: AudioContext | null = null;
  try {
    audio = new AudioContext({ sampleRate: 16000 });
    await audio.resume();
    if (token !== generation) { await audio.close(); return false; }
    context = audio;
    acquired = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    if (token !== generation) {
      acquired.getTracks().forEach((t) => t.stop());
      if (audio.state !== "closed") await audio.close();
      return false;
    }
    stream = acquired;
    await audio.audioWorklet.addModule("/audio-capture-worklet.js");
    if (token !== generation) {
      acquired.getTracks().forEach((t) => t.stop());
      return false;
    }

    gatewayClient = new AsrGatewayClient(
      {
        onPartial: (text: string) => {
          if (token !== generation) return;
          update({ lastTranscript: text, status: "processing" });
        },
        onFinal: (text: string) => {
          if (token !== generation) return;
          const trimmed = text.trim();
          if (!trimmed) {
            unduckSpeech();
            update({ status: "listening" });
            return;
          }
          update({ lastTranscript: trimmed, status: "listening" });
          const aiSpeakingNow = isSpeechActive();

          if (aiSpeakingNow) {
            const speechBefore = getSpeechSnapshot();
            const intent = handleUserTranscript(trimmed);
            update({ lastIntent: intent });

            if (intent === "stop" || intent === "cancel_task") {
              const interrupted = buildInterruptedSpeechContext(speechBefore, "voice");
              unduckSpeech();
              if (interrupted) update({ interruptedContext: interrupted });
              if (intent === "cancel_task" && segmentTaskId && onCancelTaskById && currentTaskProjection?.isTerminal !== true) {
                onCancelTaskById(segmentTaskId);
              }
              return;
            }

            if (intent === "new_constraint") {
              const interrupted = buildInterruptedSpeechContext(speechBefore, "voice");
              unduckSpeech();
              if (currentTaskProjection?.isActive) {
                appendWorkingConstraint(trimmed, turnCounter + 1);
                update({
                  interruptedContext: interrupted ?? snapshot.interruptedContext,
                  pendingConstraints: getWorkingConstraints().map((item) => item.text),
                });
              } else {
                confirmBargeIn();
                dispatchCommand(trimmed, { cancelRunning: false, interruptedContext: interrupted });
              }
              return;
            }

            if (intent === "new_topic" || (intent === "unknown" && [...trimmed].length >= 2)) {
              const interrupted = buildInterruptedSpeechContext(speechBefore, "voice");
              confirmBargeIn();
              unduckSpeech();
              const canSupersede = Boolean(currentTaskProjection?.canSafelySupersede);
              if (canSupersede && segmentTaskId && onCancelTaskById) {
                onCancelTaskById(segmentTaskId);
              }
              dispatchCommand(trimmed, { cancelRunning: canSupersede, interruptedContext: interrupted });
              return;
            }

            // backchannel / continue / irrelevant: restore volume and let playback continue
            unduckSpeech();
            return;
          }

          const intent = classifyIntent(trimmed);
          update({ lastIntent: intent });
          if (intent === "backchannel" || intent === "irrelevant") {
            unduckSpeech();
            return;
          }
          if (intent === "continue") {
            resumeFromPause();
            unduckSpeech();
            return;
          }
          if (intent === "stop") {
            unduckSpeech();
            return;
          }
          if (intent === "cancel_task") {
            if (segmentTaskId && onCancelTaskById && currentTaskProjection?.isTerminal !== true) {
              onCancelTaskById(segmentTaskId);
            }
            unduckSpeech();
            return;
          }
          if (intent === "new_constraint" && currentTaskProjection?.isActive) {
            appendWorkingConstraint(trimmed, turnCounter + 1);
            update({ pendingConstraints: getWorkingConstraints().map((item) => item.text) });
            unduckSpeech();
            return;
          }

          const canSupersede = Boolean(currentTaskProjection?.canSafelySupersede);
          if (canSupersede && segmentTaskId && onCancelTaskById) {
            onCancelTaskById(segmentTaskId);
          }
          unduckSpeech();
          dispatchCommand(trimmed, { cancelRunning: canSupersede });
        },
        onError: (_code: string, message: string) => {
          if (token !== generation) return;
          unduckSpeech();
          update({ error: message, status: "listening" });
        },
        onEnded: (_reason: string) => {
          if (token !== generation) return;
          update({ status: "listening" });
        },
      },
      options.asr,
    );

    const connected = await gatewayClient.connect();
    if (token !== generation) {
      gatewayClient.close();
      gatewayClient = null;
      return false;
    }
    if (!connected) {
      gatewayClient.close();
      gatewayClient = null;
      releaseCapture();
      update({ status: "error", error: "ASR Gateway 连接失败", enabled: false });
      enabled = false;
      return false;
    }

    recorder = new AudioWorkletNode(audio, "vivic-pcm-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const sampleRate = audio.sampleRate || 16000;
    recorder.port.onmessage = (event) => {
      if (token !== generation) return;
      if (event.data?.stopped) return;
      if (!(event.data instanceof Float32Array)) return;
      const data = event.data as Float32Array;
      const frameDurationMs = (data.length / sampleRate) * 1000;

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / Math.max(1, data.length));
      const step = segmentDetector.step(rms, frameDurationMs);

      if (step.event === "speech_start") {
        segmentWasSpeaking = isSpeechActive();
        segmentTaskId = getTaskId ? getTaskId() : null;
        if (segmentWasSpeaking) duckSpeech();
        update({ userSpeaking: true, status: "speech" });
      } else if (step.event === "speech_end") {
        if (gatewayClient && gatewayClient.isConnected()) gatewayClient.commit();
        update({ userSpeaking: false, status: "listening" });
      }

      if (gatewayClient && gatewayClient.isConnected() && (step.speaking || step.event === "speech_end")) {
        gatewayClient.sendAudio(data);
      }
    };

    source = audio.createMediaStreamSource(acquired);
    sink = audio.createGain();
    sink.gain.value = 0;
    source.connect(recorder);
    recorder.connect(sink);
    sink.connect(audio.destination);

    enabled = true;
    update({ enabled: true, status: "listening", error: null });
    speechUnsub = subscribeSpeech(() => {
      update({ aiSpeaking: isSpeechActive() });
    });
    return true;
  } catch (error) {
    acquired?.getTracks().forEach((t) => t.stop());
    if (audio && audio !== context && audio.state !== "closed") void audio.close().catch(() => undefined);
    if (token !== generation) return false;
    releaseCapture();
    update({ status: "error", error: captureError(error), enabled: false });
    enabled = false;
    return false;
  }
};

export const stopFullDuplex = (): void => {
  generation++;
  enabled = false;
  if (speechUnsub) {
    try { speechUnsub(); } catch { /* ignore */ }
    speechUnsub = null;
  }
  unduckSpeech();
  clearWorkingConstraints();
  if (gatewayClient) {
    gatewayClient.close();
    gatewayClient = null;
  }
  releaseCapture();
  update({
    enabled: false,
    status: "idle",
    userSpeaking: false,
    aiSpeaking: false,
    pendingConstraints: [],
  });
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", stopFullDuplex);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && enabled) {
      unduckSpeech();
      segmentDetector.reset();
    }
  });
}
