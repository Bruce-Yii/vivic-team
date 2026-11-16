import { createApp, type AppDeps } from "../app.js";
import {
  STEPFUN_PLAN_BASE_URL, INFERENCE_TIMEOUT_MS, CONNECTION_TIMEOUT_MS, SPEECH_TIMEOUT_MS, streamFeedbackEnabled,
  providerDataDirFromEnv, providerPersistEnabled,
} from "../config.js";
import type { LocalApiConfig } from "../config.js";

/**
 * Each cookie session owns its in-memory credentials; no loadConfig,
 * preferences, local OAuth or runtime. Provider settings are the one explicit
 * exception: when the deployment supplies a data directory they persist there
 * so a saved/seed provider survives session turnover.
 */
export function createOnlineSessionApp(
  session: { token: string; origin: string },
  overrides: {
    fetchImpl?: typeof fetch; onDecisionTrace?: AppDeps["onDecisionTrace"];
    onDecisionReceipt?: AppDeps["onDecisionReceipt"]; getEnabledDefinitions?: AppDeps["getEnabledDefinitions"];
    /** Deployment data dir; the hosted service passes its own persistent root. */
    providerDataDir?: string;
    providerPersist?: boolean;
    providerSeed?: boolean;
  } = {},
) {
  const config: LocalApiConfig = {
    host: "127.0.0.1", port: 0, token: session.token,
    tokenPath: "", tokenGenerated: false, allowedOrigins: [session.origin],
    stepfunBaseUrl: STEPFUN_PLAN_BASE_URL,
    modelApiBaseUrl: (process.env.VIVIC_MODEL_API_BASE_URL ?? "https://edsionc.top/api/v1").replace(/\/+$/, ""),
    requestTimeoutMs: INFERENCE_TIMEOUT_MS, connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
    speechTimeoutMs: SPEECH_TIMEOUT_MS, asrTimeoutMs: 30_000,
    bodyLimitBytes: 64 * 1024, searchEnabled: true, publicDnsFallback: false,
    // Deployment switch: unset keeps today's SSE first sentence; `off` rolls it back.
    streamFeedback: streamFeedbackEnabled(process.env.VIVIC_STREAM_FEEDBACK),
    // Same env contract as loadConfig; an online app never reads a config file.
    trustProxyIp: process.env.VIVIC_TRUST_PROXY_IP !== "off",
    // Tool-layer switches, same env contract as loadConfig: the online session app
    // never reads a config file, so both must be plumbed here to be activatable.
    toolCalls: process.env.VIVIC_TOOL_CALLS === "on",
    toolRepair: process.env.VIVIC_TOOL_REPAIR !== "off",
    legacyFallback: process.env.VIVIC_LEGACY_FALLBACK === "on",
    sections: process.env.VIVIC_SECTIONS === "on",
    managedDecisionEnabled: false, decisionProviderEnabled: false,
  };
  const lifetime = new AbortController();
  // Persist provider settings only when the deployment has a durable data
  // directory. Without one, an online app stays memory-only so a test or a
  // stray caller can never read/write the operator's ~/.vivic. The hosted
  // service always passes its VIVIC_SPACE_DATA_DIR root.
  const providerDataDir = overrides.providerDataDir ?? providerDataDirFromEnv();
  const app = createApp({ config, mode: "online", fetchImpl: overrides.fetchImpl, providerSeed: overrides.providerSeed,
    onDecisionTrace: overrides.onDecisionTrace, onDecisionReceipt: overrides.onDecisionReceipt, getEnabledDefinitions: overrides.getEnabledDefinitions,
    ...(providerDataDir ? {
      providerDataDir,
      providerPersist: overrides.providerPersist ?? providerPersistEnabled(process.env.VIVIC_PROVIDER_PERSIST),
    } : {}) });
  return {
    fetch(request: Request) {
      if (lifetime.signal.aborted) return Response.json({ ok: false, error: "会话已结束。" }, { status: 410 });
      return app.fetch(new Request(request, { signal: AbortSignal.any([request.signal, lifetime.signal]) }));
    },
    dispose() { lifetime.abort(); app.dispose(); },
  };
}
