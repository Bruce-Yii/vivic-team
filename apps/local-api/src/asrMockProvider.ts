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
  sendAudio(chunk: Uint8Array): void;
  reset(): void;
  onAudioConsumed(cb: (seq?: number) => void): () => void;
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
  private consumedCbs = new Map<number, () => void>();
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

  sendAudio(chunk: Uint8Array): void {
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
    // Trigger consumed callback for this chunk (per-chunk ack)
    const cb = this.consumedCbs.get(this.chunkCount);
    if (cb) {
      cb();
      this.consumedCbs.delete(this.chunkCount);
    } else if (this.consumedCbs.size === 0) {
      // Fallback for providers that don't register per-chunk
    }
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

  onAudioConsumed(cb: (seq?: number) => void): () => void {
    const seq = this.chunkCount + 1; // next chunk's seq
    this.consumedCbs.set(seq, () => cb(seq));
    return () => {
      this.consumedCbs.delete(seq);
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
