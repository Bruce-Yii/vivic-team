import { describe, expect, it } from "vitest";

import { formatTokenSummary, summarizeTokenLog } from "../src/observability/tokenSummary.js";

/**
 * The summary is what an operator reads after a day of telemetry: totals by
 * path/model, cache hit rate, per-request mean and the p50/p95 prompt size.
 * Lines without `tokens` and malformed lines must be counted, not crash.
 */

const line = (value: unknown): string => JSON.stringify(value);

const sample = [
  line({ requestId: "r1", path: "tool", kind: "envelope", tokens: { input: 1000, output: 50, cacheHit: 800, cacheMiss: 200, model: "deepseek-flash", turns: 1 } }),
  line({ requestId: "r2", path: "tool", kind: "envelope", tokens: { input: 3000, output: 70, cacheHit: 2400, cacheMiss: 600, model: "deepseek-flash", turns: 2 } }),
  line({ requestId: "r3", path: "planner", kind: "clarify", tokens: { input: 2000, output: 100, cacheHit: 1400, cacheMiss: 600, model: "deepseek-flash", turns: 1 } }),
  line({ requestId: "r4", path: "tool", kind: "envelope", tokens: { input: 500, output: 20, cacheHit: 0, cacheMiss: 500, model: "gpt-5", turns: 1 } }),
  line({ requestId: "r5", path: "rules-fast", kind: "host-operation" }),
  "{not json",
  "",
];

describe("token summary", () => {
  it("aggregates totals, hit rate and percentiles per path/model", () => {
    const summary = summarizeTokenLog(sample);
    expect(summary.requests).toBe(5);
    expect(summary.withTokens).toBe(4);
    expect(summary.malformed).toBe(1);
    expect(summary.buckets).toHaveLength(3);

    const tool = summary.buckets.find(bucket => bucket.path === "tool" && bucket.model === "deepseek-flash")!;
    expect(tool).toMatchObject({ requests: 2, input: 4000, output: 120, cacheHit: 3200,
      cacheMiss: 800, turns: 3, meanInput: 2000, p50Input: 1000, p95Input: 3000 });
    expect(tool.cacheHitRate).toBeCloseTo(0.8, 6);

    const planner = summary.buckets.find(bucket => bucket.path === "planner")!;
    expect(planner).toMatchObject({ requests: 1, input: 2000, cacheHitRate: 0.7, meanInput: 2000, p50Input: 2000, p95Input: 2000 });

    const gpt = summary.buckets.find(bucket => bucket.model === "gpt-5")!;
    expect(gpt).toMatchObject({ path: "tool", requests: 1, input: 500, cacheHitRate: 0 });
    // Sorted by input descending, so the heaviest route reads first.
    expect(summary.buckets.map(bucket => bucket.path)).toEqual(["tool", "planner", "tool"]);
  });

  it("returns an empty summary for an empty day instead of throwing", () => {
    expect(summarizeTokenLog([])).toEqual({ requests: 0, withTokens: 0, malformed: 0, buckets: [] });
    expect(summarizeTokenLog(["", "  "])).toEqual({ requests: 0, withTokens: 0, malformed: 0, buckets: [] });
  });

  it("formats a readable table that starts with the request counts", () => {
    const text = formatTokenSummary(summarizeTokenLog(sample), "intent-2026-11-04.jsonl");
    expect(text).toContain("token summary · intent-2026-11-04.jsonl");
    expect(text).toContain("requests=5 withTokens=4 malformed=1");
    expect(text).toContain("deepseek-flash");
    expect(text).toContain("80.0%");
  });
});
