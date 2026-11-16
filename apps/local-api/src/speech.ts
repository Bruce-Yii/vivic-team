import type { StepfunCredential } from "./credentials.js";
import type { StepfunDeps } from "./stepfun.js";
import { DEFAULT_SPEECH_SPEED, DEFAULT_SPEECH_VOICE, type SpeechOptions } from "./voices.js";
import { readSpeechStream, SPEECH_STREAM_MAX_AUDIO_BYTES } from "./speechStream.js";
import type { SpeechWord } from "@vivic/contracts";
import { inspectWav } from "./modelApi/wav.js";

export const SPEECH_MODEL = "stepaudio-2.5-tts";
const MAX_AUDIO_BYTES = SPEECH_STREAM_MAX_AUDIO_BYTES;
const AUDIO_MIMES: Record<"mp3" | "wav", readonly string[]> = {
  mp3: ["audio/mpeg", "audio/mp3", "application/octet-stream"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave", "application/octet-stream"],
};

type SpeechFailure = { ok: false; status: 502 | 503 | 504; code: string; error: string };

type SpeechResult =
  | { ok: true; audio: Uint8Array<ArrayBuffer>; words?: SpeechWord[]; mime?: "audio/mpeg" | "audio/wav" }
  | SpeechFailure;

/** Server-resolved saved configuration; never accepted from an HTTP body. */
export interface SpeechBackend {
  baseUrl: string; model: string; headers: Record<string, string>;
  format: "mp3" | "wav"; voice?: string; supportsTimestamps: boolean; clientSpeed?: boolean;
}

/** Timing hooks for the request log; never receives text or provider bodies. */
export interface SpeechHooks {
  onFirstByte?: () => void;
}

export interface PlannedSpeechRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  format: "mp3" | "wav";
  timestamps: boolean;
  /** A saved TTS provider (vs. the StepFun Plan account) changes only the public error copy. */
  customBackend: boolean;
}

export type SpeechPlan = { ok: true; plan: PlannedSpeechRequest } | SpeechFailure;

const planFailure = (): SpeechFailure => ({
  ok: false, status: 503, code: "speech-plan-required",
  error: "语音不可用：后端 Plan 地址配置无效。",
});

/**
 * Decide the single fixed upstream request. Streaming asks StepFun for SSE
 * audio deltas (`stream_format: "sse"`); the non-streaming shape is unchanged.
 */
export const planSpeech = (
  credential: StepfunCredential,
  text: string,
  deps: StepfunDeps,
  options: SpeechOptions = {},
  backend?: SpeechBackend,
  streaming = false,
): SpeechPlan => {
  const base = (backend?.baseUrl ?? deps.baseUrl).replace(/\/+$/, "");
  const format = backend?.format ?? "mp3";
  const timestamps = Boolean(options.timestamps && (backend?.supportsTimestamps ?? true));
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return planFailure();
  }
  // Prevent an accidental ordinary StepFun base override from billing TTS.
  if ((url.hostname === "api.stepfun.com" || url.hostname === "api.stepfun.ai") &&
      (url.protocol !== "https:" || !(url.pathname === "/step_plan/v1" || backend && url.pathname === "/v1") || url.search || url.hash || url.username || url.password)) {
    return {
      ok: false, status: 503, code: "speech-plan-required",
      error: "语音不可用：必须使用 StepFun Plan 地址，不会切换按量计费接口。",
    };
  }
  const body: Record<string, unknown> = {
    model: backend?.model ?? SPEECH_MODEL, input: text, voice: backend?.voice ?? options.voice ?? DEFAULT_SPEECH_VOICE,
    response_format: format, ...(!backend?.clientSpeed ? { speed: options.speed ?? DEFAULT_SPEECH_SPEED } : {}),
  };
  // `timestamp` requires SSE upstream; a streaming request needs SSE even
  // without subtitles so audio deltas arrive while synthesis is still running.
  if (timestamps) Object.assign(body, { timestamp: true, stream_format: "sse" });
  else if (streaming) body.stream_format = "sse";
  const accept = streaming ? "text/event-stream"
    : timestamps ? "text/event-stream, audio/mpeg"
      : format === "wav" ? "audio/wav" : "audio/mpeg";
  return {
    ok: true,
    plan: {
      url: `${base}/audio/speech`,
      headers: { ...(backend?.headers ?? { authorization: `Bearer ${credential.apiKey}` }), "content-type": "application/json", accept },
      body: JSON.stringify(body),
      format, timestamps, customBackend: Boolean(backend),
    },
  };
};

const timeoutSignal = (deps: StepfunDeps, signal?: AbortSignal) =>
  AbortSignal.any([AbortSignal.timeout(deps.timeoutMs ?? 15000), ...(signal ? [signal] : [])]);

const upstreamRejected = (status: number, customBackend: boolean): SpeechFailure => ({
  ok: false, status: 503, code: "speech-unavailable",
  error: customBackend ? `语音 API 请求被拒绝（HTTP ${status}），请检查所选 TTS 的 Key、模型和权限。`
    : `语音不可用：Plan 语音请求被拒绝（HTTP ${status}），请检查套餐权限或额度；不会切换计费接口。`,
});

/** One buffered request to the selected endpoint. No retries or alternate billing routes. */
export const synthesizeSpeech = async (
  credential: StepfunCredential,
  text: string,
  deps: StepfunDeps,
  signal?: AbortSignal,
  options: SpeechOptions = {},
  backend?: SpeechBackend,
  hooks: SpeechHooks = {},
): Promise<SpeechResult> => {
  const planned = planSpeech(credential, text, deps, options, backend, false);
  if (!planned.ok) return planned;
  const plan = planned.plan;
  const requestSignal = timeoutSignal(deps, signal);
  try {
    const res = await (deps.fetchImpl ?? fetch)(plan.url, {
      method: "POST", headers: plan.headers, body: plan.body, redirect: "error", signal: requestSignal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return upstreamRejected(res.status, plan.customBackend);
    }
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (plan.timestamps && mime === "text/event-stream") {
      try {
        const { audio, words } = await readSpeechStream(res, text, requestSignal);
        return { ok: true, audio, words };
      } catch {
        requestSignal.throwIfAborted();
        return { ok: false, status: 502, code: "speech-invalid-stream", error: "语音服务返回的音频流不完整或格式无效，未播放。" };
      }
    }
    if (!AUDIO_MIMES[plan.format].includes(mime ?? "") ||
        Number(res.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES || !res.body) {
      await res.body?.cancel();
      return { ok: false, status: 502, code: "speech-invalid-audio", error: `语音服务未返回有效的 ${plan.format.toUpperCase()} 音频。` };
    }
    // Bound even responses without Content-Length; keep timeout through body read.
    const reader = res.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0, firstByte = false;
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) break;
        if (!firstByte) { firstByte = true; hooks.onFirstByte?.(); }
        size += chunk.value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel();
          return { ok: false, status: 502, code: "speech-audio-too-large", error: "语音服务返回的音频过大。" };
        }
        chunks.push(chunk.value);
      }
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    if (!size) {
      return { ok: false, status: 502, code: "speech-empty-audio", error: "语音服务返回了空音频。" };
    }
    const audio = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      audio.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (plan.format === "wav") {
      try { if (!inspectWav(audio).nonSilent) throw Error("silent"); }
      catch { return { ok: false, status: 502, code: "speech-invalid-audio", error: "语音 API 返回的 WAV 音频无效或静音。" }; }
    }
    return { ok: true, audio, mime: plan.format === "wav" ? "audio/wav" : "audio/mpeg" };
  } catch {
    // Neither upstream bodies nor transport error messages are safe to echo.
    const timedOut = requestSignal.aborted && requestSignal.reason?.name === "TimeoutError";
    return {
      ok: false, status: timedOut ? 504 : 503,
      code: timedOut ? "speech-timeout" : "speech-unavailable",
      error: timedOut ? "语音合成超时，请稍后重试。" : "语音不可用：请求已取消或网络连接失败。",
    };
  }
};

export type SpeechStreamOutcome =
  | { ok: true; audioBytes: number; words: SpeechWord[] }
  | { ok: false; code: string; error: string };

/**
 * Relay validated upstream audio deltas as soon as they arrive. The caller owns
 * response framing; this function only guarantees bounded, validated chunks and
 * terminal error codes. Partial audio is intentional: streaming cannot replay.
 */
export const streamSpeech = async (
  plan: PlannedSpeechRequest,
  text: string,
  deps: StepfunDeps,
  signal: AbortSignal | undefined,
  onAudio: (chunk: Uint8Array) => void | Promise<void>,
): Promise<SpeechStreamOutcome> => {
  const requestSignal = timeoutSignal(deps, signal);
  let audioBytes = 0;
  try {
    const res = await (deps.fetchImpl ?? fetch)(plan.url, {
      method: "POST", headers: plan.headers, body: plan.body, redirect: "error", signal: requestSignal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      return upstreamRejected(res.status, plan.customBackend);
    }
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mime === "text/event-stream") {
      const { words } = await readSpeechStream(res, text, requestSignal, {
        onAudio: async (chunk) => { audioBytes += chunk.byteLength; await onAudio(chunk); },
      });
      return { ok: true, audioBytes, words };
    }
    // Defensive fallback: an upstream that ignores stream_format still gets
    // relayed incrementally instead of being buffered into one late response.
    if (!AUDIO_MIMES[plan.format].includes(mime ?? "") ||
        Number(res.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES || !res.body) {
      await res.body?.cancel();
      return { ok: false, code: "speech-invalid-audio", error: `语音服务未返回有效的 ${plan.format.toUpperCase()} 音频。` };
    }
    const reader = res.body.getReader();
    const onAbort = () => { void reader.cancel().catch(() => {}); };
    requestSignal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        requestSignal.throwIfAborted();
        const part = await reader.read();
        requestSignal.throwIfAborted();
        if (part.done) break;
        audioBytes += part.value.byteLength;
        if (audioBytes > MAX_AUDIO_BYTES) {
          await reader.cancel();
          return { ok: false, code: "speech-audio-too-large", error: "语音服务返回的音频过大。" };
        }
        await onAudio(part.value);
      }
    } finally {
      requestSignal.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    if (!audioBytes) return { ok: false, code: "speech-empty-audio", error: "语音服务返回了空音频。" };
    return { ok: true, audioBytes, words: [] };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "speech-audio-too-large") return { ok: false, code, error: "语音服务返回的音频过大。" };
    if (requestSignal.aborted && requestSignal.reason?.name === "TimeoutError") {
      return { ok: false, code: "speech-timeout", error: "语音合成超时，请稍后重试。" };
    }
    if (signal?.aborted) return { ok: false, code: "speech-cancelled", error: "语音请求已取消。" };
    return { ok: false, code: "speech-invalid-stream", error: "语音服务返回的音频流不完整或格式无效。" };
  }
};
