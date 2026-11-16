import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseSearchProvider } from "../src/config.js";
import { createSearchClient } from "../src/search/client.js";

/**
 * The user rejected the paid DeepSeek Search/Fetch API. This is a source-level
 * guarantee: the backend has no code path, endpoint constant or key read that
 * could call it, so a later edit cannot quietly reintroduce the charge.
 */

const root = path.resolve(import.meta.dirname, "..");
const read = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const full = path.join(dir, entry.name);
  return entry.isDirectory() ? read(full) : full.endsWith(".ts") ? [full] : [];
});
const source = read(path.join(root, "src"));
const docText = (name: string) => fs.readFileSync(path.join(root, "..", "..", "docs", "decisions", name), "utf8");

describe("search and page reads stay on the free routes", () => {
  it("no backend source references a paid DeepSeek search/fetch endpoint or adapter", () => {
    expect(source.length).toBeGreaterThan(100);
    for (const file of source) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/tools\/(?:search|fetch)/);
      expect(text, file).not.toMatch(/DEEPSEEK_(?:SEARCH|FETCH)/);
      expect(text, file).not.toMatch(/deepseek\/(?:search|fetch)/);
      expect(text, file).not.toMatch(/callDeepSeek(?:Search|Fetch)/);
    }
  });

  it("VIVIC_SEARCH_PROVIDER accepts bing, ddg, exa and auto", () => {
    expect(parseSearchProvider("bing")).toBe("bing");
    expect(parseSearchProvider("ddg")).toBe("ddg");
    expect(parseSearchProvider("exa")).toBe("exa");
    expect(parseSearchProvider("auto")).toBe("auto");
    // A retired or mistyped mode falls back to auto, never to a paid route.
    expect(parseSearchProvider("deepseek")).toBe("auto");
    expect(parseSearchProvider(undefined)).toBe("auto");
    expect(parseSearchProvider("DEEPSEEK ")).toBe("auto");
  });

  it("keeps DuckDuckGo as an explicit option, not the default free route", () => {
    // `auto` is the default; its first route now points at Bing. The DDG
    // adapter stays available for `VIVIC_SEARCH_PROVIDER=ddg` (overseas).
    expect(createSearchClient().expectedProvider!()).toBe("bing");
    const client = fs.readFileSync(path.join(root, "src", "search", "client.ts"), "utf8");
    const config = fs.readFileSync(path.join(root, "src", "config.ts"), "utf8");
    for (const text of [client, config]) {
      expect(text).not.toMatch(/\?\?\s*"ddg"/);
      expect(text).not.toMatch(/=\s*"ddg"\s*;/);
    }
  });

  it("the decision record documents the free chain and no per-request price", () => {
    const doc = docText("2026-11-04-free-search-bing.md");
    expect(doc).toContain("Bing");
    expect(doc).toContain("cn.bing.com");
    expect(doc).toContain("免费");
    expect(doc).toContain("read_url");
    // DuckDuckGo remains documented as the non-default, overseas-only option.
    expect(doc).toContain("DuckDuckGo");
    expect(doc).toContain("VIVIC_SEARCH_PROVIDER");
    for (const stale of ["5 元", "1000 次", "tools/search", "tools/fetch"]) expect(doc).not.toContain(stale);
  });
});
