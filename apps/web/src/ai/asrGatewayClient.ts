export interface AsrGatewayCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (code: string, message: string) => void;
  onEnded: (reason: string) => void;
}

export class AsrGatewayClient {
  private ws: WebSocket | null = null;
  private sessionId: string | null = null;
  private callbacks: AsrGatewayCallbacks;
  private seq = 0;

  constructor(callbacks: AsrGatewayCallbacks) {
    this.callbacks = callbacks;
  }

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/asr`;
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.sessionId = crypto.randomUUID();
        this.ws?.send(JSON.stringify({
          type: "session.start",
          protocolVersion: "vivic-asr-protocol@1",
          sessionId: this.sessionId,
          audio: { format: { type: "pcm", codec: "pcm_s16le", rate: 16000, bits: 16, channel: 1 } },
          provider: "mock",
          language: "zh",
          vad: "client",
        }));
      };
      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "session.started") {
            resolve(true);
          } else if (msg.type === "partial") {
            this.callbacks.onPartial(msg.text ?? "");
          } else if (msg.type === "final") {
            this.callbacks.onFinal(msg.text ?? "");
          } else if (msg.type === "session.ended") {
            this.callbacks.onEnded(msg.reason ?? "completed");
          }
        } catch { /* ignore parse errors */ }
      };
      this.ws.onerror = () => resolve(false);
      this.ws.onclose = () => { this.ws = null; };
      setTimeout(() => resolve(false), 5000);
    });
  }

  sendAudio(chunk: Float32Array): void {
    if (!this.ws || !this.sessionId) return;
    const pcm = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(chunk[i] * 32767)));
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
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
    if (!this.ws || !this.sessionId) return;
    this.ws.send(JSON.stringify({ type: "session.end", sessionId: this.sessionId, protocolVersion: "vivic-asr-protocol@1" }));
  }

  cancel(): void {
    if (!this.ws || !this.sessionId) return;
    this.ws.send(JSON.stringify({ type: "cancel", sessionId: this.sessionId, protocolVersion: "vivic-asr-protocol@1" }));
  }

  close(): void {
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.sessionId = null;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
