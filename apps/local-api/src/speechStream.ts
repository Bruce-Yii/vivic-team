import { z } from "zod";
import { validSpeechWords, type SpeechWord } from "@vivic/contracts";

const MAX_AUDIO = 4 * 1024 * 1024, MAX_WIRE = 8 * 1024 * 1024;
const subtitleSchema = z.object({ text: z.string().max(1000), items: z.array(z.object({
  text: z.string().min(1).max(200), start_time: z.number().int().min(0).max(120000), end_time: z.number().int().min(0).max(120000),
})).max(400) });

/** Same bound the buffered audio path enforces; exported for relay metrics/guards. */
export const SPEECH_STREAM_MAX_AUDIO_BYTES = MAX_AUDIO;
export const SPEECH_STREAM_MAX_WIRE_BYTES = MAX_WIRE;

/**
 * Optional incremental sink. When present, each validated audio delta is
 * forwarded immediately instead of being buffered, so a caller can relay it
 * before the upstream finishes. Errors after a delta are terminal; already
 * forwarded bytes cannot be taken back.
 */
export interface SpeechStreamSink {
  onAudio: (chunk: Uint8Array) => void | Promise<void>;
}

export interface SpeechStreamResult {
  audio: Uint8Array<ArrayBuffer>;
  words: SpeechWord[];
  audioBytes: number;
}

const streamError = (code: "speech-invalid-stream" | "speech-audio-too-large", message: string) =>
  Object.assign(new Error(message), { code });

/** Fixed StepFun SSE events only. No provider URLs are followed or returned. */
export async function readSpeechStream(
  response: Response,
  text: string,
  signal: AbortSignal,
  sink?: SpeechStreamSink,
): Promise<SpeechStreamResult> {
  if (!response.body || Number(response.headers.get("content-length") ?? 0) > MAX_WIRE) {
    void response.body?.cancel().catch(() => {});
    throw streamError("speech-invalid-stream", "invalid speech stream");
  }
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks: Uint8Array[] = [];
  const items: z.infer<typeof subtitleSchema>["items"] = [];
  let wire = 0, audioBytes = 0, buffer = "", data: string[] = [];
  let audioDone = false, done = false, invalidWords = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  const event = async () => {
    if (!data.length) return;
    const payload = data.join("\n"); data = [];
    if (done) throw streamError("speech-invalid-stream", "data after completion");
    if (payload === "[DONE]") { if (!audioDone) throw streamError("speech-invalid-stream", "incomplete audio"); done = true; return; }
    const value = JSON.parse(payload);
    if (!value || typeof value !== "object") throw streamError("speech-invalid-stream", "invalid event");
    if (value.type === "speech.audio.error") throw streamError("speech-invalid-stream", "provider failure");
    if (value.type === "speech.audio.done") { if (audioDone) throw streamError("speech-invalid-stream", "duplicate completion"); audioDone = true; return; }
    if (value.type === "speech.audio.delta") {
      if (audioDone || typeof value.audio !== "string" || value.audio.length > 6 * 1024 * 1024
        || value.audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.audio)) throw streamError("speech-invalid-stream", "invalid audio chunk");
      const bytes = Buffer.from(value.audio, "base64"); audioBytes += bytes.length;
      if (audioBytes > MAX_AUDIO) throw streamError("speech-audio-too-large", "audio too large");
      // Forward first; buffering would reintroduce the full-utterance latency.
      if (sink) await sink.onAudio(bytes);
      else chunks.push(bytes);
      return;
    }
    if (value.type === "response.subtitle") {
      if (audioDone) throw streamError("speech-invalid-stream", "late subtitle");
      const parsed = subtitleSchema.safeParse(value.data);
      if (!parsed.success || items.length + parsed.data.items.length > 400) { invalidWords = true; return; }
      items.push(...parsed.data.items); return;
    }
    throw streamError("speech-invalid-stream", "unknown speech event");
  };
  const lines = async (final = false) => {
    const rows = buffer.split(/\r?\n/); buffer = final ? "" : rows.pop()!;
    for (const line of rows) {
      if (line.length > 6 * 1024 * 1024) throw streamError("speech-invalid-stream", "speech event too large");
      if (!line) await event();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (!line.startsWith(":") && !/^(?:event|id|retry):/.test(line)) throw streamError("speech-invalid-stream", "invalid SSE line");
    }
    if (final) await event();
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read(); signal.throwIfAborted();
      if (part.done) break;
      wire += part.value.byteLength; if (wire > MAX_WIRE) throw streamError("speech-invalid-stream", "speech response too large");
      buffer += decoder.decode(part.value, { stream: true }); await lines();
      if (buffer.length > 6 * 1024 * 1024) throw streamError("speech-invalid-stream", "speech event too large");
    }
    buffer += decoder.decode(); await lines(true);
    if (!done || !audioDone || !audioBytes) throw streamError("speech-invalid-stream", "truncated speech stream");
    const audio = sink ? new Uint8Array(0) : new Uint8Array(audioBytes);
    if (!sink) {
      let offset = 0;
      for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length; }
    }
    const words: SpeechWord[] = []; let cursor = 0;
    for (const item of items) {
      while (/\s/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
      if (!text.startsWith(item.text, cursor)) { invalidWords = true; break; }
      words.push({ startMs: item.start_time, endMs: item.end_time, charStart: cursor, charEnd: cursor + item.text.length });
      cursor += item.text.length;
    }
    if (text.slice(cursor).trim()) invalidWords = true;
    return { audio, words: invalidWords ? [] : validSpeechWords(text, words), audioBytes };
  } finally {
    signal.removeEventListener("abort", onAbort);
    void reader.cancel().catch(() => {}); reader.releaseLock();
  }
}
