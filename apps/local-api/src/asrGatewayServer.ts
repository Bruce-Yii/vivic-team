import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig, STEPFUN_API_BASE_URL } from "./config.js";
import type { CredentialStore } from "./credentials.js";
import type { ProviderStore } from "./providers/store.js";
import { resolveSavedAsr } from "./providers/asr.js";
import { createAsrGateway, type AsrSocket } from "./asrGateway.js";
import { MockAsrProvider, type AsrProviderAdapter, type MockAsrProviderConfig } from "./asrMockProvider.js";
import { StepfunAsrProvider, type StepfunAsrBackend } from "./asrStepfunProvider.js";
import { ASR_MODEL } from "./asr.js";
import { AsrErrorCode } from "@vivic/contracts";

class WsAsrSocket implements AsrSocket {
  private readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  send(message: unknown): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }
  close(code?: number, reason?: string): void {
    this.ws.close(code, reason);
  }
  onMessage(handler: (data: string) => void): void {
    this.ws.on("message", (data) => {
      handler(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8"));
    });
  }
  onClose(handler: (code?: number, reason?: string) => void): void {
    this.ws.on("close", (code, reason) => handler(code, reason.toString()));
  }
  isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }
}

const safeTokenOk = (presented: string, expected: string): boolean => {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const createUnsupportedAsrProvider = (reason: string): AsrProviderAdapter => ({
  start() {
    throw new Error(reason);
  },
  sendAudio() {},
  reset() {},
  onAudioConsumed() {
    return () => {};
  },
  commit() {},
  cancel() {},
  close() {},
  onPartial() {},
  onFinal() {},
  onError() {},
  onEnded() {},
});

export interface AsrGatewayServerOptions {
  config?: ReturnType<typeof loadConfig>;
  credentials?: CredentialStore;
  providerStore?: ProviderStore;
  fetchImpl?: typeof fetch;
  path?: string;
  port?: number;
  host?: string;
}

export function createAsrGatewayServer(options: AsrGatewayServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const gatewayPath = options.path ?? "/asr";

  const resolveStepfunBackend = (): StepfunAsrBackend | { error: string } | undefined => resolveStepfunAsrBackend({
    providerStore: options.providerStore, credentials: options.credentials, config,
    env: process.env,
  });

;

  const providerFactory = (sessionConfig: MockAsrProviderConfig): AsrProviderAdapter => {
    const requested = sessionConfig.provider ?? "mock";
    if (requested === "mock") {
      return new MockAsrProvider(sessionConfig);
    }
    if (requested === "stepfun") {
      return new StepfunAsrProvider({
        resolveBackend: resolveStepfunBackend,
        fetchImpl: options.fetchImpl,
      });
    }
    return createUnsupportedAsrProvider(`ASR provider "${requested}" 暂未接入流式网关，请选择 StepFun。`);
  };

  const gateway = createAsrGateway({
    providerFactory,
    authenticate: async (request) => {
      const origin = request.headers.get("origin");
      if (origin && !config.allowedOrigins.includes(origin)) {
        return { ok: false, code: 4403, error: AsrErrorCode.Origin };
      }
      const header = request.headers.get("authorization") ?? "";
      const presented = header.startsWith("Bearer ")
        ? header.slice(7)
        : (new URL(request.url).searchParams.get("token") ?? "");
      if (!presented || !safeTokenOk(presented, config.token)) {
        return { ok: false, code: 4401, error: AsrErrorCode.Unauthorized };
      }
      const accountId = "acct-" + crypto.createHash("sha256").update(presented).digest("hex").slice(0, 16);
      const deviceId = request.headers.get("x-device-id") ?? "web-client";
      const spaceId = request.headers.get("x-space-id") ?? "default-space";
      return { ok: true, accountId, deviceId, spaceId };
    },
  });

  const wss = new WebSocketServer({ noServer: true });
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").split("?")[0] === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "vivic-asr-gateway" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== gatewayPath) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (origin && !config.allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const header = req.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ")
      ? header.slice(7)
      : (url.searchParams.get("token") ?? "");
    if (!presented || !safeTokenOk(presented, config.token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const adapter = new WsAsrSocket(ws);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value) && value[0]) headers.set(key, value[0]);
      }
      const request = new Request(url.toString(), { headers });
      void gateway.attachRequest(adapter, request).then((ok) => {
        if (!ok && ws.readyState === WebSocket.OPEN) ws.close(4401, AsrErrorCode.Unauthorized);
      });
      wss.emit("connection", ws, req);
    });
  });

  return { server, gateway, wss, config };
}

export function startAsrGatewayServer(options: AsrGatewayServerOptions = {}) {
  const { server, config } = createAsrGatewayServer(options);
  const host = options.host ?? config.host;
  const port = options.port ?? Number(process.env.VIVIC_ASR_GATEWAY_PORT ?? 8799);
  server.listen(port, host, () => {
    console.log(`[vivic-asr-gateway] listening on ws://${host}:${port}/asr`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
  return server;
}

const entry = process.argv[1];
const selfPath = fileURLToPath(import.meta.url);
const samePath = (a: string, b: string) =>
  process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
if (entry !== undefined && samePath(path.resolve(entry), selfPath)) {
  startAsrGatewayServer();
}

export interface StepfunAsrBackendInputs {
  providerStore?: ProviderStore;
  credentials?: CredentialStore;
  config: ReturnType<typeof loadConfig>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the StepFun speech backend. Speech always uses the official API base
 * (`/v1/audio/asr/sse`); the Coding-Plan base (`/step_plan/v1`) serves chat only
 * and answers 404 for transcription, so it must never leak in here.
 */
export function resolveStepfunAsrBackend(
  inputs: StepfunAsrBackendInputs,
): StepfunAsrBackend | { error: string } | undefined {
  const { providerStore, credentials, config } = inputs;
  const env = inputs.env ?? process.env;
  if (providerStore) {
    const selected = resolveSavedAsr(providerStore);
    if (selected && "error" in selected) return { error: selected.error ?? "语音识别连接不可用。" };
    if (selected) {
      return { baseUrl: selected.baseUrl, model: selected.model, headers: selected.headers, protocol: selected.protocol };
    }
  }
  const asrBaseUrl = config.stepfunAsrBaseUrl ?? STEPFUN_API_BASE_URL;
  const secret = credentials?.getSecret();
  if (secret) {
    return { baseUrl: asrBaseUrl, model: ASR_MODEL, headers: { authorization: `Bearer ${secret.apiKey}` }, protocol: "sse" };
  }
  const envKey = env.VIVIC_STEPFUN_API_KEY?.trim();
  if (envKey) {
    return { baseUrl: asrBaseUrl, model: ASR_MODEL, headers: { authorization: `Bearer ${envKey}` }, protocol: "sse" };
  }
  return undefined;
}
