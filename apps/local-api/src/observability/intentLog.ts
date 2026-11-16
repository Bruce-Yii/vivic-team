import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { IntentResult } from "../intent/pipeline.js";
import { createTokenUsageMeter, type TokenUsage, type TokenUsageMeter } from "./tokenUsage.js";

/**
 * One structured line per `/api/intent` request on stderr (docker logs reads
 * it). The line answers "where did this request go, which tool ran, did it
 * fail" without logging the user's sentence, card content, credentials or raw
 * provider payloads.
 *
 * `path`:
 *  - `rules-fast` — a deterministic rule/fast path answered (no model turn);
 *  - `tool`       — the conversational tool layer produced the committed result;
 *  - `tool-repair`— the tool layer's first call failed host validation and the
 *                   model was asked once to correct it (result may still fail);
 *  - `tool-lookup`— one response carried a verified lookup *and* card tools; the
 *                   lookup ran first and its result was handed back for one
 *                   extra turn so the model could fill the card arguments;
 *  - `planner`    — the main planner (DeepSeek/StepFun/GPT) answered, or at
 *                   least one real planner turn ran (a `lookup` re-entry into a
 *                   data adapter returns without a provider label);
 *  - `legacy`     — the tool layer failed and `VIVIC_LEGACY_FALLBACK=on` sent the
 *                   turn to the old planner;
 *  - `error`      — the turn ended in an error result.
 */
export type IntentPath = "rules-fast" | "tool" | "tool-repair" | "tool-lookup" | "planner" | "legacy" | "error";

/** Mutable per-request state the pipeline fills in as the turn progresses. */
export interface IntentLogSink {
  /** Set when the tool layer fell back to the old planner or repaired a call, and
   *  when a real planner turn ran. */
  path?: IntentPath;
  /** Tool names the model asked for (deduped, in call order). */
  tools: string[];
  /** Truncated diagnostic: tool plan issues or transport error. */
  error?: string;
  /** Model turns spent repairing a rejected tool call; absent when none ran. */
  repairs?: number;
  /** Which live capability a mixed batch ran, and whether it produced evidence. */
  lookup?: { tool: "search" | "weather" | "read_url" | "metal_price"; outcome: "ok" | "empty" };
  /** Which fact a model-chosen clarification asked about (coverage stats). */
  clarifyMissing?: string;
  /** The turn executed a canvas action but the model never wrote its receipt,
   *  even after the one repair turn: the host's own line was spoken instead.
   *  A rising count means the model is ignoring the receipt contract, not that
   *  the default line is acceptable product copy. */
  sayFallback?: true;
  /** Where this turn's spoken line came from: the action batch itself, or the
   *  one post-execution turn that turns the receipt into a sentence. */
  saySource?: "synthesized";
  /** Token totals every model turn of this request reported, including repair
   *  and lookup feed-back turns. Created with the sink; absent in hand-made
   *  sinks that do not meter. */
  tokens?: TokenUsageMeter;
}

export const createIntentLogSink = (): IntentLogSink => ({ tools: [], tokens: createTokenUsageMeter() });

const MAX_ERROR = 200;
const MAX_LIST = 8;

const clip = (value: string, max: number): string => value.length > max ? `${value.slice(0, max - 1)}…` : value;

const uniq = (values: string[]): string[] => [...new Set(values.filter(Boolean))].slice(0, MAX_LIST);

/** Card types a committed envelope creates, in order; empty for host-only turns. */
export const cardTypesOf = (result: IntentResult): string[] =>
  uniq((result.envelope?.actions ?? []).flatMap(action => action.type === "card.create" ? [action.card.type] : []));

/** Only the tool-repair marker, the `legacy` fallback and the "a planner turn
 *  really ran" marker are recorded by the pipeline; the rest is derived from the
 *  result. */
export const intentPathOf = (result: IntentResult, sink: IntentLogSink): IntentPath => {
  if (result.kind === "error") return "error";
  if (sink.path === "legacy") return "legacy";
  if (sink.path === "tool-lookup") return "tool-lookup";
  if (sink.path === "tool-repair") return "tool-repair";
  if (result.toolCalls === true) return "tool";
  // A planner turn happened even when the committed result is a rules-shaped
  // clarify (planner -> lookup -> data adapter re-entry, sc-21). Without this the
  // turn is counted as `rules-fast` although it cost a real model round trip.
  if (sink.path === "planner") return "planner";
  if (result.usedProvider === "stepfun" || result.usedProvider === "gpt" || result.usedProvider === "deepseek") return "planner";
  return "rules-fast";
};

export interface IntentLogLine {
  requestId: string;
  path: IntentPath;
  tools: string[];
  cards: string[];
  elapsedMs: number;
  kind: IntentResult["kind"];
  provider?: string;
  /** Truncated; absent when the turn did not fail. */
  error?: string;
  /** Present when the tool layer retried after a validation failure. */
  repairs?: number;
  /** Outcome of that retry: `fixed` built a result, `still-invalid` did not. */
  repair?: "fixed" | "still-invalid";
  /** Present when a mixed lookup+cards batch ran a live capability. */
  lookup?: { tool: "search" | "weather" | "read_url" | "metal_price"; outcome: "ok" | "empty" };
  /** Present when the model chose to clarify: which fact it asked about. */
  clarify?: { missing: string };
  /** Present when an action batch had no model receipt, even after repair, so
   *  the host's own line was spoken (`missing-say` fallback). */
  sayFallback?: true;
  /** Where this turn's spoken line came from: the action batch itself, or the
   *  one post-execution turn that turns the receipt into a sentence. */
  saySource?: "synthesized";
  /** Token totals and turn count; present only when a response reported usage. */
  tokens?: TokenUsage;
}

/** Pure formatter: the HTTP handler owns the write, so tests never touch stderr. */
export const intentLogLine = (result: IntentResult, sink: IntentLogSink, requestId: string, startedAt: number): IntentLogLine => {
  // An error result's own message is the most useful failure text; tool issues
  // explain a fallback. Both are already user-safe and get truncated here.
  const failure = sink.error ?? (result.kind === "error" ? result.message : undefined);
  const path = intentPathOf(result, sink);
  const tokens = sink.tokens?.summary();
  return {
    requestId,
    path,
    tools: uniq(sink.tools),
    cards: cardTypesOf(result),
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    kind: result.kind,
    ...(result.usedProvider ? { provider: result.usedProvider } : {}),
    ...(failure ? { error: clip(failure.replace(/\s+/gu, " "), MAX_ERROR) } : {}),
    ...(sink.repairs ? { repairs: sink.repairs } : {}),
    ...(path === "tool-repair" || path === "tool-lookup"
      ? { repair: (result.kind === "envelope" || result.kind === "host-operation" ? "fixed" : "still-invalid") as "fixed" | "still-invalid" }
      : {}),
    ...(sink.lookup ? { lookup: sink.lookup } : {}),
    ...(sink.clarifyMissing ? { clarify: { missing: sink.clarifyMissing } } : {}),
    ...(sink.sayFallback ? { sayFallback: true as const } : {}),
    ...(sink.saySource ? { saySource: sink.saySource } : {}),
    ...(tokens ? { tokens } : {}),
  };
};

export type IntentLogWriter = (line: string) => void;

/** Durable JSONL telemetry directory. Container stdout is lost whenever the
 *  container is recreated (every deploy), so evidence must also hit a disk that
 *  survives restarts. Unset → stderr only (unchanged behaviour). */
const TELEMETRY_DIR_ENV = "VIVIC_TELEMETRY_DIR";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const KEEP_DAYS = 30;

const dayStamp = (date: Date): string => date.toISOString().slice(0, 10);

/** stderr (docker logs) + optional daily JSONL file. Never throws. */
export const createIntentLogWriter = (dir = process.env[TELEMETRY_DIR_ENV]?.trim(), now: () => Date = () => new Date()): IntentLogWriter => {
  let ready = false;
  let cleaned = "";
  return (line: string): void => {
    try { process.stderr.write(`${line}\n`); } catch { /* telemetry is noncritical */ }
    if (!dir) return;
    try {
      if (!ready) { mkdirSync(dir, { recursive: true }); ready = true; }
      const stamp = dayStamp(now());
      const file = join(dir, `intent-${stamp}.jsonl`);
      try { if (statSync(file).size > MAX_FILE_BYTES) renameSync(file, `${file}.1`); } catch { /* absent is fine */ }
      appendFileSync(file, `${line}\n`);
      if (cleaned !== stamp) {
        cleaned = stamp;
        const cutoff = now().getTime() - KEEP_DAYS * 86_400_000;
        for (const name of readdirSync(dir)) {
          const match = /^intent-(\d{4}-\d{2}-\d{2})\.jsonl(?:\.1)?$/u.exec(name);
          if (match && Date.parse(`${match[1]}T00:00:00Z`) < cutoff) unlinkSync(join(dir, name));
        }
      }
    } catch { /* telemetry is noncritical */ }
  };
};

const defaultIntentLogWriter = createIntentLogWriter();

/** Writes exactly one JSON line. Never throws into the request path. */
export const logIntent = (result: IntentResult, sink: IntentLogSink, requestId: string, startedAt: number,
  write: IntentLogWriter = defaultIntentLogWriter): void => {
  try { write(JSON.stringify(intentLogLine(result, sink, requestId, startedAt))); } catch { /* telemetry is noncritical */ }
};
