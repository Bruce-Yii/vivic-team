export interface AsrGatewayCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (code: string, message: string) => void;
  onEnded: (reason: string) => void;
}

export interface AsrGatewayClientOptions {
  /** ASR provider passed to the gateway; defaults to "mock" for backward compatibility. */
  provider?: "mock" | "stepfun" | "local";
  language?: string;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  reconnectBaseDelayMs?: number;
  /** Injectable WebSocket constructor for unit testing. */
  createWebSocket?: (url: string) => WebSocket;
}

const DEFAULT_AUDIO_FORMAT = {
  type: "pcm",
  codec: "pcm_s16le",
  rate: 16000,
  bits: 16,
  channel: 1,
} as const;

export class AsrGatewayClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private sessionActive = false;
  private manualClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private callbacks: AsrGatewayCallbacks;
  private options: Required<Pick<AsrGatewayClientOptions, "provider" | "language" | "autoReconnect" | "maxReconnectAttempts" | "reconnectBaseDelayMs">> & {
    createWebSocket?: (url: string) => WebSocket;
  };
  private seq = 0;

  constructor(callbacks: AsrGatewayCallbacks, options: AsrGatewayClientOptions = {}) {
    this.callbacks = callbacks;
    this.options = {
      provider: options.provider ?? "mock",
      language: options.language ?? "zh",
      autoReconnect: options.autoReconnect ?? true,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 3,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs ?? 500,
      createWebSocket: options.createWebSocket,
    };
  }

  private buildUrl(): string {
    const protocol = typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = typeof window !== "undefined" ? window.location.host : "127.0.0.1:8799";
    return `${protocol}//${host}/asr`;
  }

  private sendSessionStart(resumeSessionId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sessionId = resumeSessionId ?? crypto.randomUUID();
    // A resume continues this connection's own numbering: resetting to 0 here made
    // the gateway reject every frame as out-of-order after a reconnect.
    if (!resumeSessionId) this.seq = 0;
    this.sessionActive = true;
    this.ws.send(JSON.stringify({
      type: "session.start",
      protocolVersion: "vivic-asr-protocol@1",
      sessionId: this.sessionId,
      ...(resumeSessionId ? { resumeSessionId, resumeSeq: this.seq } : {}),
      audio: { format: DEFAULT_AUDIO_FORMAT },
      provider: this.options.provider,
      language: this.options.language,
      vad: "client",
    }));
  }

  private scheduleReconnect(resumeSessionId?: string): void {
    if (this.manualClose || !this.options.autoReconnect) return;
    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.callbacks.onError("asr-reconnect-exhausted", "ASR 网关重连失败，请重试。");
      return;
    }
    const delayMs = this.options.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualClose) return;
      void this.connect(resumeSessionId);
    }, delayMs);
  }

  async connect(resumeSessionId?: string): Promise<boolean> {
    this.manualClose = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      const url = this.buildUrl();
      const ws = this.options.createWebSocket ? this.options.createWebSocket(url) : new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.sendSessionStart(resumeSessionId);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(String(event.data)) as {
            type?: string;
            text?: string;
            reason?: string;
            code?: string;
            message?: string;
          };
          if (msg.type === "session.started") {
            this.sessionActive = true;
            finish(true);
          } else if (msg.type === "partial") {
            this.callbacks.onPartial(msg.text ?? "");
          } else if (msg.type === "final") {
            this.callbacks.onFinal(msg.text ?? "");
          } else if (msg.type === "error") {
            this.callbacks.onError(msg.code ?? "asr-error", msg.message ?? "ASR 服务错误");
            if (!settled) finish(false);
          } else if (msg.type === "session.ended") {
            this.sessionActive = false;
            this.callbacks.onEnded(msg.reason ?? "completed");
          }
        } catch {
          /* ignore malformed frames */
        }
      };

      ws.onerror = () => {
        this.callbacks.onError("asr-socket-error", "ASR 连接发生错误");
        finish(false);
      };

      ws.onclose = () => {
        const prevSession = this.sessionActive ? this.sessionId ?? undefined : undefined;
        this.ws = null;
        this.sessionActive = false;
        finish(false);
        if (!this.manualClose) {
          this.scheduleReconnect(prevSession);
        }
      };

      setTimeout(() => finish(false), 5000);
    });
  }

  /** Starts a fresh ASR session on the existing open WebSocket for multi-turn speech. */
  startTurnSession(): void {
    if (!this.isConnected()) return;
    this.sendSessionStart();
  }

  sendAudio(chunk: Float32Array): void {
    if (!this.isConnected() || !this.ws) return;
    if (!this.sessionActive || !this.sessionId) {
      this.startTurnSession();
    }
    if (!this.sessionId) return;
    const pcm = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const sample = chunk[i] ?? 0;
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
    const b64 = btoa(binary);
    this.ws.send(JSON.stringify({
      type: "audio.chunk",
      protocolVersion: "vivic-asr-protocol@1",
      sessionId: this.sessionId,
      seq: this.seq++,
      audio: b64,
    }));
  }

  commit(): void {
    if (!this.isConnected() || !this.ws || !this.sessionId || !this.sessionActive) return;
    this.sessionActive = false;
    this.ws.send(JSON.stringify({
      type: "session.end",
      sessionId: this.sessionId,
      protocolVersion: "vivic-asr-protocol@1",
    }));
  }

  cancel(): void {
    if (!this.isConnected() || !this.ws || !this.sessionId || !this.sessionActive) return;
    this.sessionActive = false;
    this.ws.send(JSON.stringify({
      type: "cancel",
      sessionId: this.sessionId,
      protocolVersion: "vivic-asr-protocol@1",
    }));
  }

  close(): void {
    this.manualClose = true;
    this.sessionActive = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.sessionId = null;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  isSessionActive(): boolean {
    return this.sessionActive;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
