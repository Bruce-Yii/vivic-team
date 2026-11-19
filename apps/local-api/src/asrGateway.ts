import { randomUUID } from "node:crypto";
import {
  ASR_BACKPRESSURE_MAX_BYTES,
  ASR_BACKPRESSURE_MAX_CHUNKS,
  ASR_GRACE_MS,
  ASR_HEARTBEAT_MS,
  ASR_IDLE_TIMEOUT_MS,
  ASR_MAX_SESSION_MS,
  ASR_TRANSPORT_VERSION,
  AsrErrorCode,
  AsrSessionState,
  type AsrTransportMessage,
} from "@vivic/contracts";
import { AsrTransportMessageSchema } from "@vivic/contracts";
import { MockAsrProvider, type AsrProviderAdapter, type MockAsrProviderConfig } from "./asrMockProvider.js";

export interface AsrSocket {
  send(message: unknown): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  isOpen(): boolean;
}

export interface AsrAuthResult {
  ok: boolean;
  accountId?: string;
  deviceId?: string;
  spaceId?: string;
  error?: string;
  code?: number;
}

export interface AsrGatewayLimits {
  maxSessionMs?: number;
  idleTimeoutMs?: number;
  graceMs?: number;
  heartbeatMs?: number;
  backpressureMaxChunks?: number;
  backpressureMaxBytes?: number;
}

export interface AsrGatewayOptions {
  providerFactory?: (config: MockAsrProviderConfig) => AsrProviderAdapter;
  now?: () => number;
  limits?: AsrGatewayLimits;
  authenticate?: (request: Request) => Promise<AsrAuthResult> | AsrAuthResult;
}

interface Session {
  sessionId: string;
  createdAt: number;
  lastActivity: number;
  state: string;
  socket: AsrSocket | null;
  auth: AsrAuthResult;
  provider: AsrProviderAdapter;
  config: MockAsrProviderConfig & { provider?: string; language?: string };
  maxDurationMs: number;
  idleTimeoutMs: number;
  graceMs: number;
  bufferedChunks: number;
  bufferedBytes: number;
  receivedChunks: number;
  receivedBytes: number;
  partialCount: number;
  cancelled: boolean;
  endedReason?: string;
  seenSeqs: Set<number>;
  expectedSeq: number;
  /** Bumped on every accepted resume so timers from the previous connection go inert. */
  epoch: number;
  finalSent: boolean;
  endedSent: boolean;
  timers: { maxDuration?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>; finalize?: ReturnType<typeof setTimeout> };
}

export class AsrGateway {
  private sessions = new Map<string, Session>();
  private socketToSession = new Map<AsrSocket, string>();
  private socketAuth = new Map<AsrSocket, AsrAuthResult>();
  private options: AsrGatewayOptions;
  private now: () => number;

  constructor(options: AsrGatewayOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
  }

  private limits(): Required<AsrGatewayLimits> {
    return {
      maxSessionMs: this.options.limits?.maxSessionMs ?? ASR_MAX_SESSION_MS,
      idleTimeoutMs: this.options.limits?.idleTimeoutMs ?? ASR_IDLE_TIMEOUT_MS,
      graceMs: this.options.limits?.graceMs ?? ASR_GRACE_MS,
      heartbeatMs: this.options.limits?.heartbeatMs ?? ASR_HEARTBEAT_MS,
      backpressureMaxChunks: this.options.limits?.backpressureMaxChunks ?? ASR_BACKPRESSURE_MAX_CHUNKS,
      backpressureMaxBytes: this.options.limits?.backpressureMaxBytes ?? ASR_BACKPRESSURE_MAX_BYTES,
    };
  }

  attach(socket: AsrSocket, auth: AsrAuthResult): boolean {
    if (!auth?.ok) {
      socket.close(auth?.code ?? 4401, auth?.error ?? AsrErrorCode.Unauthorized);
      return false;
    }
    if (!auth.accountId || !auth.deviceId || typeof auth.accountId !== "string" || typeof auth.deviceId !== "string"
        || auth.accountId.trim() === "" || auth.deviceId.trim() === "") {
      socket.close(4401, AsrErrorCode.Unauthorized);
      return false;
    }
    this.socketAuth.set(socket, auth);
    socket.onMessage((raw) => this.handleMessage(socket, raw));
    socket.onClose(() => this.handleClose(socket));
    return true;
  }

  async attachRequest(socket: AsrSocket, request: Request): Promise<boolean> {
    if (!this.options.authenticate) {
      socket.close(4401, AsrErrorCode.Unauthorized);
      return false;
    }
    const auth = await this.options.authenticate(request);
    return this.attach(socket, auth);
  }

  private send(socket: AsrSocket | null, message: unknown): void {
    if (!socket) return;
    try {
      if (socket.isOpen()) {
        const envelope = {
          protocolVersion: ASR_TRANSPORT_VERSION,
          eventId: randomUUID(),
          serverTime: this.now(),
        };
        socket.send({ ...envelope, ...(typeof message === "object" && message !== null ? message : {}) });
      }
    } catch {
      // ignore
    }
  }

  private sessionForSocket(socket: AsrSocket): Session | undefined {
    const id = this.socketToSession.get(socket);
    return id ? this.sessions.get(id) : undefined;
  }

  private createSession(msg: Extract<AsrTransportMessage, { type: "session.start" }>, auth: AsrAuthResult, socket: AsrSocket): Session {
    const L = this.limits();
    const maxDurationMs = Math.min(msg.maxDurationMs ?? L.maxSessionMs, L.maxSessionMs);
    const config: MockAsrProviderConfig & { provider?: string; language?: string } = {
      provider: msg.provider ?? "mock",
      language: msg.language ?? "zh",
      ...(msg.mock ?? {}),
    };
    const provider = this.options.providerFactory ? this.options.providerFactory(config) : new MockAsrProvider(config);
    const sessionId = msg.sessionId;
    const session: Session = {
      sessionId,
      createdAt: this.now(),
      lastActivity: this.now(),
      state: AsrSessionState.Starting,
      socket,
      auth,
      provider,
      config,
      maxDurationMs,
      idleTimeoutMs: L.idleTimeoutMs,
      graceMs: L.graceMs,
      bufferedChunks: 0,
      bufferedBytes: 0,
      receivedChunks: 0,
      receivedBytes: 0,
      partialCount: 0,
      cancelled: false,
      timers: {},
      seenSeqs: new Set(),
      expectedSeq: 0,
    epoch: 0,
      finalSent: false,
      endedSent: false,
    };    this.sessions.set(sessionId, session);
    this.socketToSession.set(socket, sessionId);
    session.state = AsrSessionState.Active;

    provider.onPartial((p) => {
      if (session.state !== AsrSessionState.Active && session.state !== AsrSessionState.Finalizing) return;
      session.partialCount += 1;
      this.send(session.socket, { type: "partial", sessionId, ...p });
    });
    provider.onFinal((p) => {
      if (session.finalSent) return;
      session.finalSent = true;
      this.send(session.socket, { type: "final", sessionId, ...p });
      if (session.endedSent) return;
      session.endedSent = true;
      session.state = AsrSessionState.Ended;
      session.endedReason = session.endedReason ?? "completed";
      this.clearTimers(session, true);
      this.send(session.socket, {
        type: "session.ended",
        sessionId,
        reason: session.endedReason,
        stats: {
          chunks: session.receivedChunks,
          bytes: session.receivedBytes,
          durationMs: this.now() - session.createdAt,
          partialCount: session.partialCount,
        },
      });
      this.startGrace(session);
    });
    provider.onError((e) => {
      this.send(session.socket, { type: "error", sessionId, ...e });
      if (e.fatal) {
        if (session.endedSent) return;
        session.endedSent = true;
        session.state = AsrSessionState.Ended;
        session.endedReason = "error";
        this.clearTimers(session, true);
        this.send(session.socket, { type: "session.ended", sessionId, reason: "error" });
        this.startGrace(session);
      }
    });
    provider.onEnded((e) => {
      if (session.endedSent) return;
      session.endedSent = true;
      session.state = AsrSessionState.Ended;
      session.endedReason = e.reason ?? "completed";
      this.clearTimers(session, true);
      this.send(session.socket, { type: "session.ended", sessionId, reason: session.endedReason });
      this.startGrace(session);
    });

    let startPending = false;
    try {
      const r = provider.start(config);
      if (r && typeof (r as Promise<void>).then === "function") {
        startPending = true;
        (r as Promise<void>).then(() => {
          if (session.endedSent) return;
          session.state = AsrSessionState.Active;
          session.timers.maxDuration = setTimeout(() => this.handleMaxDuration(session), maxDurationMs);
          session.timers.idle = setTimeout(() => this.handleIdle(session), L.idleTimeoutMs);
          this.send(session.socket, {
            type: "session.started",
            sessionId: session.sessionId,
            provider: session.config.provider ?? "mock",
            audio: { format: msg.audio.format },
            maxDurationMs: session.maxDurationMs,
            heartbeatMs: this.limits().heartbeatMs,
            resume: false,
          });
        }).catch(() => {
          if (session.endedSent) return;
          session.state = AsrSessionState.Ended;
          session.endedReason = "provider-start-failed";
          this.clearTimers(session, true);
          this.send(session.socket, { type: "error", code: AsrErrorCode.ProviderUnavailable, message: "provider start failed", fatal: true, sessionId });
          this.send(session.socket, { type: "session.ended", sessionId, reason: "provider-start-failed" });
          this.startGrace(session);
        });
      }
    } catch {
      session.state = AsrSessionState.Ended;
      session.endedReason = "provider-start-failed";
      this.clearTimers(session, true);
      this.send(session.socket, { type: "error", code: AsrErrorCode.ProviderUnavailable, message: "provider start failed", fatal: true, sessionId });
      this.send(session.socket, { type: "session.ended", sessionId, reason: "provider-start-failed" });
      this.startGrace(session);
      return session;
    }

    if (startPending) {
      // Don't send session.started yet; will be sent when Promise resolves
      session.state = AsrSessionState.Starting;
      return session;
    }
    // Sync start succeeded
    session.state = AsrSessionState.Active;
    session.timers.maxDuration = setTimeout(() => this.handleMaxDuration(session), maxDurationMs);
    session.timers.idle = setTimeout(() => this.handleIdle(session), L.idleTimeoutMs);
    return session;
  }

  private clearTimers(session: Session, keepGrace = false): void {
    if (session.timers.maxDuration) clearTimeout(session.timers.maxDuration);
    if (session.timers.idle) clearTimeout(session.timers.idle);
    if (session.timers.finalize) clearTimeout(session.timers.finalize);
    if (!keepGrace && session.timers.grace) clearTimeout(session.timers.grace);
    session.timers.maxDuration = undefined;
    session.timers.idle = undefined;
    session.timers.finalize = undefined;
    if (!keepGrace) session.timers.grace = undefined;
  }

  private startGrace(session: Session): void {
    if (session.timers.grace) clearTimeout(session.timers.grace);
    session.socket = null;
    try { session.provider.close(); } catch { /* ignore */ }
    for (const [sock, sid] of this.socketToSession) {
      if (sid === session.sessionId) this.socketToSession.delete(sock);
    }
    session.timers.grace = setTimeout(() => {
      this.sessions.delete(session.sessionId);
    }, session.graceMs);
  }

  private resetIdle(session: Session): void {
    if (session.timers.idle) clearTimeout(session.timers.idle);
    session.timers.idle = setTimeout(() => this.handleIdle(session), session.idleTimeoutMs);
  }

  private handleMaxDuration(session: Session): void {
    if (session.state !== AsrSessionState.Active && session.state !== AsrSessionState.Finalizing) return;
    session.state = AsrSessionState.Ended;
    session.endedReason = "max-duration";
    this.clearTimers(session, true);
    try { session.provider.cancel(); } catch { /* ignore */ }
    this.send(session.socket, { type: "session.ended", sessionId: session.sessionId, reason: "max-duration" });
    this.startGrace(session);
  }

  private handleIdle(session: Session): void {
    if (session.state !== AsrSessionState.Active) return;
    session.state = AsrSessionState.Ended;
    session.endedReason = "max_idle_timeout";
    this.clearTimers(session, true);
    try { session.provider.cancel(); } catch { /* ignore */ }
    this.send(session.socket, { type: "error", sessionId: session.sessionId, code: AsrErrorCode.MaxIdleTimeout, message: "idle timeout", fatal: true });
    this.send(session.socket, { type: "session.ended", sessionId: session.sessionId, reason: "max_idle_timeout" });
    this.startGrace(session);
  }

  private handleMessage(socket: AsrSocket, raw: string): void {
    const auth = this.socketAuth.get(socket);
    if (!auth?.ok) {
      socket.close(4401, AsrErrorCode.Unauthorized);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "error", code: AsrErrorCode.InvalidFormat, message: "invalid json", fatal: true });
      return;
    }
    const inboundProtocolVersion = (parsed as { protocolVersion?: unknown })?.protocolVersion;
    if (typeof inboundProtocolVersion !== "string" || inboundProtocolVersion !== ASR_TRANSPORT_VERSION) {
      this.send(socket, { type: "error", code: AsrErrorCode.InvalidFormat, message: "missing or unsupported protocol version", fatal: false });
      return;
    }
    const result = AsrTransportMessageSchema.safeParse(parsed);
    if (!result.success) {
      this.send(socket, { type: "error", code: AsrErrorCode.InvalidFormat, message: "invalid message", fatal: false });
      return;
    }
    const msg = result.data as AsrTransportMessage;

    const ownsIdentity = (session: Session) => session.auth.accountId === auth.accountId && session.auth.deviceId === auth.deviceId && session.auth.spaceId === auth.spaceId;
    const isCurrentSocket = (session: Session) => session.socket === socket || this.socketToSession.get(socket) === session.sessionId;
    const withinGrace = (session: Session) => this.now() - session.lastActivity <= session.graceMs;
    const disconnected = (session: Session) => session.socket === null || !session.socket.isOpen();
    const allowRebind = (session: Session) => ownsIdentity(session) && !isCurrentSocket(session) && withinGrace(session) && disconnected(session);
    const bindSocket = (session: Session) => {
      session.socket = socket;
      this.socketToSession.set(socket, session.sessionId);
      if (session.timers.grace) {
        clearTimeout(session.timers.grace);
        session.timers.grace = undefined;
      }
      session.state = AsrSessionState.Active;
      if (typeof session.provider.reset === "function") session.provider.reset();
      this.resetIdle(session);
    };

    switch (msg.type) {
      case "session.start": {
        let resume = false;
        let session: Session | undefined;
        if (msg.resumeSessionId) {
          const existing = this.sessions.get(msg.resumeSessionId);
          if (!existing) {
            this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session not found", sessionId: msg.resumeSessionId, fatal: true });
            return;
          }
          if (!ownsIdentity(existing)) {
            this.send(socket, { type: "error", code: AsrErrorCode.Unauthorized, message: "unauthorized", sessionId: msg.resumeSessionId, fatal: true });
            return;
          }
          // Round 5 fix: reject resume if original connection is still active
          if (existing.socket !== null && existing.socket.isOpen() && existing.socket !== socket) {
            this.send(socket, { type: "error", code: AsrErrorCode.InvalidSession, message: "session already active on another connection", sessionId: msg.resumeSessionId, fatal: true });
            return;
          }
          const age = this.now() - existing.lastActivity;
          if (existing.cancelled || age > existing.graceMs) {
            this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session expired", sessionId: msg.resumeSessionId, fatal: true });
            return;
          }
          session = existing;
          resume = true;
          // The reconnecting client tells us where its numbering resumes. Without this
          // rebase the gateway kept the pre-drop expectedSeq while the client restarted
          // at 0 (or continued elsewhere), so every frame was rejected as out-of-order.
          // Invalidate ack timers left over from the dropped connection: their expiry
          // path rolls expectedSeq back, which would desync the resumed stream.
          session.epoch += 1;
          if (typeof msg.resumeSeq === "number") {
            session.expectedSeq = msg.resumeSeq;
            session.seenSeqs.clear();
          }
          if (session.timers.grace) {
            clearTimeout(session.timers.grace);
            session.timers.grace = undefined;
          }
        }
        if (!session) {
          const existingById = this.sessions.get(msg.sessionId);
          if (existingById) {
            if (!ownsIdentity(existingById)) {
              this.send(socket, { type: "error", code: AsrErrorCode.Unauthorized, message: "unauthorized", sessionId: msg.sessionId, fatal: true });
              return;
            }
            this.clearTimers(existingById, false);
            try { existingById.provider.close(); } catch { /* ignore */ }
            this.sessions.delete(msg.sessionId);
          }
          session = this.createSession(msg, auth, socket);
        if (session.state === AsrSessionState.Ended) {
          // Provider start failed; session.started not sent (error+ended already sent in createSession)
          return;
        }
        } else {
          session.socket = socket;
          this.socketToSession.set(socket, session.sessionId);
          if (session.timers.grace) {
            clearTimeout(session.timers.grace);
            session.timers.grace = undefined;
          }
          session.lastActivity = this.now();
          session.state = AsrSessionState.Active;
          if (typeof session.provider.reset === "function") session.provider.reset();
          this.resetIdle(session);
        }
        // Only send session.started if not in Starting state (async pending sends it via .then())
        if (session.state !== AsrSessionState.Starting) {
          this.send(socket, {
            type: "session.started",
            sessionId: session.sessionId,
            provider: session.config.provider ?? "mock",
            audio: { format: msg.audio.format },
            maxDurationMs: session.maxDurationMs,
            heartbeatMs: this.limits().heartbeatMs,
            resume,
          });
        }
        break;
      }
      case "audio.chunk": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session not found", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (!ownsIdentity(session) || (!isCurrentSocket(session) && !allowRebind(session))) {
          this.send(socket, { type: "error", code: AsrErrorCode.Unauthorized, message: "unauthorized", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (allowRebind(session)) bindSocket(session);
        if (session.state !== AsrSessionState.Active) {
          this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session not found", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (session.seenSeqs.has(msg.seq)) {
          this.send(socket, {
            type: "chunk.ack",
            sessionId: session.sessionId,
            seq: msg.seq,
            bufferedChunks: session.bufferedChunks,
            bufferedBytes: session.bufferedBytes,
          });
          return;
        }
        if (msg.seq !== session.expectedSeq) {
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.InvalidSession,
            message: "out-of-order audio seq",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: false,
            fatal: false,
          });
          return;
        }
        const base64 = msg.audio;
        // Pre-decode length check: 64 KiB decoded = ~87384 base64 chars max
        if (base64.length > 87384) {
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.InputTooLarge,
            message: "audio chunk base64 too large (max 64 KiB decoded)",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: false,
            fatal: false,
          });
          return;
        }
        if (!/^[A-Za-z0-9+\/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) {
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.InvalidFormat,
            message: "invalid base64 audio",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: false,
            fatal: false,
          });
          return;
        }
        const audioBuffer = Buffer.from(base64, "base64");
        if (audioBuffer.length === 0 || audioBuffer.length > 64 * 1024) {
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.InputTooLarge,
            message: "audio chunk too large or empty",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: false,
            fatal: false,
          });
          return;
        }
        this.socketToSession.set(socket, session.sessionId);
        session.lastActivity = this.now();
        this.resetIdle(session);
        const bytes = audioBuffer.length;
        const L = this.limits();
        if (session.bufferedChunks >= L.backpressureMaxChunks || session.bufferedBytes + bytes > L.backpressureMaxBytes) {
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.Backpressure,
            message: "audio buffer full",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: true,
            fatal: false,
          });
          return;
        }
        session.bufferedChunks += 1;
        session.bufferedBytes += bytes;
        session.receivedChunks += 1;
        session.receivedBytes += bytes;
        session.seenSeqs.add(msg.seq);
        session.expectedSeq += 1;
        let consumed = false;
        // Per-chunk ack: single callback registered ONCE, handling both sync and async.
        // Timer is cleared when consumption is signalled; timeout sends error (not false ACK).
        const epoch = session.epoch;
        const timer = setTimeout(() => {
          if (consumed) return;
          consumed = true;
          // The connection that owned this frame is gone; the resumed stream uses a
          // rebased sequence, so rolling back now would desync it permanently.
          if (session.epoch !== epoch) return;
          session.bufferedChunks = Math.max(0, session.bufferedChunks - 1);
          session.bufferedBytes = Math.max(0, session.bufferedBytes - bytes);
          session.seenSeqs.delete(msg.seq);
          session.expectedSeq = Math.max(0, session.expectedSeq - 1);
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.ProviderError,
            message: "provider did not acknowledge audio consumption within timeout",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: true,
            fatal: false,
          });
        }, 500);
        const ack = () => {
          if (consumed) return;
          consumed = true;
          clearTimeout(timer);
          session.bufferedChunks = Math.max(0, session.bufferedChunks - 1);
          session.bufferedBytes = Math.max(0, session.bufferedBytes - bytes);
          this.send(socket, {
            type: "chunk.ack",
            sessionId: session.sessionId,
            seq: msg.seq,
            bufferedChunks: session.bufferedChunks,
            bufferedBytes: session.bufferedBytes,
          });
        };
        let unsub: (() => void) | undefined;
        if (typeof session.provider.onAudioConsumed === "function") {
          unsub = session.provider.onAudioConsumed(() => ack());
        }
        try {
          session.provider.sendAudio(audioBuffer);
        } catch (err) {
          if (unsub) unsub();
          clearTimeout(timer);
          session.bufferedChunks = Math.max(0, session.bufferedChunks - 1);
          session.bufferedBytes = Math.max(0, session.bufferedBytes - bytes);
          session.seenSeqs.delete(msg.seq);
          session.expectedSeq = Math.max(0, session.expectedSeq - 1);
          this.send(socket, {
            type: "error",
            code: AsrErrorCode.Backpressure,
            message: err instanceof Error ? err.message : "backpressure",
            sessionId: session.sessionId,
            seq: msg.seq,
            retryable: true,
            fatal: false,
          });
          return;
        }
        // If consumed during sendAudio (sync), ack already fired and timer cleared by ack()
        if (consumed) {
          if (unsub) unsub();
        }
        // If not consumed yet, timer will handle timeout or async callback will fire ack
        break;
      }
      case "cancel": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session not found", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (!ownsIdentity(session) || (!isCurrentSocket(session) && !allowRebind(session))) {
          this.send(socket, { type: "error", code: AsrErrorCode.Unauthorized, message: "unauthorized", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (allowRebind(session)) bindSocket(session);
        if (session.endedSent) return;
        session.endedSent = true;
        session.state = AsrSessionState.Ended;
        session.cancelled = true;
        session.endedReason = "cancelled";
        this.clearTimers(session, true);
        try { session.provider.cancel(); } catch { /* ignore */ }
        this.send(socket, { type: "session.ended", sessionId: session.sessionId, reason: "cancelled" });
        this.startGrace(session);
        break;
      }
      case "session.end": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          this.send(socket, { type: "error", code: AsrErrorCode.SessionNotFound, message: "session not found", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (!ownsIdentity(session) || (!isCurrentSocket(session) && !allowRebind(session))) {
          this.send(socket, { type: "error", code: AsrErrorCode.Unauthorized, message: "unauthorized", sessionId: msg.sessionId, fatal: true });
          return;
        }
        if (allowRebind(session)) bindSocket(session);
        if (session.endedSent) return;
        session.state = AsrSessionState.Finalizing;
        session.endedReason = msg.reason ?? "completed";
        this.clearTimers(session, true);
        let commitFailed = false;
        try { session.provider.commit(); } catch (commitErr) {
          commitFailed = true;
          session.endedReason = "commit-failed";
          this.send(socket, { type: "error", code: AsrErrorCode.ProviderError, message: commitErr instanceof Error ? commitErr.message : "commit failed", sessionId: session.sessionId, fatal: false });
        }
        session.timers.finalize = setTimeout(() => {
          if (session.endedSent) return;
          session.endedSent = true;
          session.state = AsrSessionState.Ended;
          this.clearTimers(session, true);
          if (commitFailed) {
            this.send(session.socket, { type: "session.ended", sessionId: session.sessionId, reason: "commit-failed" });
          } else {
            this.send(session.socket, { type: "session.ended", sessionId: session.sessionId, reason: session.endedReason ?? "completed" });
          }
          this.startGrace(session);
        }, session.graceMs);
        break;
      }
      case "ping": {
        this.send(socket, { type: "pong" });
        break;
      }
      default: {
        break;
      }
    }
  }

  private handleClose(socket: AsrSocket): void {
    this.socketAuth.delete(socket);
    const sessionId = this.socketToSession.get(socket);
    this.socketToSession.delete(socket);
    if (!sessionId) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    // Round 5 fix: only clean up if this socket is still the bound socket.
    // If a new socket has already rebound, do NOT destroy the session.
    if (session.socket !== null && session.socket !== socket) {
      // Socket already rebound to a new connection; ignore stale close.
      return;
    }
    session.socket = null;
    if (session.endedSent) return;
    this.clearTimers(session, true);
    try { session.provider.close(); } catch { /* ignore */ }
    session.timers.grace = setTimeout(() => {
      this.sessions.delete(session.sessionId);
    }, session.graceMs);
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  sessionCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      this.clearTimers(session, false);
      try { session.provider.close(); } catch { /* ignore */ }
    }
    this.sessions.clear();
    this.socketToSession.clear();
    this.socketAuth.clear();
  }
}

export function createAsrGateway(options: AsrGatewayOptions = {}): AsrGateway {
  return new AsrGateway(options);
}

export type { MockAsrProviderConfig };
