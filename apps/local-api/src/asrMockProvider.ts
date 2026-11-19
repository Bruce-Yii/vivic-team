import {
  ASR_BACKPRESSURE_MAX_BYTES,
  ASR_BACKPRESSURE_MAX_CHUNKS,
  AsrErrorCode,
} from "@vivic/contracts";

export interface AsrProviderCallbacks {
  onPartial: (payload: { text: string; stash?: string; words?: unknown[]; seq?: number; segmentId?: string; isFinalSegment?: boolean }) => void;
  onFinal: (payload: { text: string; segmentId?: string; words?: unknown[]; usage?: unknown; durationMs?: number }) => void;
  onError: (payload: { code: string; message: string; retryable?: boolean; fatal?: boolean; seq?: number }) => void;
  onEnded: (payload: { reason: string; stats?: unknown }) => void;
}

export interface MockAsrProviderConfig {
  partialDelayMs?: number;
  finalDelayMs?: number;
  wordsPerPartial?: number;
  emitStash?: boolean;
  failAfterChunks?: number;
  backpressureAfterChunks?: number;
  vadMode?: "server" | "client" | "none";
  provider?: string;
  language?: string;
}

export interface AsrProviderAdapter {
  start(config: MockAsrProviderConfig): void | Promise<void>;
  /**
   * Accepts one PCM frame. `ackToken` is an opaque, gateway-assigned marker for
   * this frame; a provider that has consumed the frame must hand the same token
   * back through the `onAudioConsumed` subscribers. Token identity keeps the
   * ack channel independent of the provider's own frame counters, which resume
   * (reset + a new transport connection) necessarily rewinds.
   */
  sendAudio(chunk: Uint8Array, ackToken?: number): void;
  reset(): void;
  onAudioConsumed(cb: (ackToken?: number) => void): () => void;
  commit(): void;
  cancel(): void;
  close(): void;
  onPartial(cb: AsrProviderCallbacks["onPartial"]): void;
  onFinal(cb: AsrProviderCallbacks["onFinal"]): void;
  onError(cb: AsrProviderCallbacks["onError"]): void;
  onEnded(cb: AsrProviderCallbacks["onEnded"]): void;
}

export class MockAsrProvider implements AsrProviderAdapter {
  private config: Required<MockAsrProviderConfig>;
  private partialCb: AsrProviderCallbacks["onPartial"] | null = null;
  private finalCb: AsrProviderCallbacks["onFinal"] | null = null;
  private errorCb: AsrProviderCallbacks["onError"] | null = null;
  private endedCb: AsrProviderCallbacks["onEnded"] | null = null;
  private chunkCount = 0;
  private consumedListeners = new Set<(ackToken?: number) => void>();
  private totalBytes = 0;
  private words: string[] = [];
  private cancelled = false;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;
  private finalTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: MockAsrProviderConfig = {}) {
    this.config = {
      partialDelayMs: config.partialDelayMs ?? 300,
      finalDelayMs: config.finalDelayMs ?? 200,
      wordsPerPartial: config.wordsPerPartial ?? 3,
      emitStash: config.emitStash ?? true,
      failAfterChunks: config.failAfterChunks ?? 0,
      backpressureAfterChunks: config.backpressureAfterChunks ?? 0,
      vadMode: config.vadMode ?? "server",
      provider: config.provider ?? "mock",
      language: config.language ?? "zh",
    };
  }

  start(config: MockAsrProviderConfig = {}): void {
    this.config = { ...this.config, ...config } as Required<MockAsrProviderConfig>;
  }

  sendAudio(chunk: Uint8Array, ackToken?: number): void {
    if (this.cancelled) return;
    this.chunkCount += 1;
    this.totalBytes += chunk.byteLength;
    if (this.config.backpressureAfterChunks > 0 && this.chunkCount >= this.config.backpressureAfterChunks) {
      throw new Error(AsrErrorCode.Backpressure);
    }
    if (this.config.failAfterChunks > 0 && this.chunkCount >= this.config.failAfterChunks) {
      const delay = 0;
      setTimeout(() => {
        if (this.cancelled) return;
        this.errorCb?.({ code: AsrErrorCode.ProviderError, message: "mock provider error", retryable: true, fatal: false, seq: this.chunkCount });
      }, delay);
    }
    if (this.partialTimer) clearTimeout(this.partialTimer);
    this.partialTimer = setTimeout(() => this.emitPartial(), this.config.partialDelayMs);
    // Consumption is reported with the gateway's token; the local chunkCount is
    // only used for mock partial text and never as the ack key.
    const token = ackToken ?? this.chunkCount;
    for (const cb of [...this.consumedListeners]) cb(token);
  }

  private emitPartial(): void {
    if (this.cancelled) return;
    for (let i = 0; i < this.config.wordsPerPartial; i += 1) {
      this.words.push(`词${this.words.length + 1}`);
    }
    const text = this.words.join("");
    const stash = this.config.emitStash ? `尾${this.chunkCount}` : undefined;
    this.partialCb?.({ text, stash, seq: this.chunkCount });
  }

  commit(): void {
    if (this.cancelled) return;
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
      this.emitPartial();
    }
    this.finalTimer = setTimeout(() => this.emitFinal(), this.config.finalDelayMs);
  }

  private emitFinal(): void {
    if (this.cancelled) return;
    const text = this.words.length ? this.words.join("") : `模拟识别 第${this.chunkCount}段`;
    this.finalCb?.({ text, durationMs: this.chunkCount * 100 });
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
    this.endedCb?.({ reason: "cancelled" });
  }

  close(): void {
    this.cancelled = true;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
  }

  reset(): void {
    this.cancelled = false;
  }

  onAudioConsumed(cb: (ackToken?: number) => void): () => void {
    this.consumedListeners.add(cb);
    return () => {
      this.consumedListeners.delete(cb);
    };
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

export function createMockAsrProvider(config: MockAsrProviderConfig = {}): MockAsrProvider {
  return new MockAsrProvider(config);
}
