/**
 * Bounded in-memory TTL + LRU cache for provider payloads (search evidence and
 * fetched pages). A hit is cloned so a caller can never mutate the stored value
 * or another caller's result. Failed calls are never inserted by the callers;
 * this class only stores whatever success they hand it.
 */
export interface TtlLruCacheOptions {
  ttlMs: number;
  maxEntries: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlLruCache<T> {
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #now: () => number;
  readonly #entries = new Map<string, Entry<T>>();

  constructor(options: TtlLruCacheOptions) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new RangeError("ttlMs must be positive");
    if (!Number.isInteger(options.maxEntries) || options.maxEntries <= 0) throw new RangeError("maxEntries must be a positive integer");
    this.#ttlMs = options.ttlMs;
    this.#maxEntries = options.maxEntries;
    this.#now = options.now ?? Date.now;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: string): T | undefined {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.#now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency: Map iteration order is insertion order.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return structuredClone(hit.value);
  }

  set(key: string, value: T): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
    this.#entries.set(key, { value, expiresAt: this.#now() + this.#ttlMs });
  }

  clear(): void {
    this.#entries.clear();
  }
}
