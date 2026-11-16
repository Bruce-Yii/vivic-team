import { z } from "zod";
import { TtlLruCache } from "../search/cache.js";

/**
 * Verified metal prices, read-only.
 *
 * The existing `search` chain returns snippets, and a snippet about a gold price
 * often carries no number at all (sc-20: the model had to say "没有报价" because
 * the page it could read was rendered by JavaScript). This adapter talks to two
 * fixed, keyless JSON endpoints instead and returns numbers:
 *
 *  - `api.gold-api.com/price/XAU|XAG` — USD per troy ounce;
 *  - `open.er-api.com/v6/latest/USD`  — USD/CNY.
 *
 * CNY per gram is therefore *derived*: USD/oz ÷ 31.1035 × USD/CNY. That is the
 * international bullion price; domestic jewellery/brand prices carry a premium
 * this adapter neither knows nor invents. Both facts travel with the quote.
 *
 * Failure is graded, never hidden: the gold leg is required, the FX leg is an
 * enhancement (a missing rate yields a USD/oz-only quote marked as such), and a
 * total failure returns an honest error. Only complete quotes are cached, for
 * 60 seconds; failures are never cached.
 */

export type Metal = "gold" | "silver";
export type MetalUnit = "gram";

export interface MetalPriceRequest {
  metal?: Metal;
  unit?: MetalUnit;
}

export interface MetalPriceQuote {
  metal: Metal;
  /** International price in USD per troy ounce (the source's own unit). */
  priceUsdPerOunce: number;
  /** Derived CNY per gram; absent when the FX leg failed. */
  priceCnyPerGram?: number;
  /** USD/CNY used for the derivation; absent when the FX leg failed. */
  usdCny?: number;
  /** The price source's own timestamp (ISO-8601), or the fetch time if absent. */
  updatedAt: string;
  /** Exactly the upstream URLs that produced this quote. */
  sources: string[];
}

export type MetalPriceResult =
  | { kind: "ok"; quote: MetalPriceQuote }
  | { kind: "error"; message: string };

export interface MetalPriceClient {
  /** One verified quote. The caller supplies its own cancellation signal; an
   *  aborted signal rejects instead of being reported as a source outage. */
  price(request?: MetalPriceRequest, signal?: AbortSignal): Promise<MetalPriceResult>;
}

export const METAL_PRICE_ENDPOINTS: Readonly<Record<Metal, string>> = Object.freeze({
  gold: "https://api.gold-api.com/price/XAU",
  silver: "https://api.gold-api.com/price/XAG",
});
export const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";
/** One troy ounce, the unit both metals are quoted in. */
export const TROY_OUNCE_GRAMS = 31.1035;
/** Price freshness: a quote older than a minute is re-fetched. */
export const METAL_PRICE_CACHE_TTL_MS = 60_000;

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;
const METAL_LABEL: Readonly<Record<Metal, string>> = Object.freeze({ gold: "金价", silver: "银价" });
const METAL_NAME: Readonly<Record<Metal, string>> = Object.freeze({ gold: "黄金", silver: "白银" });
const METAL_QUOTE_LABEL: Readonly<Record<Metal, string>> = Object.freeze({ gold: "国际金价", silver: "国际银价" });

/** Fixed-host payload contracts. Unknown keys are ignored; the fields below are
 *  the ones the derivation and the citation actually rely on. */
const GoldPayload = z.looseObject({
  price: z.number().finite().positive().max(1_000_000),
  currency: z.literal("USD"),
  updatedAt: z.string().trim().min(1).optional(),
});
const FxPayload = z.looseObject({
  result: z.literal("success"),
  rates: z.looseObject({ CNY: z.number().finite().positive().max(1_000) }),
});

/** Internal: fixed URL, fixed schema, bounded body, no raw payload ever leaves
 *  this module. The thrown error carries no provider text. */
class MetalPriceSourceError extends Error {
  constructor() {
    super("金属价格数据源不可用。");
    this.name = "MetalPriceSourceError";
  }
}

const isJson = (response: Response): boolean =>
  response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";

const readJson = async <T>(url: string, schema: z.ZodType<T>, fetchImpl: typeof fetch,
  signal: AbortSignal | undefined): Promise<T> => {
  if (!url.startsWith("https://") || signal?.aborted) throw new MetalPriceSourceError();
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET", redirect: "error", credentials: "omit", signal: bounded,
      headers: { Accept: "application/json", "User-Agent": "Vivic/0.6 (verified metal price)" },
    });
  } catch {
    throw new MetalPriceSourceError();
  }
  if (response.status !== 200 || response.redirected || (response.url && response.url !== url) || !isJson(response)) {
    void response.body?.cancel().catch(() => {});
    throw new MetalPriceSourceError();
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
    void response.body?.cancel().catch(() => {});
    throw new MetalPriceSourceError();
  }
  if (!response.body) throw new MetalPriceSourceError();
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new MetalPriceSourceError();
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    if (error instanceof MetalPriceSourceError) throw error;
    throw new MetalPriceSourceError();
  } finally {
    void reader.cancel().catch(() => {});
  }
  if (signal?.aborted) throw new MetalPriceSourceError();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new MetalPriceSourceError(); }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new MetalPriceSourceError();
  return parsed.data;
};

const rounded = (value: number, digits: number): number => Number(value.toFixed(digits));

/** The source's timestamp when it is a real instant, else the fetch time. A
 *  fabricated time would be as wrong as a fabricated price. */
const updatedAtOf = (value: string | undefined, fallback: number): string => {
  if (value && Number.isFinite(Date.parse(value))) return new Date(Date.parse(value)).toISOString();
  return new Date(fallback).toISOString();
};

export function createMetalPriceClient(options: { fetchImpl?: typeof fetch; now?: () => number } = {}): MetalPriceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.now ?? Date.now;
  // Two metals; a tiny cap is enough and keeps the adapter memory-bounded.
  const cache = new TtlLruCache<MetalPriceQuote>({ ttlMs: METAL_PRICE_CACHE_TTL_MS, maxEntries: 2, now: clock });

  return {
    async price(request = {}, signal) {
      const metal: Metal = request.metal === "silver" ? "silver" : "gold";
      // `unit` is part of the tool contract; the derivation below is gram-only.
      // A caller that reaches this module directly cannot silently get ounces.
      if (request.unit !== undefined && request.unit !== "gram") {
        return { kind: "error", message: "金属价格目前只支持克（gram）。" };
      }
      const hit = cache.get(metal);
      if (hit) return { kind: "ok", quote: hit };
      if (signal?.aborted) throw signal.reason;

      const [goldLeg, fxLeg] = await Promise.allSettled([
        readJson(METAL_PRICE_ENDPOINTS[metal], GoldPayload, fetchImpl, signal),
        readJson(FX_ENDPOINT, FxPayload, fetchImpl, signal),
      ]);
      // Cancellation is not an outage: the request owner must see the abort.
      if (signal?.aborted) throw signal.reason;
      if (goldLeg.status === "rejected") {
        const label = METAL_LABEL[metal];
        return { kind: "error", message: fxLeg.status === "rejected"
          ? `实时${label}和汇率都取不到（数据源暂时不可用），请稍后再试。`
          : `实时${label}暂时取不到（数据源不可用），请稍后再试。` };
      }

      const gold = goldLeg.value;
      const usdCny = fxLeg.status === "fulfilled" ? fxLeg.value.rates.CNY : undefined;
      const quote: MetalPriceQuote = {
        metal,
        priceUsdPerOunce: rounded(gold.price, 2),
        ...(usdCny !== undefined ? {
          priceCnyPerGram: rounded(gold.price / TROY_OUNCE_GRAMS * usdCny, 2),
          usdCny: rounded(usdCny, 4),
        } : {}),
        updatedAt: updatedAtOf(gold.updatedAt, clock()),
        sources: [METAL_PRICE_ENDPOINTS[metal], ...(usdCny !== undefined ? [FX_ENDPOINT] : [])],
      };
      // A quote missing its FX leg is a degraded result, not a complete one: do
      // not cache it, so the next request retries the rate instead of serving a
      // "汇率不可用" line for a minute.
      if (usdCny !== undefined) cache.set(metal, quote);
      return { kind: "ok", quote };
    },
  };
}

/** The model-facing facts, bounded and explicit about what was NOT verified. */
export const metalPriceFactsText = (quote: MetalPriceQuote): string => {
  const lines = [
    `金属：${METAL_NAME[quote.metal]}（${quote.metal}）`,
    `国际价格：${quote.priceUsdPerOunce.toFixed(2)} 美元/盎司`,
  ];
  if (quote.priceCnyPerGram !== undefined && quote.usdCny !== undefined) {
    lines.push(`折合人民币：${quote.priceCnyPerGram.toFixed(2)} 元/克`);
    lines.push(`汇率：1 美元 = ${quote.usdCny.toFixed(4)} 人民币（按 1 盎司 = ${TROY_OUNCE_GRAMS} 克折算）`);
  } else {
    lines.push(`汇率：不可用（美元兑人民币暂时取不到），无法折算人民币/克`);
  }
  lines.push(`更新时间：${quote.updatedAt}`);
  lines.push(`来源：${quote.sources.join("、")}`);
  lines.push("说明：这是" + METAL_QUOTE_LABEL[quote.metal] + "按汇率折算，不含国内金店/品牌的加工费与溢价，不等于国内零售价。");
  return lines.join("\n");
};
