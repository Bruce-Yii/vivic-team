/**
 * One privacy-bounded JSON line per speech request on stderr:
 * requestId, text length (never text), streaming flag, first audio byte,
 * total elapsed, audio bytes and a static error code. No provider body,
 * credential, voice or user content is logged.
 */

export interface SpeechRequestLine {
  event: "speech";
  requestId: string;
  textChars: number;
  stream: boolean;
  firstByteMs: number | null;
  totalMs: number;
  audioBytes: number;
  error: string | null;
}

export interface SpeechMetrics {
  readonly requestId: string;
  readonly stream: boolean;
  readonly startedAt: number;
  textChars: number;
  firstByteMs: number | null;
  audioBytes: number;
  error: string | null;
  /** True once the SSE handler owns logging after the stream closes. */
  managedExternally: boolean;
  markFirstByte(): void;
  addBytes(count: number): void;
  fail(code: string): void;
  finish(): void;
}

const writeStderr = (line: string) => { process.stderr.write(`${line}\n`); };

/** `Accept: text/event-stream` or `?stream=1|true` opts into SSE; old clients stay buffered. */
export const speechStreamRequested = (accept: string | undefined, streamQuery: string | undefined): boolean => {
  if (accept?.toLowerCase().includes("text/event-stream")) return true;
  const value = streamQuery?.trim().toLowerCase();
  return value === "1" || value === "true";
};

export const createSpeechMetrics = (
  requestId: string,
  options: { stream: boolean; now?: () => number; write?: (line: string) => void },
): SpeechMetrics => {
  const now = options.now ?? (() => performance.now());
  const write = options.write ?? writeStderr;
  const startedAt = now();
  let written = false;
  const metrics: SpeechMetrics = {
    requestId,
    stream: options.stream,
    startedAt,
    textChars: 0,
    firstByteMs: null,
    audioBytes: 0,
    error: null,
    managedExternally: false,
    markFirstByte() {
      if (metrics.firstByteMs === null) metrics.firstByteMs = Math.max(0, Math.round(now() - startedAt));
    },
    addBytes(count) {
      if (Number.isFinite(count) && count > 0) metrics.audioBytes += Math.trunc(count);
    },
    fail(code) {
      if (!metrics.error && code) metrics.error = code;
    },
    finish() {
      if (written) return;
      written = true;
      const line: SpeechRequestLine = {
        event: "speech", requestId: metrics.requestId, textChars: metrics.textChars, stream: metrics.stream,
        firstByteMs: metrics.firstByteMs, totalMs: Math.max(0, Math.round(now() - startedAt)),
        audioBytes: metrics.audioBytes, error: metrics.error,
      };
      try { write(JSON.stringify(line)); } catch { /* logging must never break speech. */ }
    },
  };
  return metrics;
};
