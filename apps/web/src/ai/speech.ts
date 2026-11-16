import { routeAudioOutput } from "./audioOutput";
import { getVoiceConfiguration } from "./voiceConfig";
import { createBrowserTtsAdapter } from "./localSpeech/browserTts";
import { synthesizeLocalSpeech } from "./localSpeech/localTts";
import { decodeSpeechEnvelope, readTimedSpeech, speechFrame, type SpeechEnvelope, type SpeechRange } from "./speechTelemetry";
import type { SpeechWord } from "@vivic/contracts";
import { feedbackPhrase } from "./shortFeedback";

/** Curated official subset, verified 2026-10-15. Kept in sync with API by offline tests. */
export const SPEECH_VOICES_SOURCE = "https://platform.stepfun.com/docs/zh/guides/developer/tts#官方音色清单";
export const SPEECH_VOICES = [
  { id: "cixingnansheng", name: "磁性男声" },
  { id: "wenrounansheng", name: "温柔男声" },
  { id: "ruyananshi", name: "儒雅男士" },
  { id: "jingdiannvsheng", name: "经典女声" },
  { id: "wenrounvsheng", name: "温柔女声" },
  { id: "yuanqishaonv", name: "元气少女" },
  { id: "linjiajiejie", name: "邻家姐姐" },
  { id: "zhixingjiejie", name: "知性姐姐" },
] as const;
export type SpeechVoiceId = (typeof SPEECH_VOICES)[number]["id"];

export interface SpeechPreferences {
  voice: SpeechVoiceId;
  speed: number;
  /** Browser playback volume: 0 (muted) through 1. Never sent upstream. */
  volume: number;
  /** Explicit opt-in until the user's Plan timestamp capability is verified. */
  timestamps?: boolean;
  outputDeviceId?: string;
}

export const SPEECH_PREFERENCES_STORAGE_KEY = "vivic.speech.preferences.v1";
const DEFAULT_PREFERENCES: SpeechPreferences = { voice: "wenrounvsheng", speed: 1.3, volume: 1 };
const isVoice = (value: unknown): value is SpeechVoiceId => SPEECH_VOICES.some((voice) => voice.id === value);
const inRange = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

const readPreferences = (): { preferences: SpeechPreferences; preferenceError: string | null } => {
  const preferences = { ...DEFAULT_PREFERENCES };
  try {
    if (typeof localStorage !== "undefined") {
      const raw: unknown = JSON.parse(localStorage.getItem(SPEECH_PREFERENCES_STORAGE_KEY) ?? "null");
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        if ("voice" in raw && isVoice(raw.voice)) preferences.voice = raw.voice;
        if ("speed" in raw && inRange(raw.speed, 0.5, 2)) preferences.speed = raw.speed;
        if ("volume" in raw && inRange(raw.volume, 0, 1)) preferences.volume = raw.volume;
        if ("outputDeviceId" in raw && typeof raw.outputDeviceId === "string" && raw.outputDeviceId.length <= 512) preferences.outputDeviceId = raw.outputDeviceId;
        if ("timestamps" in raw && typeof raw.timestamps === "boolean") preferences.timestamps = raw.timestamps;
      }
    }
    return { preferences, preferenceError: null };
  } catch {
    return { preferences, preferenceError: "无法读取语音偏好，已使用默认设置。" };
  }
};

/** Same-tab TTS status; only public preferences are persisted. */
export interface SpeechPlaybackLedger {
  mode: "mse" | "buffered" | "browser" | "local" | "prerecorded";
  firstByteMs: number | null;
  /** Wall-clock ms until the first actually audible frame (audio.onplaying / currentTime advancement), not the first appended chunk. */
  firstAudibleFrameMs: number | null;
  /** Wall-clock ms from request start to first playing event (audio.onplaying), for latency measurement. */
  timeToFirstPlayingMs: number | null;
  /** Accumulated actual playback duration in ms (audio.currentTime advancement), distinct from wall-clock latency. */
  playedMs: number | null;
  audioBytesReceived: number;
  /** Per-delta segment receipt counters for partial playback progress. */
  segmentsReceived: number;
  segmentsAppended: number;
  completed: boolean;
}

export interface SpeechSnapshot {
  enabled: boolean;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  loading: boolean;
  playing: boolean;
  requestId: string | null;
  text: string | null;
  kind: "feedback" | "preview" | "phrase" | null;
  source: "stepfun" | "browser" | "local" | "prerecorded" | null;
  amplitude: number;
  wordRange: SpeechRange | null;
  error: string | null;
  preferences: SpeechPreferences;
  preferenceError: string | null;
  playbackLedger: SpeechPlaybackLedger | null;
}

export type SpeechResult =
  | { status: "completed" | "skipped" | "cancelled" }
  | { status: "error"; error: string };

let snapshot: SpeechSnapshot = {
  enabled: false, status: "idle", loading: false, playing: false,
  requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null, error: null,
  playbackLedger: null, ...readPreferences(),
};
const listeners = new Set<() => void>();
// Bounded event IDs, not text: distinct commands may legitimately say the same thing.
const seen = new Set<string>();

export const getSpeechSnapshot = (): SpeechSnapshot => snapshot;
export const subscribeSpeech = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const update = (patch: Partial<SpeechSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  snapshot.loading = snapshot.status === "loading";
  snapshot.playing = snapshot.status === "playing";
  listeners.forEach((listener) => listener());
};

interface Playback {
  controller: AbortController;
  audio?: HTMLAudioElement;
  url?: string;
  done: boolean;
  stopTelemetry?: () => void;
  finish: (result: SpeechResult) => void;
  mediaSource?: MediaSource;
  sourceBuffer?: SourceBuffer;
  mseQueue?: ArrayBuffer[];
  mseQueuedBytes?: number;
  mseAppending?: boolean;
  mseEnded?: boolean;
  mseStartedAt?: number;
  playbackLedger?: SpeechPlaybackLedger | null;
  accumulated?: Uint8Array[];
  accumulatedBytes?: number;
}
let active: Playback | undefined;
const browserTts = createBrowserTtsAdapter();

export const canUseMsePlayback = (): boolean => {
  try {
    return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
      && MediaSource.isTypeSupported("audio/mpeg");
  } catch {
    return false;
  }
};
export const supportsMsePlayback = canUseMsePlayback;
export const isMseSupported = canUseMsePlayback;
export const canStreamSpeech = canUseMsePlayback;

export const MSE_MAX_QUEUED_CHUNKS = 32;
export const MSE_MAX_QUEUED_BYTES = 2 * 1024 * 1024;
const MAX_ACCUMULATED_BYTES = 1 * 1024 * 1024;

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export async function consumeSpeechSse(
  response: Response,
  signal: AbortSignal,
  onDelta: (chunk: Uint8Array) => void | Promise<void>,
  onDone: (payload: any) => void,
  onError: (payload: any) => void,
): Promise<void> {
  if (!response.body) throw new Error("语音服务未返回音频流。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let data: string[] = [];
  let terminal = false;
  const dispatch = async () => {
    if (data.length === 0) return;
    const payload = data.join("\n");
    data = [];
    if (payload === "") return;
    if (terminal) throw new Error("语音流在结束事件后仍有数据。");
    if (payload === "[DONE]") { terminal = true; onDone({ done: true }); return; }
    let value: any;
    try { value = JSON.parse(payload); } catch { throw new Error("语音流格式无效。"); }
    if (!value || typeof value !== "object") throw new Error("语音流格式无效。");
    if (value.delta) {
      if (terminal) throw new Error("语音流在结束事件后仍有数据。");
      await onDelta(base64ToBytes(String(value.delta)));
    } else if (value.done) {
      terminal = true; onDone(value);
    } else if (value.error) {
      terminal = true; onError(value.error);
    } else throw new Error("语音流格式无效。");
  };
  const processLines = async (final: boolean) => {
    const rows = buffer.split(/\r?\n/);
    buffer = final ? "" : (rows.pop() ?? "");
    for (const line of rows) {
      if (line.length === 0) await dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.startsWith(":")) { /* comment */ }
      else if (/^(event|id|retry):/.test(line)) { /* ignore */ }
      else throw new Error("语音流格式无效。");
    }
    if (final) await dispatch();
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      buffer += decoder.decode(part.value, { stream: true });
      await processLines(false);
      if (buffer.length > 8 * 1024 * 1024) throw new Error("语音流过大。");
    }
    buffer += decoder.decode();
    await processLines(true);
    if (!terminal) throw new Error("语音流提前结束。");
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Pauses AI speech playback without discarding state. Returns the playback position
 * for later resume. Used by P3 turn-taking, not a direct user-facing action. */
export const pauseSpeech = (): { pausedAtMs: number; ledger: SpeechPlaybackLedger | null } | null => {
  if (!active || !active.audio) return null;
  try { active.audio.pause(); } catch { return null; }
  const pausedAtMs = Math.round((active.audio.currentTime || 0) * 1000);
  if (active.playbackLedger) {
    active.playbackLedger.completed = false;
    active.playbackLedger.playedMs = pausedAtMs;
  }
  update({ status: "paused", amplitude: 0, wordRange: null, playbackLedger: active.playbackLedger ? { ...active.playbackLedger } : null });
  return { pausedAtMs, ledger: active.playbackLedger ? { ...active.playbackLedger } : null };
};

/** Resumes AI speech playback from a paused position using Playback Ledger.
 * Natural resume: only continue from where playback actually reached, not from
 * where it was interrupted. */
export const resumeSpeech = (resumeFromMs?: number): Promise<boolean> => {
  if (!active || !active.audio) return Promise.resolve(false);
  try {
    if (resumeFromMs !== undefined && active.audio) {
      const maxMs = active.playbackLedger?.playedMs ?? 0;
      const targetMs = Math.min(resumeFromMs, maxMs);
      active.audio.currentTime = targetMs / 1000;
    }
    const playPromise = active.audio.play();
    if (playPromise && typeof playPromise.then === "function") {
      playPromise.then(() => {
        if (active) update({ status: "playing", error: null, playbackLedger: active.playbackLedger ? { ...active.playbackLedger } : null });
      }).catch(() => {
        if (active) update({ status: "error", error: "浏览器无法恢复播放。", playbackLedger: active.playbackLedger ? { ...active.playbackLedger } : null });
      });
    } else {
      update({ status: "playing", error: null, playbackLedger: active.playbackLedger ? { ...active.playbackLedger } : null });
    }
  } catch { return Promise.resolve(false); }
  return Promise.resolve(true);
};

/** Barge-in candidate: user may have interrupted. This does NOT immediately abort.
 * It records the interruption point in the Playback Ledger and returns the
 * current state for the turn-taking coordinator to decide. */
export const recordBargeInCandidate = (): { interruptedAtMs: number; ledger: SpeechPlaybackLedger | null } | null => {
  if (!active || !active.audio) return null;
  const interruptedAtMs = Math.round((active.audio.currentTime || 0) * 1000);
  if (active.playbackLedger) {
    active.playbackLedger.completed = false;
  }
  return { interruptedAtMs, ledger: active.playbackLedger ? { ...active.playbackLedger } : null };
};

/** Confirmed barge-in: abort playback and capture intent. Only call after
 * semantic classification (not on raw VAD signal). */
export const confirmBargeIn = (): void => {
  if (active) {
    active.controller.abort();
    active.finish({ status: "cancelled" });
  }
};

/** Temporarily lower playback volume (duck) during user speech. Restores on unduck. */
export const duckSpeech = (): void => {
  if (active?.audio && (active as any).__duckedVolume === undefined) {
    const prev = active.audio.volume;
    active.audio.volume = Math.max(0.05, prev * 0.2);
    (active as any).__duckedVolume = prev;
  }
};

/** Restore playback volume after ducking. */
export const unduckSpeech = (): void => {
  if (active?.audio && (active as any).__duckedVolume !== undefined) {
    active.audio.volume = (active as any).__duckedVolume;
    delete (active as any).__duckedVolume;
  }
};

/** Stops both the pending HTTP request and any audio, settling its promise. */
export const cancelSpeech = (): void => {
  browserTts.cancel();
  if (active) {
    active.controller.abort();
    active.finish({ status: "cancelled" });
  } else if (snapshot.status !== "idle" || snapshot.error || snapshot.requestId !== null) {
    update({ status: "idle", error: null, requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null, playbackLedger: null });
  }
};

export const setSpeechEnabled = (enabled: boolean): void => {
  if (!enabled) cancelSpeech();
  if (snapshot.enabled !== enabled) update({ enabled });
};

/** Clear only Vivic's public voice preferences; never touch account storage. */
export const resetSpeechPreferences = (): void => {
  cancelSpeech();
  localStorage.removeItem(SPEECH_PREFERENCES_STORAGE_KEY);
  seen.clear();
  update({ enabled: false, preferences: { ...DEFAULT_PREFERENCES }, preferenceError: null });
};

/** Invalid values are rejected; storage denial leaves the settings usable in memory. */
export const setSpeechPreferences = (patch: Partial<SpeechPreferences>): boolean => {
  if ((patch.voice !== undefined && !isVoice(patch.voice)) ||
      (patch.speed !== undefined && !inRange(patch.speed, 0.5, 2)) ||
      (patch.volume !== undefined && !inRange(patch.volume, 0, 1)) ||
      (patch.timestamps !== undefined && typeof patch.timestamps !== "boolean") ||
      (patch.outputDeviceId !== undefined && (typeof patch.outputDeviceId !== "string" || patch.outputDeviceId.length > 512))) return false;
  const preferences: SpeechPreferences = {
    ...(patch.outputDeviceId !== undefined || snapshot.preferences.outputDeviceId !== undefined ? { outputDeviceId: patch.outputDeviceId ?? snapshot.preferences.outputDeviceId } : {}),
    voice: patch.voice ?? snapshot.preferences.voice,
    speed: patch.speed ?? snapshot.preferences.speed,
    volume: patch.volume ?? snapshot.preferences.volume,
    ...(patch.timestamps !== undefined || snapshot.preferences.timestamps !== undefined
      ? { timestamps: patch.timestamps ?? snapshot.preferences.timestamps } : {}),
  };
  // Changing synthesis settings cancels obsolete audio. Volume is live, with no new request.
  if (preferences.voice !== snapshot.preferences.voice || preferences.speed !== snapshot.preferences.speed
    || preferences.timestamps !== snapshot.preferences.timestamps || preferences.outputDeviceId !== snapshot.preferences.outputDeviceId) cancelSpeech();
  if (active?.audio) active.audio.volume = preferences.volume;
  let preferenceError: string | null = null;
  try {
    if (typeof localStorage === "undefined") throw new Error("storage unavailable");
    localStorage.setItem(SPEECH_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    preferenceError = "语音偏好暂未保存，刷新后可能恢复默认。";
  }
  update({ preferences, preferenceError });
  return true;
};

/**
 * Opt-in, latest-request-wins playback. Resolves on end, cancellation or error;
 * never throws for service/autoplay failures. Reusing an event ID skips playback.
 */
export const speakText = (
  text: string,
  options: { requestId: string; signal?: AbortSignal },
): Promise<SpeechResult> => playText(text, options, "feedback");

export const speakShortFeedback = (text: "我看看" | "稍等" | "好的", options: { requestId: string; signal?: AbortSignal }) =>
  playText(text, options, "phrase");

/** Finishing a plan must cancel only that plan's short cue, never another utterance. */
export const cancelShortFeedback = (requestId: string) => {
  if (snapshot.kind === "phrase" && snapshot.requestId?.startsWith(`${requestId}:`)) cancelSpeech();
};

/** Explicit audition works while automatic feedback is off, without enabling it. */
export const previewSpeech = (
  options: { requestId?: string; signal?: AbortSignal } = {},
): Promise<SpeechResult> => playText("你好，我是 Vivic。这是当前音色的试听，你可以调整语速和音量。", {
  ...options, requestId: options.requestId ?? `preview-${crypto.randomUUID()}`,
}, "preview");

const playText = (
  text: string,
  options: { requestId: string; signal?: AbortSignal },
  kind: "feedback" | "preview" | "phrase",
): Promise<SpeechResult> => {
  if (getVoiceConfiguration().tts === "none") return Promise.resolve({ status: "skipped" });
  if (kind !== "preview" && !snapshot.enabled) return Promise.resolve({ status: "skipped" });
  if (options.signal?.aborted) return Promise.resolve({ status: "cancelled" });
  if (seen.has(options.requestId)) return Promise.resolve({ status: "skipped" });
  cancelSpeech();
  // The HTTP schema caps UTF-16 length. Never cut between a surrogate pair.
  const spokenText = typeof text === "string"
    ? text.trim().slice(0, 200).replace(/[\uD800-\uDBFF]$/u, "").trimEnd()
    : "";
  if (!options.requestId?.trim() || options.requestId.length > 256 ||
      !spokenText ||
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(text)) {
    const error = "语音只接受 1–200 字符的可见短句及有效请求 ID。";
    update({ status: "error", error, requestId: null, text: null, kind });
    return Promise.resolve({ status: "error", error });
  }
  seen.add(options.requestId);
  if (seen.size > 128) seen.delete(seen.values().next().value!);

  return new Promise<SpeechResult>((resolve) => {
    const controller = new AbortController();
    const onAbort = () => {
      controller.abort();
      job.finish({ status: "cancelled" });
    };
    const job: Playback = {
      controller,
      done: false,
      finish: (result) => {
        if (job.done) return;
        job.done = true;
        job.stopTelemetry?.();
        options.signal?.removeEventListener("abort", onAbort);
        if (job.sourceBuffer) { try { job.sourceBuffer.abort(); } catch { /* ignore */ } }
        if (job.mediaSource && job.mediaSource.readyState === "open") { try { job.mediaSource.endOfStream(); } catch { /* ignore */ } }
        if (job.audio) {
          job.audio.onended = null;
          job.audio.onerror = null;
          job.audio.ontimeupdate = null; job.audio.onpause = null; job.audio.onwaiting = null; job.audio.onplaying = null;
          job.audio.pause();
          job.audio.removeAttribute("src");
          job.audio.load();
        }
        if (job.url) URL.revokeObjectURL(job.url);
        job.mseQueue = [];
        job.accumulated = [];
        if (job.playbackLedger) {
          job.playbackLedger.completed = result.status === "completed";
        }
        if (active === job) {
          active = undefined;
          update(result.status === "error"
            ? { status: "error", error: result.error, amplitude: 0, wordRange: null, playbackLedger: job.playbackLedger ?? null }
            : result.status === "cancelled"
              ? { status: "idle", error: null, requestId: null, text: null, kind: null, source: null, amplitude: 0, wordRange: null, playbackLedger: null }
              : { status: "idle", error: null, amplitude: 0, wordRange: null, playbackLedger: job.playbackLedger ?? null });
        }
        resolve(result);
      },
    };
    active = job;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const { voice, speed } = snapshot.preferences;
    update({ status: "loading", error: null, requestId: options.requestId, text: spokenText, kind, amplitude: 0, wordRange: null, source: null });
    if (job.done) return;
    const run = async () => {
      try {
        const voiceConfig = getVoiceConfiguration();
        const phrase = kind !== "preview" && voiceConfig.tts !== "local" ? feedbackPhrase(spokenText, voice) : null;
        if (kind === "phrase" && !phrase && voiceConfig.tts !== "local") { job.finish({ status: "skipped" }); return; }
        if (!phrase && voiceConfig.tts === "browser") {
          update({ source: "browser", playbackLedger: { mode: "browser", firstByteMs: null, firstAudibleFrameMs: null, timeToFirstPlayingMs: null, playedMs: null, audioBytesReceived: 0, segmentsReceived: 0, segmentsAppended: 0, completed: false } });
          browserTts.setEnabled(true);
          await browserTts.speak(spokenText, {
            ...(voiceConfig.browserVoice ? { voiceId: voiceConfig.browserVoice } : {}),
            localOnly: true, signal: controller.signal,
            rate: speed, volume: snapshot.preferences.volume,
            onStart: () => { if (!job.done) update({ status: "playing", error: null }); },
            onBoundary: (start, length) => {
              if (job.done || !snapshot.playing) return;
              const valid = length > 0 && start + length <= spokenText.length
                && !/[\uDC00-\uDFFF]/u.test(spokenText[start] ?? "")
                && !/[\uD800-\uDBFF]/u.test(spokenText[start + length - 1] ?? "");
              update({ wordRange: valid ? { start, end: start + length } : null });
            },
          });
          if (job.playbackLedger) job.playbackLedger.completed = true;
          job.finish({ status: "completed" }); return;
        }
        const local = getVoiceConfiguration().tts === "local";
        const source = phrase ? "prerecorded" : local ? "local" : "stepfun";
        update({ source, playbackLedger: { mode: source === "stepfun" ? "buffered" : source as any, firstByteMs: null, firstAudibleFrameMs: null, timeToFirstPlayingMs: null, playedMs: null, audioBytesReceived: 0, segmentsReceived: 0, segmentsAppended: 0, completed: false } });

        // Streaming MSE path (Chromium and any runtime with audio/mpeg MSE support).
        const canStream = !local && !phrase && canUseMsePlayback();
        if (canStream) {
          const startedAt = performance.now();
          const ledger: SpeechPlaybackLedger = { mode: "mse", firstByteMs: null, firstAudibleFrameMs: null, timeToFirstPlayingMs: null, playedMs: null, audioBytesReceived: 0, segmentsReceived: 0, segmentsAppended: 0, completed: false };
          job.playbackLedger = ledger;
          update({ playbackLedger: ledger });
          // mseStarted removed: MSE init failure no longer falls through to buffered path
          try {
            const connectionController = new AbortController();
            const connectionTimer = setTimeout(() => connectionController.abort(), 5_000);
            let response: Response;
            try {
              response = await fetch("/api/speech", {
                method: "POST",
                headers: { "content-type": "application/json", accept: "text/event-stream" },
                body: JSON.stringify({ text: spokenText, voice, speed,
                  ...(snapshot.preferences.timestamps ? { timestamps: true } : {}) }),
                signal: AbortSignal.any([controller.signal, connectionController.signal]),
                cache: "no-store",
              });
            } finally {
              clearTimeout(connectionTimer);
            }
            if (job.done) return;
            if (!response.ok) {
              const body: unknown = await response.json().catch(() => null);
              const error = body && typeof body === "object" && "error" in body &&
                typeof body.error === "string" ? body.error.slice(0, 300) : `语音不可用（HTTP ${response.status}）`;
              job.finish({ status: "error", error }); return;
            }
            const contentType = response.headers.get("content-type") ?? "";
            if (!/text\/event-stream/i.test(contentType)) {
              throw new Error("not-sse");
            }
            // MediaSource setup.
            const ms = new MediaSource();
            const audio = new Audio();
            job.audio = audio;
            job.mediaSource = ms;
            job.mseQueue = [];
            job.mseQueuedBytes = 0;
            job.accumulated = [];
            job.accumulatedBytes = 0;
            job.mseEnded = false;
            job.mseStartedAt = startedAt;
            const objectUrl = URL.createObjectURL(ms);
            job.url = objectUrl;
            audio.src = objectUrl;
            audio.volume = snapshot.preferences.volume;
            let words: SpeechWord[] = [];
            let envelope: SpeechEnvelope | null = null;
            const tick = () => {
              if (job.done || active !== job || !job.audio || !snapshot.playing) return;
              if (job.playbackLedger && job.playbackLedger.firstAudibleFrameMs === null
                  && Number.isFinite(job.audio.currentTime) && job.audio.currentTime > 0) {
                const now = Math.max(0, Math.round(performance.now() - startedAt));
                job.playbackLedger.firstAudibleFrameMs = now;
                if (job.playbackLedger.timeToFirstPlayingMs === null) job.playbackLedger.timeToFirstPlayingMs = now;
                update({ playbackLedger: { ...job.playbackLedger } });
              }
              // Track actual playback duration (currentTime advancement), not wall-clock
              if (job.playbackLedger && Number.isFinite(job.audio.currentTime) && job.audio.currentTime > 0) {
                job.playbackLedger.playedMs = Math.round(job.audio.currentTime * 1000);
              }
              if (job.audio.paused === true) { update({ amplitude: 0, wordRange: null }); return; }
              update(speechFrame(words, envelope, (job.audio.currentTime || 0) * 1000, snapshot.preferences.volume));
            };

            const pump = () => {
              if (!job.sourceBuffer || job.sourceBuffer.updating) return;
              if (job.mseQueue && job.mseQueue.length > 0) {
                const next = job.mseQueue.shift()!;
                job.mseQueuedBytes = Math.max(0, (job.mseQueuedBytes ?? 0) - next.byteLength);
                try { job.sourceBuffer.appendBuffer(next); }
                catch { job.finish({ status: "error", error: "浏览器无法播放语音。" }); }
                return;
              }
              if (job.mseEnded && job.mediaSource && job.mediaSource.readyState === "open") {
                try { job.mediaSource.endOfStream(); } catch { /* ignore */ }
              }
            };

            await new Promise<void>((resolve, reject) => {
              const onOpen = () => { cleanup(); resolve(); };
              const onError = () => { cleanup(); reject(new Error("media source error")); };
              const onAbort = () => { cleanup(); reject(new Error("aborted")); };
              const cleanup = () => {
                ms.removeEventListener("sourceopen", onOpen);
                ms.removeEventListener("error", onError);
                controller.signal.removeEventListener("abort", onAbort);
              };
              ms.addEventListener("sourceopen", onOpen, { once: true });
              ms.addEventListener("error", onError, { once: true });
              controller.signal.addEventListener("abort", onAbort, { once: true });
              if (controller.signal.aborted) onAbort();
            });
            if (job.done) return;
            const sb = ms.addSourceBuffer("audio/mpeg");
            job.sourceBuffer = sb;
            sb.addEventListener("updateend", () => {
              if (job.done) return;
              // Segment receipt: increment only after appendBuffer() succeeds (updateend).
              if (ledger.segmentsAppended < ledger.segmentsReceived) {
                ledger.segmentsAppended += 1;
                update({ playbackLedger: { ...ledger } });
              }
              pump();
            });
            sb.addEventListener("error", () => {
              if (!job.done) job.finish({ status: "error", error: "浏览器无法播放语音。" });
            });

            try { await routeAudioOutput(audio, snapshot.preferences.outputDeviceId); }
            catch (error) { job.finish({ status: "error", error: error instanceof Error ? error.message : "输出设备不可用。" }); return; }
            if (job.done) return;

            audio.ontimeupdate = tick;
            audio.onpause = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
            audio.onwaiting = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
            audio.onplaying = () => {
              if (job.done) return;
              const now = Math.max(0, Math.round(performance.now() - startedAt));
              if (ledger.firstAudibleFrameMs === null) ledger.firstAudibleFrameMs = now;
              if (ledger.timeToFirstPlayingMs === null) ledger.timeToFirstPlayingMs = now;
              update({ status: "playing", error: null, playbackLedger: { ...ledger } }); tick();
            };
            audio.onended = () => {
              ledger.completed = true;
              job.finish({ status: "completed" });
            };
            audio.onerror = () => job.finish({ status: "error", error: "浏览器无法播放语音。" });

            const playPromise = audio.play();
            if (playPromise && typeof playPromise.catch === "function") {
              playPromise.catch((error: unknown) => {
                if (job.done) return;
                const blocked = error instanceof DOMException && error.name === "NotAllowedError";
                job.finish({ status: "error", error: blocked ? "浏览器阻止了语音播放，请在控制页交互后重试。" : "浏览器无法播放语音。" });
              });
            }

            await consumeSpeechSse(response, controller.signal, async (chunk) => {
              if (job.done) throw new Error("cancelled");
              if (ledger.firstByteMs === null) {
                ledger.firstByteMs = Math.max(0, Math.round(performance.now() - startedAt));
                update({ playbackLedger: { ...ledger } });
              }
              // Single chunk too large: abort immediately instead of waiting forever.
              if (chunk.byteLength > MSE_MAX_QUEUED_BYTES) {
                job.finish({ status: "error", error: "音频块过大。" });
                throw new Error("音频块过大。");
              }
              // Backpressure: wait for SourceBuffer to drain instead of failing fast.
              const waitForDrain = async () => {
                while ((job.mseQueue?.length ?? 0) >= MSE_MAX_QUEUED_CHUNKS
                  || (job.mseQueuedBytes ?? 0) + chunk.byteLength > MSE_MAX_QUEUED_BYTES) {
                  if (job.done) throw new Error("cancelled");
                  await new Promise<void>((resolve) => {
                    const onDrain = () => { resolve(); };
                    if (job.sourceBuffer) {
                      job.sourceBuffer.addEventListener("updateend", onDrain, { once: true });
                    } else {
                      setTimeout(resolve, 16);
                    }
                    // Also resolve on timeout to avoid deadlock
                    setTimeout(() => {
                      if (job.sourceBuffer) job.sourceBuffer.removeEventListener("updateend", onDrain);
                      resolve();
                    }, 100);
                  });
                }
              };
              await waitForDrain();
              if (job.done) throw new Error("cancelled");
              // Cap retained bytes to avoid unbounded memory growth on long playback.
              const accumulatedBytes = job.accumulatedBytes ?? 0;
              if (accumulatedBytes + chunk.byteLength <= MAX_ACCUMULATED_BYTES) {
                job.accumulated!.push(chunk);
                job.accumulatedBytes = accumulatedBytes + chunk.byteLength;
              }
              ledger.audioBytesReceived += chunk.byteLength;
              ledger.segmentsReceived += 1;
              update({ playbackLedger: { ...ledger } });
              const buf = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
              job.mseQueue!.push(buf as ArrayBuffer);
              job.mseQueuedBytes = (job.mseQueuedBytes ?? 0) + (buf as ArrayBuffer).byteLength;
              pump();
            }, (payload) => {
              words = Array.isArray(payload?.words) ? payload.words : words;
              job.mseEnded = true;
              pump();
            }, (errPayload) => {
              const message = errPayload && typeof errPayload === "object" && "message" in errPayload
                ? String(errPayload.message) : "语音流中断。";
              throw new Error(message);
            });

            if (job.done) return;
            // Decode envelope opportunistically from accumulated bytes.
            if (job.accumulated && job.accumulated.length > 0) {
              const total = job.accumulated.reduce((n, c) => n + c.byteLength, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of job.accumulated) { merged.set(c, off); off += c.byteLength; }
              const blob = new Blob([merged], { type: "audio/mpeg" });
              void decodeSpeechEnvelope(blob, controller.signal).then(value => {
                if (!job.done && active === job) { envelope = value; tick(); }
              });
            }
            // If stream ended but audio not yet ended, wait; onended will finish.
            return;
          } catch (error) {
            if (job.done) return;
            // MSE init failure after fetch: do NOT fall through to buffered path
            // (would trigger a second TTS POST). Report error and return.
            const blocked = error instanceof DOMException && error.name === "NotAllowedError";
            job.finish({ status: "error", error: blocked
              ? "浏览器阻止了语音播放，请在控制页交互后重试。"
              : (error instanceof Error ? error.message : "语音不可用：本地服务连接失败或请求超时。") });
            return;
          }
        }

        job.mseStartedAt = performance.now();
        const response = local ? await synthesizeLocalSpeech(spokenText, speed, controller.signal) : await fetch(phrase?.url ?? "/api/speech", {
          method: phrase ? "GET" : "POST",
          headers: { "content-type": "application/json" },
          ...(phrase ? {} : { body: JSON.stringify({ text: spokenText, voice, speed,
            ...(snapshot.preferences.timestamps ? { timestamps: true } : {}) }) }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          cache: phrase ? "force-cache" : "no-store",
        });
        if (job.done) return;
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => null);
          const error = body && typeof body === "object" && "error" in body &&
            typeof body.error === "string" ? body.error.slice(0, 300) : `语音不可用（HTTP ${response.status}）`;
          job.finish({ status: "error", error });
          return;
        }
        if (job.playbackLedger && job.playbackLedger.firstByteMs === null) {
          job.playbackLedger.firstByteMs = Math.max(0, Math.round(performance.now() - (job.mseStartedAt ?? performance.now())));
        }
        let words: SpeechWord[] = [];
        const timed = /^application\/json(?:;|$)/i.test(response.headers.get("content-type") ?? "") && !phrase
          ? await readTimedSpeech(response, spokenText, controller.signal) : null;
        const blob = timed?.blob ?? await response.blob();
        words = timed?.words ?? [];
        if (job.done) return;
        if (!blob.size || blob.size > 4 * 1024 * 1024 || !(local ? /^audio\/wav(;|$)/i.test(blob.type) : /^audio\/(mpeg|mp3)(;|$)/i.test(blob.type))) {
          job.finish({ status: "error", error: "语音服务未返回有效音频。" });
          return;
        }
        if (job.playbackLedger) {
          job.playbackLedger.mode = local ? "local" : phrase ? "prerecorded" : "buffered";
          job.playbackLedger.audioBytesReceived = blob.size;
        }
        job.url = URL.createObjectURL(blob);
        job.audio = new Audio(job.url);
        job.audio.volume = snapshot.preferences.volume;
        if (phrase) job.audio.playbackRate = speed;
        let envelope: SpeechEnvelope | null = null;
        const tick = () => {
          if (job.done || active !== job || !job.audio || !snapshot.playing) return;
          if (job.audio.paused === true) { update({ amplitude: 0, wordRange: null }); return; }
          update(speechFrame(words, envelope, (job.audio.currentTime || 0) * 1000, snapshot.preferences.volume));
        };
        // Decoding never delays playback; a late analysis cannot revive a cancelled job.
        void decodeSpeechEnvelope(blob, controller.signal).then(value => { if (!job.done && active === job) { envelope = value; tick(); } });
        job.audio.ontimeupdate = tick;
        job.audio.onpause = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
        job.audio.onwaiting = () => { if (!job.done) update({ status: "loading", amplitude: 0, wordRange: null }); };
        job.audio.onplaying = () => {
          if (job.done) return;
          if (job.playbackLedger) {
            const now = Math.max(0, Math.round(performance.now() - (job.mseStartedAt ?? performance.now())));
            if (job.playbackLedger.firstAudibleFrameMs === null) job.playbackLedger.firstAudibleFrameMs = now;
            if (job.playbackLedger.timeToFirstPlayingMs === null) job.playbackLedger.timeToFirstPlayingMs = now;
          }
          update({ status: "playing", error: null, playbackLedger: job.playbackLedger ? { ...job.playbackLedger } : null });
          tick();
        };
        job.audio.onended = () => {
          if (job.playbackLedger) job.playbackLedger.completed = true;
          job.finish({ status: "completed" });
        };
        job.audio.onerror = () => job.finish({ status: "error", error: "浏览器无法播放语音。" });
        try { await routeAudioOutput(job.audio, snapshot.preferences.outputDeviceId); }
        catch (error) { job.finish({ status: "error", error: error instanceof Error ? error.message : "输出设备不可用。" }); return; }
        if (job.done) return;
        await job.audio.play();
        if (!job.done) {
          update({ status: "playing", error: null }); tick();
          if (Number.isFinite(job.audio.currentTime)) {
            const timer = setInterval(tick, 100); job.stopTelemetry = () => clearInterval(timer);
          }
        }
      } catch (error) {
        if (job.done) return;
        const blocked = error instanceof DOMException && error.name === "NotAllowedError";
        job.finish({ status: "error", error: blocked
          ? "浏览器阻止了语音播放，请在控制页交互后重试。"
          : getVoiceConfiguration().tts === "local" && error instanceof Error ? error.message : "语音不可用：本地服务连接失败或请求超时。" });
      }
    };
    void run();
  });
};

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", cancelSpeech);
  window.addEventListener("vivic:voice-config-change", cancelSpeech);
}
