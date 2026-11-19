import { z } from "zod";

export const ASR_TRANSPORT_VERSION = "vivic-asr-protocol@1" as const;

export const AsrAudioFormatSchema = z.strictObject({
  type: z.literal("pcm"),
  codec: z.literal("pcm_s16le"),
  rate: z.literal(16000),
  bits: z.literal(16),
  channel: z.literal(1),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrAudioFormat = z.infer<typeof AsrAudioFormatSchema>;

export const AsrUsageSchema = z.strictObject({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  audioSeconds: z.number().min(0).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrUsage = z.infer<typeof AsrUsageSchema>;

export const AsrWordSchema = z.strictObject({
  word: z.string().min(1).max(64),
  start: z.number().min(0),
  end: z.number().min(0),
  final: z.boolean().optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrWord = z.infer<typeof AsrWordSchema>;

export const AsrSessionStartSchema = z.strictObject({
  type: z.literal("session.start"),
  sessionId: z.string().uuid(),
  audio: z.strictObject({ format: AsrAudioFormatSchema }),
  provider: z.string().min(1).max(64).optional(),
  language: z.string().min(1).max(16).optional(),
  hotwords: z.array(z.string().min(1).max(64)).max(64).optional(),
  vad: z.enum(["server", "client", "none"]).optional(),
  maxDurationMs: z.number().int().min(1000).max(90000).optional(),
  resumeSessionId: z.string().uuid().optional(),
  /**
   * Next audio sequence number this connection will send after a resume.
   * The gateway rebases `expectedSeq` to it so a reconnecting client never has to
   * replay frames the old socket already delivered.
   */
  resumeSeq: z.number().int().min(0).optional(),
  mock: z.record(z.string(), z.unknown()).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrSessionStartMessage = z.infer<typeof AsrSessionStartSchema>;

export const AsrSessionStartedSchema = z.strictObject({
  type: z.literal("session.started"),
  sessionId: z.string().uuid(),
  provider: z.string().min(1).max(64),
  audio: z.strictObject({ format: AsrAudioFormatSchema }),
  maxDurationMs: z.number().int().min(1000).max(90000),
  heartbeatMs: z.number().int().min(1000).max(60000),
  resume: z.boolean().optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrSessionStartedMessage = z.infer<typeof AsrSessionStartedSchema>;

export const AsrAudioChunkSchema = z.strictObject({
  type: z.literal("audio.chunk"),
  sessionId: z.string().uuid(),
  seq: z.number().int().min(0),
  audio: z.string().min(1),
  ts: z.number().int().min(0).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrAudioChunkMessage = z.infer<typeof AsrAudioChunkSchema>;

export const AsrChunkAckSchema = z.strictObject({
  type: z.literal("chunk.ack"),
  sessionId: z.string().uuid(),
  seq: z.number().int().min(0),
  bufferedChunks: z.number().int().min(0),
  bufferedBytes: z.number().int().min(0),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrChunkAckMessage = z.infer<typeof AsrChunkAckSchema>;

export const AsrPartialSchema = z.strictObject({
  type: z.literal("partial"),
  sessionId: z.string().uuid(),
  text: z.string(),
  seq: z.number().int().min(0).optional(),
  stash: z.string().optional(),
  words: z.array(AsrWordSchema).optional(),
  segmentId: z.string().min(1).max(128).optional(),
  isFinalSegment: z.boolean().optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrPartialMessage = z.infer<typeof AsrPartialSchema>;

export const AsrFinalSchema = z.strictObject({
  type: z.literal("final"),
  sessionId: z.string().uuid(),
  text: z.string().min(1),
  segmentId: z.string().min(1).max(128).optional(),
  words: z.array(AsrWordSchema).optional(),
  usage: AsrUsageSchema.optional(),
  durationMs: z.number().int().min(0).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrFinalMessage = z.infer<typeof AsrFinalSchema>;

export const AsrCancelSchema = z.strictObject({
  type: z.literal("cancel"),
  sessionId: z.string().uuid(),
  reason: z.string().max(256).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrCancelMessage = z.infer<typeof AsrCancelSchema>;

export const AsrSessionEndClientSchema = z.strictObject({
  type: z.literal("session.end"),
  sessionId: z.string().uuid(),
  reason: z.string().max(256).optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrSessionEndClientMessage = z.infer<typeof AsrSessionEndClientSchema>;

export const AsrSessionEndedSchema = z.strictObject({
  type: z.literal("session.ended"),
  sessionId: z.string().uuid(),
  reason: z.string().min(1).max(64),
  stats: z
    .strictObject({
      chunks: z.number().int().min(0),
      bytes: z.number().int().min(0),
      durationMs: z.number().int().min(0),
      partialCount: z.number().int().min(0),
      protocolVersion: z.string().optional(),
      eventId: z.string().uuid().optional(),
      serverTime: z.number().int().min(0).optional(),
    })
    .optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrSessionEndedMessage = z.infer<typeof AsrSessionEndedSchema>;

export const AsrErrorSchema = z.strictObject({
  type: z.literal("error"),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(512),
  sessionId: z.string().uuid().optional(),
  seq: z.number().int().min(0).optional(),
  retryable: z.boolean().optional(),
  fatal: z.boolean().optional(),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrErrorMessage = z.infer<typeof AsrErrorSchema>;

export const AsrHeartbeatSchema = z.strictObject({
  type: z.literal("heartbeat"),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrHeartbeatMessage = z.infer<typeof AsrHeartbeatSchema>;

export const AsrPingSchema = z.strictObject({
  type: z.literal("ping"),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrPingMessage = z.infer<typeof AsrPingSchema>;

export const AsrPongSchema = z.strictObject({
  type: z.literal("pong"),
  protocolVersion: z.string().optional(),
  eventId: z.string().uuid().optional(),
  serverTime: z.number().int().min(0).optional(),
});
export type AsrPongMessage = z.infer<typeof AsrPongSchema>;

export const AsrTransportMessageSchema = z.discriminatedUnion("type", [
  AsrSessionStartSchema,
  AsrSessionStartedSchema,
  AsrAudioChunkSchema,
  AsrChunkAckSchema,
  AsrPartialSchema,
  AsrFinalSchema,
  AsrCancelSchema,
  AsrSessionEndClientSchema,
  AsrSessionEndedSchema,
  AsrErrorSchema,
  AsrHeartbeatSchema,
  AsrPingSchema,
  AsrPongSchema,
]);

export type AsrTransportMessage = z.infer<typeof AsrTransportMessageSchema>;

export const AsrErrorCode = {
  Unauthorized: "asr-unauthorized",
  Origin: "asr-origin",
  InvalidFormat: "asr-invalid-format",
  InputTooLarge: "asr-input-too-large",
  EmptyAudio: "asr-empty-audio",
  Backpressure: "asr-backpressure",
  ProviderUnavailable: "asr-provider-unavailable",
  ProviderError: "asr-provider-error",
  Timeout: "asr-timeout",
  Cancelled: "asr-cancelled",
  MaxIdleTimeout: "max_idle_timeout",
  PongTimeout: "pong_timeout",
  SessionNotFound: "session-not-found",
  InvalidSession: "asr-invalid-session",
} as const;
export type AsrErrorCode = (typeof AsrErrorCode)[keyof typeof AsrErrorCode];

export const AsrSessionState = {
  Idle: "idle",
  Starting: "starting",
  Active: "active",
  Cancelling: "cancelling",
  Finalizing: "finalizing",
  Ended: "ended",
} as const;
export type AsrSessionState = (typeof AsrSessionState)[keyof typeof AsrSessionState];

export const ASR_BACKPRESSURE_MAX_CHUNKS = 32 as const;
export const ASR_BACKPRESSURE_MAX_BYTES = 256 * 1024;
export const ASR_MAX_UTTERANCE_MS = 60_000 as const;
export const ASR_MAX_SESSION_MS = 90_000 as const;
export const ASR_IDLE_TIMEOUT_MS = 15_000 as const;
export const ASR_GRACE_MS = 30_000 as const;
export const ASR_HEARTBEAT_MS = 25_000 as const;
export const ASR_PING_INTERVAL_MS = 20_000 as const;
export const ASR_PONG_TIMEOUT_MS = 10_000 as const;
export const ASR_CHUNK_MIN_MS = 20 as const;
export const ASR_CHUNK_MAX_MS = 200 as const;
export const ASR_CHUNK_RECOMMENDED_MS = 100 as const;
export const ASR_MAX_CHUNK_BYTES_RECOMMENDED = 3200 as const;
export const ASR_CLIENT_WINDOW_CHUNKS = 8 as const;