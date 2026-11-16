import { describe, expect, it, vi } from "vitest";
import { CredentialStore } from "../src/credentials.js";
import { runIntent, type IntentResult, type PipelineDeps } from "../src/intent/pipeline.js";
import { planFromToolCalls } from "../src/intent/toolCalls.js";
import {
  createMetalPriceClient, FX_ENDPOINT, METAL_PRICE_ENDPOINTS, TROY_OUNCE_GRAMS, type MetalPriceQuote,
} from "../src/data/metalPrice.js";
import type { CanvasContext } from "../src/schemas.js";
import { withReceipt } from "./helpers.js";

/**
 * sc-20: 「查一下现在黄金多少钱一克」. `search` returned snippets with no number,
 * and the page `read_url` could reach rendered its price in JavaScript, so the
 * model could only say "没有报价". This adapter returns numbers from two fixed
 * keyless JSON sources and derives CNY/gram as USD/oz ÷ 31.1035 × USD/CNY.
 *
 * The quote is *evidence*, not output: it is handed back in one follow-up turn,
 * the model answers with `chat(reply=…)`, and no card is built (there is no
 * price card kind). The premium note is part of the fact, not model knowledge.
 */

const canvas = (): CanvasContext => ({
  canvasId: "TEST-metal-price", stage: "WORKSPACE",
  viewport: { x: 0, y: 0, zoom: 1 }, focusHistory: [], timeZone: "Asia/Shanghai", cards: [],
});

const credential = { apiKey: "TEST-metal-price-key", models: ["deepseek-flash"],
  defaultModel: "deepseek-flash", checkedAt: new Date().toISOString() };

interface ToolReply { name: string; args: Record<string, unknown> }
interface ChatBody { messages: Array<{ role: string; content: string }> }

/** One scripted batch per model turn; running out throws instead of looping. */
const scriptedToolFetch = (replies: ToolReply[][]) => {
  const calls: ChatBody[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as ChatBody;
    calls.push(body);
    const batch = replies.shift();
    if (!batch) throw new Error("unexpected extra model turn");
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: withReceipt(batch).map((reply, index) => ({
      index, type: "function", function: { name: reply.name, arguments: JSON.stringify(reply.args) },
    })) } }] }), { status: 200, headers: { "content-type": "application/json" } });
  });
  return { fetchImpl, calls };
};

const setup = (replies: ToolReply[][], overrides: Partial<PipelineDeps> = {}) => {
  const credentials = new CredentialStore();
  const { fetchImpl, calls } = scriptedToolFetch(replies);
  const deps: PipelineDeps = { credentials,
    stepfun: { baseUrl: "https://tools.invalid/v1", fetchImpl: fetchImpl as unknown as typeof fetch },
    planner: { provider: "deepseek", connected: true, isCurrent: () => true,
      generate: async () => ({ ok: true, value: { reply: "unused planner" } }) },
    mainProvider: "deepseek", toolCalls: true, toolCredential: credential, ...overrides };
  return { deps, fetchImpl, calls };
};

const cards = (result: IntentResult) =>
  result.envelope?.actions.flatMap(action => action.type === "card.create" ? [action.card] : []) ?? [];

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const goldBody = {
  currency: "USD", currencySymbol: "$", exchangeRate: 1, name: "Gold", symbol: "XAU",
  price: 4129.1, updatedAt: "2026-11-05T03:04:31Z", updatedAtReadable: "a few seconds ago",
};
const fxBody = { result: "success", base_code: "USD", rates: { CNY: 7.1 } };

/** Counts upstream calls and can fail either leg independently. */
const priceFetch = (options: { gold?: boolean; fx?: boolean } = {}) => {
  const calls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url === METAL_PRICE_ENDPOINTS.gold || url === METAL_PRICE_ENDPOINTS.silver) {
      if (options.gold === false) throw new Error("gold source down");
      return json({ ...goldBody, symbol: url === METAL_PRICE_ENDPOINTS.silver ? "XAG" : "XAU",
        price: url === METAL_PRICE_ENDPOINTS.silver ? 51.25 : goldBody.price });
    }
    if (url === FX_ENDPOINT) {
      if (options.fx === false) throw new Error("fx source down");
      return json(fxBody);
    }
    throw new Error(`unexpected URL: ${url}`);
  });
  return { fetchImpl: spy as unknown as typeof fetch, calls, spy };
};

const quoteOf = (result: Awaited<ReturnType<ReturnType<typeof createMetalPriceClient>["price"]>>): MetalPriceQuote => {
  expect(result.kind, JSON.stringify(result)).toBe("ok");
  if (result.kind !== "ok") throw new Error("not a quote");
  return result.quote;
};

describe("metal_price returns verified numbers, not a webpage", () => {
  it("normal: derives CNY per gram from USD/oz and USD/CNY", async () => {
    const upstream = priceFetch();
    const client = createMetalPriceClient({ fetchImpl: upstream.fetchImpl, now: () => Date.parse("2026-11-05T04:00:00Z") });
    const quote = quoteOf(await client.price({ metal: "gold" }));
    expect(quote.priceUsdPerOunce).toBe(4129.1);
    expect(quote.usdCny).toBe(7.1);
    expect(quote.priceCnyPerGram).toBeCloseTo(4129.1 / TROY_OUNCE_GRAMS * 7.1, 2);
    expect(quote.sources).toEqual([METAL_PRICE_ENDPOINTS.gold, FX_ENDPOINT]);
    expect(quote.updatedAt).toBe("2026-11-05T03:04:31.000Z");
    expect(upstream.calls).toEqual([METAL_PRICE_ENDPOINTS.gold, FX_ENDPOINT]);
  });

  it("FX failure: degrades to USD/oz only and says the rate is unavailable", async () => {
    const client = createMetalPriceClient({ fetchImpl: priceFetch({ fx: false }).fetchImpl });
    const quote = quoteOf(await client.price({ metal: "gold" }));
    expect(quote.priceUsdPerOunce).toBe(4129.1);
    expect(quote.priceCnyPerGram).toBeUndefined();
    expect(quote.usdCny).toBeUndefined();
    expect(quote.sources).toEqual([METAL_PRICE_ENDPOINTS.gold]);
  });

  it("both sources down: honest error, no quote invented", async () => {
    const client = createMetalPriceClient({ fetchImpl: priceFetch({ gold: false, fx: false }).fetchImpl });
    const result = await client.price({ metal: "gold" });
    expect(result.kind).toBe("error");
    if (result.kind === "error") {
      expect(result.message).toContain("取不到");
      expect(result.message).not.toContain("http");
    }
  });

  it("caches a complete quote for 60 seconds and never caches a failure", async () => {
    let now = Date.parse("2026-11-05T04:00:00Z");
    const upstream = priceFetch();
    const client = createMetalPriceClient({ fetchImpl: upstream.fetchImpl, now: () => now });
    await client.price();
    await client.price();
    expect(upstream.spy).toHaveBeenCalledTimes(2);
    now += 59_000;
    await client.price();
    expect(upstream.spy).toHaveBeenCalledTimes(2);
    now += 2_000;
    await client.price();
    expect(upstream.spy).toHaveBeenCalledTimes(4);

    // A degraded quote is not cached: the next request retries the rate.
    const degraded = priceFetch({ fx: false });
    const retrying = createMetalPriceClient({ fetchImpl: degraded.fetchImpl, now: () => now });
    await retrying.price();
    await retrying.price();
    expect(degraded.spy).toHaveBeenCalledTimes(4);

    // A total failure is not cached either.
    const failed = priceFetch({ gold: false });
    const failing = createMetalPriceClient({ fetchImpl: failed.fetchImpl, now: () => now });
    await failing.price();
    await failing.price();
    expect(failed.spy).toHaveBeenCalledTimes(4);
  });

  it("validates fields: a non-positive price or rate is a source failure", async () => {
    for (const body of [{ ...goldBody, price: 0 }, { ...goldBody, price: -1 }, { ...goldBody, price: "4129" }]) {
      const fetchImpl = vi.fn(async (input: string | URL | Request) =>
        String(input) === FX_ENDPOINT ? json(fxBody) : json(body));
      const result = await createMetalPriceClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).price();
      expect(result.kind, JSON.stringify(body)).toBe("error");
    }
    // A non-positive rate is an unusable FX leg, so the quote degrades to USD/oz
    // rather than producing a nonsensical CNY/gram.
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      String(input) === FX_ENDPOINT ? json({ result: "success", rates: { CNY: 0 } }) : json(goldBody));
    const degraded = quoteOf(await createMetalPriceClient({ fetchImpl: fetchImpl as unknown as typeof fetch }).price());
    expect(degraded.priceUsdPerOunce).toBe(4129.1);
    expect(degraded.priceCnyPerGram).toBeUndefined();
    expect(degraded.usdCny).toBeUndefined();
    expect(degraded.sources).toEqual([METAL_PRICE_ENDPOINTS.gold]);
  });
});

describe("metal_price is a read-only, single-shot lookup", () => {
  it("defaults to gold/gram and accepts silver", async () => {
    const gold = await planFromToolCalls([{ name: "metal_price", arguments: {} }], canvas(), Date.now(), "查一下金价");
    expect(gold.kind).toBe("lookup");
    expect(gold.lookup).toEqual({ kind: "metal_price", metal: "gold" });
    const silver = await planFromToolCalls([{ name: "metal_price", arguments: { metal: "silver" } }],
      canvas(), Date.now(), "查一下银价");
    expect(silver.lookup).toEqual({ kind: "metal_price", metal: "silver" });
  });

  it("rejects an unsupported metal or unit", async () => {
    for (const args of [{ metal: "copper" }, { unit: "ounce" }, { metal: "gold", unit: "kilogram", extra: 1 }]) {
      const plan = await planFromToolCalls([{ name: "metal_price", arguments: args }], canvas(), Date.now(), "查一下金价");
      expect(plan.kind, JSON.stringify(args)).toBe("invalid");
      expect(plan.issues[0]!.code).toBe("invalid-param");
    }
  });

  it("must stand alone, like search/weather/read_url", async () => {
    const plan = await planFromToolCalls([
      { name: "metal_price", arguments: {} },
      { name: "chat", arguments: { reply: "好的" } },
    ], canvas(), Date.now(), "查一下金价");
    expect(plan.kind).toBe("invalid");
    expect(String(plan.issues[0])).toContain("必须单独调用");
  });
});

describe("the model answers with the fed-back price and no card is built", () => {
  it("feeds CNY/gram, rate, time, sources and the premium note, then answers", async () => {
    const f = setup([
      [{ name: "metal_price", args: {} }],
      [{ name: "chat", args: { reply: "国际金价约 943 元/克，这是汇率折算价，不含国内金店溢价。" } }],
    ]);
    const upstream = priceFetch();
    const client = createMetalPriceClient({ fetchImpl: upstream.fetchImpl });
    const result = await runIntent({ text: "查一下现在黄金多少钱一克", canvasContext: canvas() },
      { ...f.deps, metalPrice: client });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual([]);
    expect(result.envelope?.spokenText).toBe("国际金价约 943 元/克，这是汇率折算价，不含国内金店溢价。");
    const fed = f.calls[1]!.messages.at(-1)!.content;
    expect(fed).toContain("4129.10 美元/盎司");
    expect(fed).toMatch(/折合人民币：\d+\.\d{2} 元\/克/u);
    expect(fed).toContain("1 美元 = 7.1000 人民币");
    expect(fed).toContain("更新时间：2026-11-05T03:04:31.000Z");
    expect(fed).toContain(METAL_PRICE_ENDPOINTS.gold);
    expect(fed).toContain(FX_ENDPOINT);
    expect(fed).toContain("不含国内金店/品牌的加工费与溢价");
    // No host auto-card and no template line.
    expect(result.envelope?.actions.some(action => action.type === "card.create")).toBe(false);
  });

  it("feeds the degraded fact when the FX leg failed and still answers", async () => {
    const f = setup([
      [{ name: "metal_price", args: { metal: "silver" } }],
      [{ name: "chat", args: { reply: "国际银价约 51.25 美元/盎司，汇率暂时取不到，无法折算人民币/克。" } }],
    ]);
    const client = createMetalPriceClient({ fetchImpl: priceFetch({ fx: false }).fetchImpl });
    const result = await runIntent({ text: "现在白银多少钱一克", canvasContext: canvas() },
      { ...f.deps, metalPrice: client });
    expect(result.kind, JSON.stringify(result)).toBe("envelope");
    expect(cards(result)).toEqual([]);
    const fed = f.calls[1]!.messages.at(-1)!.content;
    expect(fed).toContain("51.25 美元/盎司");
    expect(fed).toContain("汇率：不可用");
    expect(fed).not.toContain("折合人民币：");
  });

  it("reports both sources failing as an honest error, not a fake price", async () => {
    const f = setup([[{ name: "metal_price", args: {} }]]);
    const result = await runIntent({ text: "查一下现在黄金多少钱一克", canvasContext: canvas() },
      { ...f.deps, metalPrice: { price: async () => ({ kind: "error",
        message: "实时金价和汇率都取不到（数据源暂时不可用），请稍后再试。" }) } });
    expect(result.kind).toBe("error");
    expect(result.envelope).toBeUndefined();
    expect(result.message).toContain("取不到");
    expect(f.calls).toHaveLength(1);
  });

  it("rejects a knowledge answer built from the price facts and keeps the price card-less", async () => {
    const f = setup([
      [{ name: "metal_price", args: {} }],
      [{ name: "create_card", args: { kind: "answer", fields: { text: "金价约 943 元/克。" } } }],
      [{ name: "chat", args: { reply: "金价约 943 元/克，这是折算价。" } }],
    ]);
    const client = createMetalPriceClient({ fetchImpl: priceFetch().fetchImpl });
    const result = await runIntent({ text: "查一下现在黄金多少钱一克", canvasContext: canvas() },
      { ...f.deps, metalPrice: client });
    expect(result.kind).toBe("envelope");
    expect(cards(result)).toEqual([]);
    expect(result.envelope?.spokenText).toContain("折算价");
  });
});
