import type { LocalApiConfig } from "../src/config.js";
import type { CanvasContext } from "../src/schemas.js";

export const TEST_TOKEN = "test-token-0123456789";

export const testConfig = (
  overrides: Partial<LocalApiConfig> = {},
): LocalApiConfig => ({
  port: 0,
  host: "127.0.0.1",
  token: TEST_TOKEN,
  tokenPath: "/dev/null",
  tokenGenerated: false,
  allowedOrigins: ["http://localhost:5173"],
  modelApiBaseUrl: "https://unit.test/model",
  stepfunBaseUrl: "https://unit.test/v1",
  // The product default is DeepSeek, but most suites here exercise the StepFun
  // transport explicitly. Pin it so a default change never silently rewrites what
  // these tests are asserting.
  mainProvider: "stepfun",
  requestTimeoutMs: 60,
  bodyLimitBytes: 64 * 1024,
  ...overrides,
});

export const authed = {
  authorization: `Bearer ${TEST_TOKEN}`,
  "content-type": "application/json",
};

export const emptyContext = (cards: CanvasContext["cards"] = []): CanvasContext => ({
  canvasId: "c1",
  stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 },
  focusHistory: [],
  cards,
});

/** Fetch stub: routes by URL suffix. */
export const fetchStub = (
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
  onCall?: (url: string) => void,
): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    onCall?.(url);
    for (const [suffix, handler] of Object.entries(routes)) {
      if (url.endsWith(suffix)) return handler(init);
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;

export const modelsOk = (ids: string[] = ["step-3", "step-1-8k"]) =>
  new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** Tools that change the canvas and therefore owe the user one spoken receipt
 *  (`docs/decisions/2026-11-05-action-requires-model-receipt.md`). */
const RECEIPT_TOOLS: ReadonlySet<string> = new Set(["create_card", "update_card", "delete_card", "arrange", "history"]);

/** A scripted model call: the two reply shapes the test files use (`args` or
 *  `arguments`) are both accepted, so one helper fits every fake transport. */
type ReceiptCall = { name: string; args?: Record<string, unknown>; arguments?: Record<string, unknown> };

/**
 * A model that obeys the action-receipt protocol. A scripted batch that carries
 * a canvas action but no `chat(reply=…)` gets the model's own sentence, so a
 * case written before the protocol keeps testing the behaviour it was written
 * for instead of tripping the host's `missing-say` rejection. `view(fit|restore)`
 * moves only the camera and is not an action here; `unsupported`/`clarify` are
 * already the model speaking.
 */
export const withReceipt = <T extends ReceiptCall>(calls: T[], reply = "好了"): T[] => {
  const payload = (call: T): Record<string, unknown> => call.arguments ?? call.args ?? {};
  const acts = calls.some(call => RECEIPT_TOOLS.has(call.name)
    || (call.name === "view" && (payload(call).mode === "focus" || payload(call).mode === "highlight")));
  const speaks = calls.some(call => call.name === "unsupported" || call.name === "clarify"
    || (call.name === "chat" && typeof payload(call).reply === "string" && String(payload(call).reply).trim() !== ""));
  if (!acts || speaks) return calls;
  const usesArgs = calls.some(call => call.args !== undefined);
  const receipt = { name: "chat", ...(usesArgs ? { args: { reply } } : { arguments: { reply } }) } as unknown as T;
  return [...calls, receipt];
};

export const chatOk = (payload: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(payload) } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
