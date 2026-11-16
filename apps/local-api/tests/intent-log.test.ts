import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { cardTypesOf, createIntentLogSink, createIntentLogWriter, intentLogLine, intentPathOf, logIntent } from "../src/observability/intentLog.js";
import type { IntentResult } from "../src/intent/pipeline.js";

/**
 * One stderr line per `/api/intent`: where the turn went, which tools ran, which
 * cards it committed, how long it took and whether it failed. The line must be
 * valid JSON, bounded, and must never contain the user's sentence.
 */

const envelope = (types: string[]): NonNullable<IntentResult["envelope"]> => ({
  schemaVersion: "0.6",
  requestId: "env_1",
  canvasId: "c1",
  actions: types.map(type => ({ type: "card.create", card: { type } })),
}) as unknown as NonNullable<IntentResult["envelope"]>;

const result = (kind: IntentResult["kind"], extra: Partial<IntentResult> = {}): IntentResult => ({ kind, ...extra });

describe("intent path", () => {
  it("derives the path from the result and the pipeline's legacy marker", () => {
    expect(intentPathOf(result("envelope", { usedProvider: "rules" }), createIntentLogSink())).toBe("rules-fast");
    expect(intentPathOf(result("host-operation", { usedProvider: "rules" }), createIntentLogSink())).toBe("rules-fast");
    expect(intentPathOf(result("envelope", { usedProvider: "deepseek", toolCalls: true }), createIntentLogSink())).toBe("tool");
    expect(intentPathOf(result("envelope", { usedProvider: "deepseek" }), createIntentLogSink())).toBe("planner");
    expect(intentPathOf(result("envelope", { usedProvider: "stepfun" }), createIntentLogSink())).toBe("planner");
    expect(intentPathOf(result("clarify", { usedProvider: "gpt" }), createIntentLogSink())).toBe("planner");
    expect(intentPathOf(result("error", { usedProvider: "deepseek" }), createIntentLogSink())).toBe("error");
    const legacy = createIntentLogSink();
    legacy.path = "legacy";
    expect(intentPathOf(result("envelope", { usedProvider: "deepseek" }), legacy)).toBe("legacy");
    const repaired = createIntentLogSink();
    repaired.path = "tool-repair";
    repaired.repairs = 1;
    expect(intentPathOf(result("envelope", { usedProvider: "deepseek", toolCalls: true }), repaired)).toBe("tool-repair");
  });

  it("lists the card types an envelope commits, deduped and ordered", () => {
    expect(cardTypesOf(result("envelope", { envelope: envelope(["NoteCard", "TodoCard", "NoteCard"]) }))).toEqual(["NoteCard", "TodoCard"]);
    expect(cardTypesOf(result("host-operation", { usedProvider: "rules" }))).toEqual([]);
  });
});

describe("one JSON line per request", () => {
  it("writes exactly one parseable line with the documented fields", () => {
    const lines: string[] = [];
    const sink = createIntentLogSink();
    sink.tools = ["create_card"];
    const startedAt = performance.now() - 12;
    logIntent(result("envelope", { usedProvider: "deepseek", toolCalls: true, envelope: envelope(["NoteCard"]) }),
      sink, "req_123", startedAt, line => lines.push(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith("\n")).toBe(false);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({ requestId: "req_123", path: "tool", tools: ["create_card"],
      cards: ["NoteCard"], kind: "envelope", provider: "deepseek" });
    expect(parsed.elapsedMs).toBeGreaterThanOrEqual(12);
    expect(parsed).not.toHaveProperty("error");
    // Nothing about the user's sentence or card content is on the line.
    expect(lines[0]).not.toContain("会议纪要");
  });

  it("records a truncated tool failure and the legacy fallback", () => {
    const sink = createIntentLogSink();
    sink.tools = ["create_card", "create_card", "chat"];
    sink.path = "legacy";
    sink.error = `tool transport: ${"x".repeat(500)}`;
    const line = intentLogLine(result("envelope", { usedProvider: "deepseek" }), sink, "req_9", performance.now());
    expect(line.path).toBe("legacy");
    expect(line.tools).toEqual(["create_card", "chat"]);
    expect(line.error!.length).toBeLessThanOrEqual(200);
    expect(line.error!.endsWith("…")).toBe(true);
  });

  it("records a tool-repair path with its retry count and outcome", () => {
    const sink = createIntentLogSink();
    sink.path = "tool-repair";
    sink.repairs = 1;
    const fixed = intentLogLine(result("envelope", { usedProvider: "deepseek", toolCalls: true }), sink, "req_repair", performance.now());
    expect(fixed.path).toBe("tool-repair");
    expect(fixed.repairs).toBe(1);
    expect(fixed.repair).toBe("fixed");
    const still = intentLogLine(result("clarify"), sink, "req_repair2", performance.now());
    expect(still.repair).toBe("still-invalid");
  });

  it("records which fact a clarification asked about", () => {
    const sink = createIntentLogSink();
    sink.clarifyMissing = "date";
    const line = intentLogLine(result("clarify"), sink, "req_clarify", performance.now());
    expect(line.clarify).toEqual({ missing: "date" });
  });

  it("marks a turn that had no model receipt for its action (sayFallback)", () => {
    const silent = createIntentLogSink();
    silent.path = "tool-repair";
    silent.repairs = 1;
    silent.sayFallback = true;
    const line = intentLogLine(result("envelope", { usedProvider: "deepseek", toolCalls: true }), silent, "req_say", performance.now());
    expect(line.sayFallback).toBe(true);
    // Absent, not `false`, on a normal turn: a compliant model and a silent one
    // must be distinguishable in the log.
    expect(intentLogLine(result("envelope", { usedProvider: "deepseek", toolCalls: true }),
      createIntentLogSink(), "req_ok", performance.now())).not.toHaveProperty("sayFallback");
  });

  it("keeps the error result's own message, whitespace collapsed", () => {
    const line = intentLogLine(result("error", { message: "规划请求超时，\n未执行任何动作。" }), createIntentLogSink(), "req_10", performance.now());
    expect(line.kind).toBe("error");
    expect(line.path).toBe("error");
    expect(line.error).toBe("规划请求超时， 未执行任何动作。");
  });

  it("never throws into the request path when the writer fails", () => {
    expect(() => logIntent(result("clarify"), createIntentLogSink(), "req_11", performance.now(),
      () => { throw new Error("stderr closed"); })).not.toThrow();
  });

  it("appends one JSONL line per request to the durable telemetry file", () => {
    const dir = mkdtempSync(join(tmpdir(), "vivic-telemetry-"));
    try {
      const now = () => new Date("2026-11-03T12:00:00Z");
      const write = createIntentLogWriter(dir, now);
      write(JSON.stringify(intentLogLine(result("envelope", { usedProvider: "rules" }), createIntentLogSink(), "req_a", performance.now())));
      write(JSON.stringify(intentLogLine(result("clarify"), createIntentLogSink(), "req_b", performance.now())));
      const lines = readFileSync(join(dir, "intent-2026-11-03.jsonl"), "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]!).path).toBe("rules-fast");
      expect(JSON.parse(lines[1]!).kind).toBe("clarify");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
