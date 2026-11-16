import type { SearchEvidence } from "./client.js";
import { SearchError } from "./errors.js";
import { publicHttpsUrl } from "./policy.js";
import { requestPublicHttps } from "./transport.js";

/**
 * Free, keyless Bing China HTML search.
 *
 * `GET https://cn.bing.com/search?q=<query>` with a normal desktop browser
 * User-Agent answers 200 and a server-rendered result list (verified from the
 * production server on 2026-11-04: 0.35 s, ten `li.b_algo` blocks). Unlike
 * `html.duckduckgo.com`, which times out from mainland China, `cn.bing.com` is
 * reachable there, so this is the default free first route.
 *
 * The adapter performs exactly one request and never retries on its own: the
 * caller's provider chain owns failover. Any timeout, non-200, challenge page
 * or unusable body is a failure for that chain, never a fabricated result.
 */
export const BING_HTML_ENDPOINT = "https://cn.bing.com/search";
export const BING_PROVIDER = "bing/html" as const;
/** Same cap as the HTTP query schema. */
export const BING_MAX_QUERY_CHARS = 500;

/** A real desktop browser string; Bing answers generic bot agents with a challenge. */
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * A challenge/anti-bot page can arrive with status 200 and even some result
 * markup. It must fail the route instead of being parsed into citations.
 */
const CHALLENGE_PAGE = /(?:unusual traffic|verify (?:that )?you are (?:a )?human|are you a robot|showcaptcha|g-recaptcha|challenge-form|\bcaptcha\b|验证码)/i;

/** Bing marks the "no results" page with `b_no`; zero parsed results plus this marker is a block, not an answer. */
const NO_RESULTS_MARKER = /\bb_no\b/i;

const rateLimited = () => new SearchError("search-rate-limited", "Bing 免费搜索暂时限速，请稍后重试。", 429);
const invalidResponse = () => new SearchError("search-invalid-response", "Bing 返回了无法识别的页面。", 502);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};

/** Bing writes `&amp;` in hrefs and typographic entities in titles. */
function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Visible text of one HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
function cleanText(fragment: string, max: number): string {
  return decodeEntities(fragment.replace(/<[^>]*>/gu, " "))
    .replace(/\p{Cc}/gu, " ").replace(/\s+/gu, " ").trim().slice(0, max);
}

function attribute(attributes: string, name: string): string | undefined {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i").exec(attributes)
    ?? new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i").exec(attributes);
  return quoted?.[1];
}

/** Inner HTML of the element that starts at `start`; `undefined` when it is never closed. */
function innerElement(html: string, start: number, openLength: number, tag: string): string | undefined {
  const pattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  pattern.lastIndex = start + openLength;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[1]) {
      depth--;
      if (depth === 0) return html.slice(start + openLength, match.index);
    } else {
      depth++;
    }
  }
  return undefined;
}

/**
 * Real target of one result link. Bing returns either a direct `https://`
 * href or a click shell such as
 * `https://www.bing.com/ck/a?...&u=a1<base64url of the target>`. The `a1`
 * prefix is part of Bing's encoding; a missing or undecodable payload drops
 * the citation rather than guessing. Relative links resolve against the
 * endpoint, so a site-internal `cn.bing.com/...` link is dropped.
 */
export function bingTargetUrl(href: string): URL | undefined {
  const decoded = decodeEntities(href).trim();
  if (!decoded) return undefined;
  let link: URL;
  try { link = new URL(decoded, BING_HTML_ENDPOINT); } catch { return undefined; }
  if (/(?:^|\.)bing\.com$/i.test(link.hostname)) {
    if (!/^\/ck\/a\/?$/i.test(link.pathname)) return undefined;
    const payload = link.searchParams.get("u");
    if (!payload || !payload.startsWith("a1")) return undefined;
    const encoded = payload.slice(2).replace(/={1,2}$/, "");
    if (!encoded || encoded.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    let target: string;
    try { target = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64url")); }
    catch { return undefined; }
    if (!/^https?:\/\//i.test(target)) return undefined;
    try { return publicHttpsUrl(target); } catch { return undefined; }
  }
  try { return publicHttpsUrl(link.href); } catch { return undefined; }
}

/** One `li.b_algo` block, bounded by the next list item or list end. */
function resultBlocks(html: string): string[] {
  const starts: number[] = [];
  for (const match of html.matchAll(/<li\b[^>]*\bclass\s*=\s*(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*')[^>]*>/gi)) {
    starts.push(match.index ?? 0);
  }
  return starts.map(start => {
    const rest = html.slice(start + 1);
    const next = /<\/?(?:li|ol|ul)\b/i.exec(rest);
    return html.slice(start, next ? start + 1 + next.index : html.length);
  });
}

/** `.b_caption p` first, then `.b_algoSlug` / `.b_lineclamp*`; no snippet is allowed. */
function snippetForBlock(block: string): string {
  for (const match of block.matchAll(/<(div|section|li)\b([^>]*)>/gi)) {
    if (!/(?:^|\s)b_caption(?:\s|$)/i.test(attribute(match[2] ?? "", "class") ?? "")) continue;
    const tag = match[1]!.toLowerCase();
    const inner = innerElement(block, match.index ?? 0, match[0].length, tag) ?? "";
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(inner);
    const text = cleanText(paragraph?.[1] ?? inner, 700);
    if (text) return text;
  }
  for (const match of block.matchAll(/<(p|div|span)\b([^>]*)>/gi)) {
    if (!/(?:^|\s)(?:b_algoSlug|b_lineclamp\d*)(?:\s|$)/i.test(attribute(match[2] ?? "", "class") ?? "")) continue;
    const tag = match[1]!.toLowerCase();
    const inner = innerElement(block, match.index ?? 0, match[0].length, tag);
    if (inner) return cleanText(inner, 700);
  }
  return "";
}

interface Candidate { title: string; url: URL; snippet: string }

/**
 * Parse one Bing HTML page into the app's evidence shape.
 *
 * Each `li.b_algo` yields the first `h2 a` title/link and its excerpt; blocks
 * without an extractable public HTTPS target are dropped. Results are
 * de-duplicated by URL and capped at `maxResults`.
 */
export function parseBingHtml(html: string, maxResults: number, fetchedAt: string): SearchEvidence[] {
  const candidates: Candidate[] = [];
  for (const block of resultBlocks(html)) {
    const heading = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(block);
    const anchor = heading ? /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(heading[1] ?? "") : null;
    if (!anchor) continue;
    const href = attribute(anchor[1] ?? "", "href");
    const url = href ? bingTargetUrl(href) : undefined;
    if (!url) continue;
    candidates.push({
      title: cleanText(anchor[2] ?? "", 300) || url.hostname,
      url,
      snippet: snippetForBlock(block),
    });
  }
  const results: SearchEvidence[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url.href)) continue;
    seen.add(candidate.url.href);
    results.push({
      title: candidate.title, url: candidate.url.href, snippet: candidate.snippet,
      fetchedAt, provider: BING_PROVIDER, readFullPage: false,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * One HTML search request → `SearchEvidence[]`. A genuine no-result page is an
 * empty list (the chain continues to the next route); a challenge page is a
 * rate-limit failure, so a blocked route can never masquerade as "nothing
 * found".
 */
export async function callBingSearch(options: {
  query: string;
  maxResults: number;
  maxBytes: number;
  signal: AbortSignal;
  publicDnsFallback?: boolean;
}): Promise<SearchEvidence[]> {
  const query = options.query.trim();
  if (!query || [...query].length > BING_MAX_QUERY_CHARS || /\p{Cc}/u.test(query)) {
    throw new SearchError("search-invalid-input", `Bing 搜索词须为 1–${BING_MAX_QUERY_CHARS} 个字符。`, 400);
  }
  const reply = await requestPublicHttps(`${BING_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    signal: options.signal,
    maxBytes: options.maxBytes,
    publicDnsFallback: options.publicDnsFallback === true,
    // A browser UA plus a normal Accept header; no cookies, no referer, and no
    // credentials of any kind. The query is the only request data.
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html",
      "Accept-Language": "zh-CN,zh;q=0.9",
    },
    acceptContentType: type => type === "text/html" || type === "application/xhtml+xml",
  });
  if (reply.status === 202 || reply.status === 429) throw rateLimited();
  if (reply.status < 200 || reply.status >= 300) {
    throw new SearchError("search-unavailable", "Bing 搜索当前不可用，请稍后重试。", 502);
  }
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(reply.body); }
  catch { throw invalidResponse(); }
  // Only server-rendered text can be a challenge; normal pages may mention
  // "captcha" in script configuration. Stripping scripts/styles avoids that
  // false positive without hiding a real block page.
  const visible = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ").replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  if (CHALLENGE_PAGE.test(visible)) throw rateLimited();
  const results = parseBingHtml(html, options.maxResults, new Date().toISOString());
  // `b_no` with no citations is Bing's block/no-answer marker, not empty evidence.
  if (!results.length && NO_RESULTS_MARKER.test(visible)) throw rateLimited();
  return results;
}
