import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

/**
 * The wiring test: `app.ts` must emit exactly one JSON line per `/api/intent`
 * request on stderr, so `docker logs` can answer "where did this request go".
 */

const app = (fetchImpl: typeof fetch = async () => new Response("no upstream", { status: 500 })) =>
  createApp({ config: testConfig(), fetchImpl });

const intent = (target: ReturnType<typeof app>, body: unknown) => target.request("/api/intent", {
  method: "POST", headers: authed, body: typeof body === "string" ? body : JSON.stringify(body),
});

const captureStderr = (): string[] => {
  const lines: string[] = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return lines;
};

afterEach(() => vi.restoreAllMocks());

describe("/api/intent stderr telemetry", () => {
  it("writes one parseable line for a rules-fast request and never the sentence", async () => {
    const lines = captureStderr();
    const target = app();
    try {
      const response = await intent(target, { text: "显示全部", canvasContext: emptyContext() });
      expect(response.status).toBe(200);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!.trim()) as Record<string, unknown>;
      expect(parsed).toMatchObject({ path: "rules-fast", kind: "envelope", tools: [], cards: [] });
      expect(typeof parsed.requestId).toBe("string");
      expect(parsed.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(lines[0]).not.toContain("显示全部");
    } finally { target.dispose(); }
  });

  it("writes one error line for a malformed body", async () => {
    const lines = captureStderr();
    const target = app();
    try {
      const response = await intent(target, "not json");
      expect(response.status).toBe(400);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!.trim())).toMatchObject({ path: "error", kind: "error", error: "请求体不是合法 JSON" });
    } finally { target.dispose(); }
  });

  it("writes one error line for a schema rejection", async () => {
    const lines = captureStderr();
    const target = app();
    try {
      const response = await intent(target, { text: "", canvasContext: emptyContext() });
      expect(response.status).toBe(400);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!.trim())).toMatchObject({ path: "error", kind: "error" });
    } finally { target.dispose(); }
  });
});
