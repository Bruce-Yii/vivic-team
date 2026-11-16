import { isIP } from "node:net";

/**
 * Client-IP boundary.
 *
 * The online deployment only listens on loopback and nginx runs on the same
 * host, so the socket peer is the only trustworthy source: forwarded headers
 * are believed only when that peer is a loopback address. A request that opens
 * the port from anywhere else cannot choose its own location by sending
 * `X-Real-IP`. The address is used for one in-memory city lookup and is never
 * logged, persisted or echoed back.
 */

/**
 * Internal bridge header. The online edge sets it after the socket-peer check,
 * and only the session bridge forwards it to the app; a browser header never
 * reaches this app with that name.
 */
export const CLIENT_IP_HEADER = "x-vivic-client-ip";

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | undefined =>
  typeof value === "object" && value !== null ? value as UnknownRecord : undefined;

/** `[::1]` and `fe80::1%eth0` are still the same address for our purpose. */
const unwrap = (value: string): string => {
  const bracketed = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  return bracketed.split("%")[0]!;
};

/**
 * A bare IPv4/IPv6 literal, or undefined. IPv4-mapped IPv6 (as Node reports a
 * dual-stack socket peer) is normalized to plain IPv4 so the cache and the
 * provider path have one key per address.
 */
export function normalizeClientIp(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw || raw.length > 64) return undefined;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
  const candidate = mapped ? mapped[1]! : unwrap(raw);
  return isIP(candidate) ? candidate : undefined;
}

/** nginx and this process on the same host, or the local dev proxy. */
export const isLoopbackAddress = (address: string | undefined): boolean => {
  const ip = normalizeClientIp(address);
  return ip !== undefined && (ip === "::1" || ip === "0:0:0:0:0:0:0:1" || ip.startsWith("127."));
};

/** `X-Real-IP` wins; otherwise the first hop of `X-Forwarded-For`. */
export function forwardedClientIp(headers: Headers): string | undefined {
  const real = normalizeClientIp(headers.get("x-real-ip") ?? undefined);
  if (real) return real;
  return normalizeClientIp(headers.get("x-forwarded-for")?.split(",")[0]);
}

/**
 * The peer address Node exposes through @hono/node-server: `{ incoming }`, or
 * `{ server: { incoming } }` when an adapter nests it. Tests may pass the same
 * shape as Hono's third `env` argument.
 */
export function peerAddress(env: unknown): string | undefined {
  const root = asRecord(env);
  if (!root) return undefined;
  const bindings = asRecord(root.server) ?? root;
  const socket = asRecord(asRecord(bindings.incoming)?.socket);
  return typeof socket?.remoteAddress === "string" ? socket.remoteAddress : undefined;
}

/**
 * `trustProxy` is `VIVIC_TRUST_PROXY_IP` (default on). `internal` accepts the
 * edge bridge header in an online session app, which is never exposed directly.
 */
export function clientIpFrom(headers: Headers, options: {
  peer?: string; trustProxy: boolean; internal?: boolean;
}): string | undefined {
  if (!options.trustProxy) return undefined;
  if (isLoopbackAddress(options.peer)) return forwardedClientIp(headers);
  return options.internal ? normalizeClientIp(headers.get(CLIENT_IP_HEADER) ?? undefined) : undefined;
}
