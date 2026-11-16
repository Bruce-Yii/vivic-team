import type { IntentLogLine } from "./intentLog.js";

/**
 * Aggregates one day's `intent-YYYY-MM-DD.jsonl` lines into per-path/model token
 * totals. Pure and side-effect free so the CLI and the tests share the exact
 * same arithmetic; the log itself carries numbers only.
 */
export interface TokenSummaryBucket {
  path: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  turns: number;
  /** cacheHit / input, 0 when the request reported no prompt tokens. */
  cacheHitRate: number;
  meanInput: number;
  p50Input: number;
  p95Input: number;
}

export interface TokenSummary {
  /** Parsed lines (blank lines are ignored). */
  requests: number;
  /** Lines that carried a `tokens` object. */
  withTokens: number;
  /** Lines that were not valid JSON. */
  malformed: number;
  buckets: TokenSummaryBucket[];
}

const number = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

const positiveInt = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;

/** Nearest-rank percentile (p in (0,1]); empty input is 0. */
const percentile = (sorted: number[], fraction: number): number => {
  if (!sorted.length) return 0;
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1]!;
};

interface PendingBucket {
  path: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  turns: number;
  perRequestInput: number[];
}

const parseLine = (line: string): IntentLogLine | undefined => {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as IntentLogLine : undefined;
  } catch {
    return undefined;
  }
};

export const summarizeTokenLog = (lines: string[]): TokenSummary => {
  const pending = new Map<string, PendingBucket>();
  let requests = 0, withTokens = 0, malformed = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = parseLine(line);
    if (!parsed) { malformed += 1; continue; }
    requests += 1;
    const tokens = parsed.tokens;
    if (!tokens || typeof tokens !== "object") continue;
    const input = number(tokens.input), output = number(tokens.output);
    const cacheHit = number(tokens.cacheHit), cacheMiss = number(tokens.cacheMiss);
    const turns = positiveInt(tokens.turns);
    if (input === 0 && output === 0 && cacheHit === 0 && cacheMiss === 0 && turns === undefined) continue;
    withTokens += 1;
    const path = typeof parsed.path === "string" && parsed.path ? parsed.path : "unknown";
    const model = typeof tokens.model === "string" && tokens.model ? tokens.model : "unknown";
    const key = `${path}\u0000${model}`;
    const bucket = pending.get(key) ?? { path, model, requests: 0, input: 0, output: 0, cacheHit: 0, cacheMiss: 0, turns: 0, perRequestInput: [] };
    bucket.requests += 1;
    bucket.input += input;
    bucket.output += output;
    bucket.cacheHit += cacheHit;
    bucket.cacheMiss += cacheMiss;
    bucket.turns += turns ?? 0;
    bucket.perRequestInput.push(input);
    pending.set(key, bucket);
  }
  const buckets: TokenSummaryBucket[] = [...pending.values()].map(bucket => {
    const sorted = [...bucket.perRequestInput].sort((a, b) => a - b);
    return {
      path: bucket.path,
      model: bucket.model,
      requests: bucket.requests,
      input: bucket.input,
      output: bucket.output,
      cacheHit: bucket.cacheHit,
      cacheMiss: bucket.cacheMiss,
      turns: bucket.turns,
      cacheHitRate: bucket.input > 0 ? bucket.cacheHit / bucket.input : 0,
      meanInput: bucket.requests > 0 ? bucket.input / bucket.requests : 0,
      p50Input: percentile(sorted, 0.5),
      p95Input: percentile(sorted, 0.95),
    };
  }).sort((a, b) => b.input - a.input || a.path.localeCompare(b.path) || a.model.localeCompare(b.model));
  return { requests, withTokens, malformed, buckets };
};

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const fixed = (value: number): string => value.toFixed(1);

/** Human-readable table for the CLI; the JSON form is the raw summary. */
export const formatTokenSummary = (summary: TokenSummary, source: string): string => {
  const header = ["path", "model", "req", "input", "output", "cacheHit", "hitRate", "meanIn", "p50", "p95"];
  const rows = summary.buckets.map(bucket => [
    bucket.path, bucket.model, String(bucket.requests), String(bucket.input), String(bucket.output),
    String(bucket.cacheHit), percent(bucket.cacheHitRate), fixed(bucket.meanInput),
    String(bucket.p50Input), String(bucket.p95Input),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => row[index]!.length)));
  const render = (row: string[]): string => row.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();
  return [
    `token summary · ${source}`,
    `requests=${summary.requests} withTokens=${summary.withTokens} malformed=${summary.malformed}`,
    render(header),
    ...rows.map(render),
  ].join("\n");
};
