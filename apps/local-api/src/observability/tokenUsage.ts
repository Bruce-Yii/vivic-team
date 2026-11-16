/**
 * Token accounting for one `/api/intent` request.
 *
 * Providers report usage in incompatible shapes and field names:
 *  - OpenAI / DeepSeek: `prompt_tokens` (includes cached), `completion_tokens`,
 *    `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens`,
 *    `prompt_tokens_details.cached_tokens`;
 *  - Anthropic: `input_tokens` (excludes cache reads), `output_tokens`,
 *    `cache_read_input_tokens`, `cache_creation_input_tokens`;
 *  - Pi (`@earendil-works/pi-ai`, used by the GPT planner): `input` (excludes
 *    cache reads/writes), `output`, `cacheRead`, `cacheWrite`.
 *
 * `normalizeTokenUsage` maps all of them onto one delta. The per-request meter
 * only adds numbers: it never sees a prompt, a completion or a credential, so
 * the intent log can carry token totals without carrying private content.
 */

/** One model response's normalized usage. `model` is the provider model id. */
export interface TokenUsageDelta {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  model?: string;
}

/** Per-request aggregate written to the intent log as `tokens`. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
  model: string;
  turns: number;
}

export interface TokenUsageMeter {
  /** Adds one model response; a missing usage report is ignored, never thrown. */
  record(usage: TokenUsageDelta | undefined): void;
  /** `undefined` when no response in this request reported usage. */
  summary(): TokenUsage | undefined;
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;

const nestedCount = (value: unknown, key: string): number | undefined => count(recordOf(value)?.[key]);

/**
 * Normalizes one provider usage object. Returns `undefined` when the response
 * carried no recognizable counters, so callers can omit the field instead of
 * writing a fake zero row.
 */
export const normalizeTokenUsage = (raw: unknown, model?: string): TokenUsageDelta | undefined => {
  const usage = recordOf(raw);
  if (!usage) return undefined;

  // Already normalized (our own delta or a gateway that echoes it back).
  const normalizedHit = count(usage.cacheHit), normalizedMiss = count(usage.cacheMiss);
  if (normalizedHit !== undefined || normalizedMiss !== undefined) {
    const input = count(usage.input) ?? (normalizedHit ?? 0) + (normalizedMiss ?? 0);
    return {
      input,
      output: count(usage.output) ?? 0,
      cacheHit: normalizedHit ?? 0,
      cacheMiss: normalizedMiss ?? Math.max(0, input - (normalizedHit ?? 0)),
      ...(model ? { model } : {}),
    };
  }

  // Pi shape: `input` already excludes cache reads and writes.
  if (usage.cacheRead !== undefined || usage.cacheWrite !== undefined) {
    const cacheHit = count(usage.cacheRead) ?? 0;
    const cacheWrite = count(usage.cacheWrite) ?? 0;
    const input = (count(usage.input) ?? 0) + cacheHit + cacheWrite;
    return { input, output: count(usage.output) ?? 0, cacheHit, cacheMiss: input - cacheHit, ...(model ? { model } : {}) };
  }

  const prompt = count(usage.prompt_tokens) ?? count(usage.input_tokens);
  const output = count(usage.completion_tokens) ?? count(usage.output_tokens) ?? count(usage.output);
  const cacheHit = count(usage.prompt_cache_hit_tokens)
    ?? nestedCount(usage.prompt_tokens_details, "cached_tokens")
    ?? count(usage.cached_tokens)
    ?? count(usage.cache_read_input_tokens)
    ?? 0;
  const explicitMiss = count(usage.prompt_cache_miss_tokens);
  const anthropic = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  if (anthropic) {
    // Anthropic's `input_tokens` excludes cache reads and writes; the cache
    // counters must be added back for a comparable "total prompt" number.
    const base = prompt ?? 0;
    const cacheWrite = count(usage.cache_creation_input_tokens) ?? 0;
    return { input: base + cacheHit + cacheWrite, output: output ?? 0, cacheHit, cacheMiss: base + cacheWrite, ...(model ? { model } : {}) };
  }
  if (prompt === undefined && explicitMiss === undefined && cacheHit === 0 && output === undefined) return undefined;
  const input = prompt ?? cacheHit + (explicitMiss ?? 0);
  return {
    input,
    output: output ?? 0,
    cacheHit,
    cacheMiss: explicitMiss ?? Math.max(0, input - cacheHit),
    ...(model ? { model } : {}),
  };
};

/**
 * Attaches the usage counter as a non-enumerable side channel.
 *
 * `StepfunResult` is the answered value, and existing callers compare it with
 * structural equality; a provider's accounting counters must not turn an
 * identical answer into a different object. The pipeline reads `result.usage`
 * directly, which works for a non-enumerable own property.
 */
export const attachTokenUsage = <T extends object>(result: T, usage: TokenUsageDelta | undefined): T & { usage?: TokenUsageDelta } => {
  if (usage) Object.defineProperty(result, "usage", { value: usage, enumerable: false, configurable: true });
  return result;
};

/** Mutable per-request accumulator; one instance lives on the intent log sink. */export const createTokenUsageMeter = (): TokenUsageMeter => {
  const totals = { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 };
  const models: string[] = [];
  let turns = 0;
  return {
    record(usage) {
      if (!usage) return;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheHit += usage.cacheHit;
      totals.cacheMiss += usage.cacheMiss;
      turns += 1;
      if (usage.model && !models.includes(usage.model)) models.push(usage.model);
    },
    summary() {
      if (turns === 0) return undefined;
      return { ...totals, model: models.length ? models.join("+") : "unknown", turns };
    },
  };
};
