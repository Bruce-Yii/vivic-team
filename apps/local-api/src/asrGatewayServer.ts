import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "./config.js";
import { createAsrGateway, type AsrSocket } from "./asrGateway.js";
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

export interface AsrGatewayServerOptions {
  config?: ReturnType<typeof loadConfig>;
  path?: string;
  port?: number;
  host?: string;
}

export function createAsrGatewayServer(options: AsrGatewayServerOptions = {}) {
  const config = options.config ?? loadConfig();
  const gatewayPath = options.path ?? "/asr";
  const gateway = createAsrGateway({
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