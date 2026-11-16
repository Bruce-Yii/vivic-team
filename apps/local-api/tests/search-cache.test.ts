import { describe, expect, it } from "vitest";
import { TtlLruCache } from "../src/search/cache.js";

describe("TtlLruCache", () => {
  it("expires entries after the TTL and returns clones, not stored references", () => {
    let now = 1_000;
    const cache = new TtlLruCache<number[]>({ ttlMs: 100, maxEntries: 2, now: () => now });
    const value = [1, 2];
    cache.set("a", value);
    const hit = cache.get("a")!;
    hit.push(3);
    expect(cache.get("a")).toEqual([1, 2]);
    expect(value).toEqual([1, 2]);
    now += 100;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry at the cap and refreshes recency on get", () => {
    const cache = new TtlLruCache<string>({ ttlMs: 1_000, maxEntries: 2, now: () => 0 });
    cache.set("a", "A");
    cache.set("b", "B");
    expect(cache.get("a")).toBe("A");
    cache.set("c", "C");
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("A");
    expect(cache.get("c")).toBe("C");
    expect(cache.size).toBe(2);
  });

  it("rejects invalid bounds", () => {
    expect(() => new TtlLruCache({ ttlMs: 0, maxEntries: 1 })).toThrow(RangeError);
    expect(() => new TtlLruCache({ ttlMs: 1, maxEntries: 0 })).toThrow(RangeError);
  });
});
