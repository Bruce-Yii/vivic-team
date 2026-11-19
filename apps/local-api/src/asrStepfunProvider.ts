import { AsrErrorCode } from "@vivic/contracts";
import type { AsrProviderAdapter, AsrProviderCallbacks, MockAsrProviderConfig } from "./asrMockProvider.js";
import { MAX_ASR_PCM_BYTES } from "./asrAudio.js";

export interface StepfunAsrBackend {
  baseUrl: string;
  model: string;
  headers: Record<string, string>;
  protocol: "sse" | "multipart";
}

export interface StepfunAsrProviderDeps {
  resolveBackend: () => StepfunAsrBackend | { error: string } | undefined;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_SSE_BYTES = 64 * 1024;

const encodePcmWav = (pcm: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return buffer;
};

export class StepfunAsrProvider implements AsrProviderAdapter {
  private readonly deps: StepfunAsrProviderDeps;
  private partialCb: AsrProviderCallbacks["onPartial"] | null = null;
  private finalCb: AsrProviderCallbacks["onFinal"] | null = null;
  private errorCb: AsrProviderCallbacks["onError"] | null = null;
  private endedCb: AsrProviderCallbacks["onEnded"] | null = null;
  private consumedListeners = new Set<(ackToken?: number) => void>();
  private backend: StepfunAsrBackend | null = null;
  private language = "zh";
  private chunks: Uint8Array[] = [];
  private chunkCount = 0;
  private totalBytes = 0;
  private cancelled = false;
  private closed = false;
  private abortController: AbortController | null = null;

  constructor(deps: StepfunAsrProviderDeps) {
    this.deps = deps;
  }

  start(config: MockAsrProviderConfig = {}): void {
    const resolved = this.deps.resolveBackend();
    if (!resolved) {
      throw new Error("请先配置语音识别 ASR，或连接 StepFun API。");
    }
    if ("error" in resolved) {
      throw new Error(resolved.error);
    }
    this.backend = resolved;
    this.language = config.language ?? "zh";
    // A fresh session starts a fresh utterance; only `reset()` (transport resume)
    // reopens the provider while deliberately keeping already-collected audio.
    this.cancelled = false;
    this.closed = false;
    this.chunks = [];
    this.chunkCount = 0;
    this.totalBytes = 0;
    this.abortController = null;
  }

  sendAudio(chunk: Uint8Array, ackToken?: number): void {
    if (this.cancelled || this.closed) return;
    if (this.totalBytes + chunk.byteLength > MAX_ASR_PCM_BYTES) {
      throw new Error(AsrErrorCode.Backpressure);
    }
    this.chunkCount += 1;
    this.totalBytes += chunk.byteLength;
    this.chunks.push(new Uint8Array(chunk));
    const token = ackToken ?? this.chunkCount;
    for (const cb of [...this.consumedListeners]) cb(token);
  }

  /**
   * Reopens the provider for a resumed transport connection while keeping the
   * audio already buffered before the drop: a resumed turn is the same utterance
   * and must still transcribe the prefix when the client commits the tail.
   */
  reset(): void {
    this.cancelled = false;
    this.closed = false;
  }

  onAudioConsumed(cb: (ackToken?: number) => void): () => void {
    this.consumedListeners.add(cb);
    return () => {
      this.consumedListeners.delete(cb);
    };
  }

  commit(): void {
    if (this.cancelled || this.closed) return;
    void this.transcribeCommitted();
  }

  private async transcribeCommitted(): Promise<void> {
    if (!this.backend) {
      this.errorCb?.({ code: AsrErrorCode.ProviderUnavailable, message: "ASR 未初始化", fatal: true });
      return;
    }
    if (this.totalBytes === 0) {
      this.errorCb?.({ code: AsrErrorCode.ProviderError, message: "没有收到有效音频", fatal: true });
      return;
    }

    const pcm = Buffer.concat(this.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    this.chunks = [];

    const controller = new AbortController();
    this.abortController = controller;
    const timeoutMs = this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(new DOMException("ASR deadline", "TimeoutError")), timeoutMs);
    const fetchImpl = this.deps.fetchImpl ?? fetch;
    const startedAt = Date.now();

    try {
      const isMultipart = this.backend.protocol === "multipart";
      const headers = new Headers(this.backend.headers);
      let body: BodyInit;

      if (isMultipart) {
        headers.delete("content-type");
        headers.set("accept", "application/json");
        const form = new FormData();
        form.append("file", new Blob([encodePcmWav(pcm)], { type: "audio/wav" }), "voice.wav");
        form.append("model", this.backend.model);
        form.append("language", this.language);
        body = form;
      } else {
        headers.set("content-type", "application/json");
        headers.set("accept", "text/event-stream");
        body = JSON.stringify({
          audio: {
            data: pcm.toString("base64"),
            input: {
              transcription: {
                model: this.backend.model,
                language: this.language,
                enable_itn: true,
              },
              format: {
                type: "pcm",
                codec: "pcm_s16le",
                rate: 16000,
                bits: 16,
                channel: 1,
              },
            },
          },
        });
      }

      const url = `${this.backend.baseUrl.replace(/\/+$/, "")}/audio/${isMultipart ? "transcriptions" : "asr/sse"}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });

      if (this.cancelled || this.closed) return;

      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        this.errorCb?.({
          code: AsrErrorCode.ProviderUnavailable,
          message: `语音识别请求失败（HTTP ${response.status}）`,
          fatal: true,
        });
        return;
      }

      if (isMultipart) {
        const json = (await response.json()) as { text?: unknown };
        if (this.cancelled || this.closed) return;
        const text = typeof json.text === "string" ? json.text.trim() : "";
        if (!text) {
          this.errorCb?.({ code: AsrErrorCode.ProviderError, message: "未识别到有效文字", fatal: true });
          return;
        }
        this.finalCb?.({ text, durationMs: Date.now() - startedAt });
        return;
      }

      const text = await this.readSseTranscript(response, controller.signal);
      if (this.cancelled || this.closed) return;
      this.finalCb?.({ text, durationMs: Date.now() - startedAt });
    } catch (error) {
      if (this.cancelled || this.closed) return;
      const isTimeout = controller.signal.aborted && (controller.signal.reason as { name?: string })?.name === "TimeoutError";
      this.errorCb?.({
        code: isTimeout ? AsrErrorCode.ProviderError : AsrErrorCode.ProviderUnavailable,
        message: error instanceof Error ? error.message : "语音识别请求失败",
        fatal: true,
      });
    } finally {
      clearTimeout(timer);
      if (this.abortController === controller) this.abortController = null;
    }
  }

  private async readSseTranscript(response: Response, signal: AbortSignal): Promise<string> {
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream" || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("识别服务未返回有效的 SSE 流");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    let data: string[] = [];
    let partial = "";
    let finalText: string | undefined;
    let totalBytes = 0;

    const dispatch = () => {
      if (!data.length) return;
      const raw = data.join("\n");
      data = [];
      let event: { type?: unknown; delta?: unknown; text?: unknown };
      try {
        event = JSON.parse(raw) as { type?: unknown; delta?: unknown; text?: unknown };
      } catch {
        throw new Error("识别服务返回了无法解析的事件");
      }
      if (event.type === "error") {
        throw new Error("语音识别上游返回错误");
      }
      if (event.type === "transcript.text.delta" && typeof event.delta === "string") {
        partial += event.delta;
        this.partialCb?.({ text: partial });
      } else if (event.type === "transcript.text.done" && typeof event.text === "string") {
        const trimmed = event.text.trim();
        if (!trimmed) throw new Error("未识别到有效文字");
        finalText = trimmed;
      }
    };

    try {
      for (;;) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        totalBytes += value?.byteLength ?? 0;
        if (totalBytes > MAX_SSE_BYTES) throw new Error("识别服务响应过大");
        pending += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        for (;;) {
          const match = /[\r\n]/.exec(pending);
          if (!match || (!done && match.index === pending.length - 1 && match[0] === "\r")) break;
          const line = pending.slice(0, match.index);
          const width = pending.slice(match.index, match.index + 2) === "\r\n" ? 2 : 1;
          pending = pending.slice(match.index + width);
          if (!line) dispatch();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
          if (finalText !== undefined) return finalText;
        }
        if (done) break;
      }
      dispatch();
      if (finalText === undefined) throw new Error("识别服务未返回最终结果");
      return finalText;
    } finally {
      void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abortController?.abort();
    this.chunks = [];
    this.endedCb?.({ reason: "cancelled" });
  }

  close(): void {
    this.closed = true;
    this.cancelled = true;
    this.abortController?.abort();
    // Buffered PCM is intentionally kept: a dropped transport may resume within
    // the gateway grace window and commit the whole utterance. `reset()` reopens
    // the provider; the session is deleted from the gateway once grace expires.
  }

  onPartial(cb: AsrProviderCallbacks["onPartial"]): void {
    this.partialCb = cb;
  }

  onFinal(cb: AsrProviderCallbacks["onFinal"]): void {
    this.finalCb = cb;
  }

  onError(cb: AsrProviderCallbacks["onError"]): void {
    this.errorCb = cb;
  }

  onEnded(cb: AsrProviderCallbacks["onEnded"]): void {
    this.endedCb = cb;
  }
}
