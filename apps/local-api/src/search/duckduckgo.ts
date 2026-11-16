import type { SearchEvidence } from "./client.js";
import { SearchError } from "./errors.js";
import { publicHttpsUrl } from "./policy.js";
import { requestPublicHttps } from "./transport.js";

/**
 * Free, keyless DuckDuckGo HTML search.
 *
 * `GET https://html.duckduckgo.com/html/?q=<query>` with a normal desktop
 * browser User-Agent answers 200 and a plain server-rendered page (verified
 * 2026-11-04): no API key, no quota, nothing billed. The page is deliberately
 * simple to parse — `a.result__a` carries the title and a `//duckduckgo.com/l/?uddg=…`
 * click-tracking link whose `uddg` parameter is the real target, and
 * `.result__snippet` carries the excerpt.
 *
 * The adapter performs exactly one request and never retries on its own: the
 * caller's provider chain owns failover. Any timeout, non-200, challenge page
 * or unusable body is a failure for that chain, never a fabricated result.
 */
export const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
export const DUCKDUCKGO_PROVIDER = "duckduckgo/html" as const;
/** Same cap as the HTTP query schema; DDG rejects much shorter inputs only. */
export const DUCKDUCKGO_MAX_QUERY_CHARS = 500;

/**
 * A real desktop browser string. DDG serves its minimal page to unknown
 * clients but answers generic bot agents with a challenge page.
 */
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

/**
 * Rate limiting answers 202/429 or an "anomaly"/captcha page with status 200.
 * Such a page must fail the route instead of being parsed into empty results.
 */
const CHALLENGE_PAGE = /(?:anomaly-modal|challenge-form|g-recaptcha|are you a robot|unusual traffic|bots use duckduckgo)/i;

const rateLimited = () => new SearchError("search-rate-limited", "DuckDuckGo 免费搜索暂时限速，请稍后重试。", 429);
const invalidResponse = () => new SearchError("search-invalid-response", "DuckDuckGo 返回了无法识别的页面。", 502);

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
};

/** DDG writes `&amp;` in hrefs and typographic entities in titles. */
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

function classNames(attributes: string): Set<string> {
  return new Set((attribute(attributes, "class") ?? "").split(/\s+/u).filter(Boolean));
}

/**
 * Real target of one result link. DDG wraps every citation as
 * `//duckduckgo.com/l/?uddg=<urlencoded>`; relative links resolve against the
 * search endpoint and are dropped. Only public HTTPS targets survive
 * `publicHttpsUrl`, so `http://`, private and non-web links never become
 * citations.
 */
export function duckDuckGoTargetUrl(href: string): URL | undefined {
  const decoded = decodeEntities(href).trim();
  if (!decoded) return undefined;
  let link: URL;
  try {
    link = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, DUCKDUCKGO_HTML_ENDPOINT);
  } catch { return undefined; }
  if (/(?:^|\.)duckduckgo\.com$/i.test(link.hostname)) {
    if (!link.pathname.startsWith("/l/")) return undefined;
    const target = link.searchParams.get("uddg");
    if (!target) return undefined;
    try { return publicHttpsUrl(target); } catch { return undefined; }
  }
  try { return publicHttpsUrl(link.href); } catch { return undefined; }
}

interface Candidate { title: string; url: URL; snippet: string }

/**
 * Parse one DDG HTML page into the app's evidence shape.
 *
 * Titles come from `a.result__a`, snippets from the following
 * `.result__snippet` element (an anchor or a div, depending on the markup
 * variant). Results are de-duplicated by URL, capped at `maxResults`, and
 * anything that is not a public HTTPS page is dropped.
 */
export function parseDuckDuckGoHtml(html: string, maxResults: number, fetchedAt: string): SearchEvidence[] {
  const marks: { index: number; href?: string; title?: string; snippet?: string }[] = [];
  // Title/snippet anchors.
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const classes = classNames(match[1] ?? "");
    if (classes.has("result__a")) marks.push({ index: match.index ?? 0, href: attribute(match[1] ?? "", "href"), title: match[2] ?? "" });
    else if (classes.has("result__snippet")) marks.push({ index: match.index ?? 0, snippet: match[2] ?? "" });
  }
  // Some markup variants emit the excerpt as a non-anchor element. The scan
  // stops at each element's own closing tag instead of consuming a whole
  // container, so a snippet nested in a `<div class="result">` is still seen.
  for (const match of html.matchAll(/<(div|td|span|p)\b([^>]*\bclass="[^"]*result__snippet[^"]*"[^>]*)>/gi)) {
    const start = match.index ?? 0;
    const close = html.indexOf(`</${match[1]!.toLowerCase()}>`, start + match[0].length);
    marks.push({ index: start, snippet: close < 0 ? "" : html.slice(start + match[0].length, close) });
  }
  marks.sort((left, right) => left.index - right.index);
  const candidates: Candidate[] = [];
  let target: Candidate | undefined;
  for (const mark of marks) {
    if (mark.href !== undefined) {
      const url = duckDuckGoTargetUrl(mark.href);
      target = url ? { title: cleanText(mark.title ?? "", 300) || url.hostname, url, snippet: "" } : undefined;
      if (target) candidates.push(target);
    } else if (target && !target.snippet) {
      target.snippet = cleanText(mark.snippet ?? "", 700);
    }
  }
  const results: SearchEvidence[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.url.href)) continue;
    seen.add(candidate.url.href);
    results.push({
      title: candidate.title, url: candidate.url.href, snippet: candidate.snippet,
      fetchedAt, provider: DUCKDUCKGO_PROVIDER, readFullPage: false,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

/**
 * One HTML search request → `SearchEvidence[]`. An empty page section (no
 * `result__a`) is a genuine empty answer; a challenge page is a failure, so a
 * rate-limited route can never masquerade as "nothing found".
 */
export async function callDuckDuckGoSearch(options: {
  query: string;
  maxResults: number;
  maxBytes: number;
  signal: AbortSignal;
  publicDnsFallback?: boolean;
}): Promise<SearchEvidence[]> {
  const query = options.query.trim();
  if (!query || [...query].length > DUCKDUCKGO_MAX_QUERY_CHARS || /\p{Cc}/u.test(query)) {
    throw new SearchError("search-invalid-input", `DuckDuckGo 搜索词须为 1–${DUCKDUCKGO_MAX_QUERY_CHARS} 个字符。`, 400);
  }
  const reply = await requestPublicHttps(`${DUCKDUCKGO_HTML_ENDPOINT}?q=${encodeURIComponent(query)}`, {
    signal: options.signal,
    maxBytes: options.maxBytes,
    publicDnsFallback: options.publicDnsFallback === true,
    // A browser UA plus a normal Accept header; no cookies, no referer, and no
    // credentials of any kind. The query is the only request data.
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
    acceptContentType: type => type === "text/html" || type === "application/xhtml+xml",
  });
  if (reply.status === 202 || reply.status === 429) throw rateLimited();
  if (reply.status < 200 || reply.status >= 300) {
    throw new SearchError("search-unavailable", "DuckDuckGo 搜索当前不可用，请稍后重试。", 502);
  }
  let html: string;
  try { html = new TextDecoder("utf-8", { fatal: true }).decode(reply.body); }
  catch { throw invalidResponse(); }
  if (CHALLENGE_PAGE.test(html)) throw rateLimited();
  return parseDuckDuckGoHtml(html, options.maxResults, new Date().toISOString());
}
