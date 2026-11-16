import { afterEach, describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { createApp, type AppDeps } from "../src/app.js";
import { createDataClient } from "../src/data/index.js";
import { clientIpFrom, normalizeClientIp, peerAddress } from "../src/clientIp.js";
import { authed, emptyContext, testConfig } from "./helpers.js";

const shanghai = { id: 1796236, name: "上海", latitude: 31.22222, longitude: 121.45806,
  country: "中国", country_code: "CN", admin1: "上海市", timezone: "Asia/Shanghai", feature_code: "PPLA" };
const ipRegion = { ip: "203.0.113.7", city: "Shanghai", region: "Shanghai", country: "CN",
  loc: "31.2304,121.4737", org: "AS0 Example", postal: "200000" };
const forecast = () => ({ latitude: 31.25, longitude: 121.5, utc_offset_seconds: 0,
  current_units: { time: "unixtime", temperature_2m: "°C" }, current: {
    time: Math.floor(Date.now() / 1000 / 900) * 900, interval: 900, temperature_2m: 22.4, weather_code: 2, is_day: 1 } });
const fix = () => ({ latitude: 30.27, longitude: 120.16, accuracyM: 35.4, capturedAt: new Date().toISOString() });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const LOOPBACK = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };
const REMOTE = { incoming: { socket: { remoteAddress: "203.0.113.9" } } };
const apps: Array<{ dispose(): void }> = [];

/** Records every provider URL; answers the region, geocoding and forecast shapes. */
function upstream() {
  const calls: string[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/json")) return json(ipRegion);
    if (url.includes("geocoding-api")) return json({ results: [shanghai] });
    if (url.includes("photon")) return json({ features: [{ properties: {
      city: "杭州市", state: "浙江省", country: "中国", countrycode: "CN" } }] });
    return json(forecast());
  });
  return { fetcher, fetchImpl: fetcher as unknown as typeof fetch, calls };
}

function app(deps: Partial<AppDeps> & Pick<AppDeps, "config">) {
  const value = createApp(deps);
  apps.push(value);
  return value;
}

const intent = (appValue: ReturnType<typeof app>, headers: Record<string, string>, body: unknown, env?: unknown) =>
  appValue.request("/api/intent", { method: "POST", headers: { ...authed, ...headers }, body: JSON.stringify(body) }, env);

const createdCard = (result: { envelope?: unknown }) => {
  const parsed = ActionEnvelopeSchema.parse(result.envelope);
  const action = parsed.actions.find(item => item.type === "card.create");
  if (action?.type !== "card.create") throw new Error("Missing card");
  return action.card;
};

afterEach(() => {
  apps.splice(0).forEach(value => value.dispose());
  vi.unstubAllEnvs();
});

describe("client IP boundary", () => {
  it("accepts only IP literals and normalizes mapped/bracketed forms", () => {
    expect(normalizeClientIp(" 1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeClientIp("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeClientIp("[2001:db8::1]")).toBe("2001:db8::1");
    expect(normalizeClientIp("999.1.1.1")).toBeUndefined();
    expect(normalizeClientIp("example.com")).toBeUndefined();
    expect(normalizeClientIp("/1.2.3.4/json")).toBeUndefined();
  });

  it("trusts forwarded headers only from a loopback socket peer", () => {
    const headers = new Headers({ "x-real-ip": "1.2.3.4" });
    expect(clientIpFrom(headers, { peer: "127.0.0.1", trustProxy: true })).toBe("1.2.3.4");
    expect(clientIpFrom(headers, { peer: "::1", trustProxy: true })).toBe("1.2.3.4");
    expect(clientIpFrom(headers, { peer: "::ffff:127.0.0.1", trustProxy: true })).toBe("1.2.3.4");
    expect(clientIpFrom(headers, { peer: "203.0.113.9", trustProxy: true })).toBeUndefined();
    expect(clientIpFrom(headers, { peer: "127.0.0.1", trustProxy: false })).toBeUndefined();
  });

  it("uses the first X-Forwarded-For hop when X-Real-IP is absent or invalid", () => {
    const forwarded = new Headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" });
    expect(clientIpFrom(forwarded, { peer: "127.0.0.1", trustProxy: true })).toBe("1.2.3.4");
    const both = new Headers({ "x-real-ip": "not-an-ip", "x-forwarded-for": "5.6.7.8, 10.0.0.1" });
    expect(clientIpFrom(both, { peer: "127.0.0.1", trustProxy: true })).toBe("5.6.7.8");
  });

  it("reads the Node socket peer from the shapes an adapter may expose", () => {
    expect(peerAddress(LOOPBACK)).toBe("127.0.0.1");
    expect(peerAddress({ server: LOOPBACK })).toBe("127.0.0.1");
    expect(peerAddress(undefined)).toBeUndefined();
  });
});

describe("IP city fallback for weather", () => {
  it("online: a trusted client IP resolves the city and the card says 网络位置", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ mode: "online", config: testConfig(), fetchImpl });
    const response = await intent(value, { "x-vivic-client-ip": "1.2.3.4" }, { text: "天气", canvasContext: emptyContext() });
    const result = await response.json() as { kind: string; envelope?: unknown };
    expect(result.kind).toBe("envelope");
    const card = createdCard(result);
    expect(card.sourceData).toMatchObject({ locationBasis: "network-region-estimate", location: shanghai });
    expect(card.metadata.aliases).toEqual(["上海"]);
    const spoken = (result.envelope as { spokenText?: string }).spokenText;
    expect(spoken).toContain("网络位置");
    expect(calls).toContain("https://ipinfo.io/1.2.3.4/json");
    // The IP itself never reaches the card or the wire.
    expect(JSON.stringify(card)).not.toContain("1.2.3.4");
  });

  it("online: without a trusted IP it still asks for the city and never locates the server", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ mode: "online", config: testConfig(), fetchImpl });
    const result = await (await intent(value, {}, { text: "天气", canvasContext: emptyContext() })).json() as { kind: string };
    expect(result.kind).toBe("clarify");
    expect(calls).toHaveLength(0);
  });

  it("online: an invalid or forged bridge value is ignored", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ mode: "online", config: testConfig(), fetchImpl });
    for (const forged of ["not-an-ip", "1.2.3.4/../../etc", "::gg"]) {
      const result = await (await intent(value, { "x-vivic-client-ip": forged }, { text: "天气", canvasContext: emptyContext() })).json() as { kind: string };
      expect(result.kind).toBe("clarify");
    }
    expect(calls).toHaveLength(0);
  });

  it("local: a loopback peer may forward the visitor's IP", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ config: testConfig(), fetchImpl });
    const result = await (await intent(value, { "x-real-ip": "1.2.3.4" }, { text: "天气", canvasContext: emptyContext() }, LOOPBACK)).json() as { kind: string };
    expect(result.kind).toBe("envelope");
    expect(calls).toContain("https://ipinfo.io/1.2.3.4/json");
  });

  it("local: a non-loopback peer cannot forge X-Real-IP", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ config: testConfig(), fetchImpl });
    const result = await (await intent(value, { "x-real-ip": "1.2.3.4" }, { text: "天气", canvasContext: emptyContext() }, REMOTE)).json() as { kind: string };
    // Local development still falls back to the server's own network, but the
    // forged IP never became the lookup key.
    expect(result.kind).toBe("envelope");
    expect(calls).toContain("https://ipinfo.io/json");
    expect(calls.some(url => url.includes("/1.2.3.4/"))).toBe(false);
  });

  it("local: VIVIC_TRUST_PROXY_IP=off ignores the forwarded header", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ config: testConfig({ trustProxyIp: false }), fetchImpl });
    const result = await (await intent(value, { "x-real-ip": "1.2.3.4" }, { text: "天气", canvasContext: emptyContext() }, LOOPBACK)).json() as { kind: string };
    expect(result.kind).toBe("envelope");
    expect(calls).toContain("https://ipinfo.io/json");
    expect(calls.some(url => url.includes("/1.2.3.4/"))).toBe(false);
  });

  it("a fresh browser fix wins over the IP city", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ config: testConfig(), fetchImpl });
    const result = await (await intent(value, { "x-real-ip": "1.2.3.4" },
      { text: "天气", canvasContext: emptyContext(), deviceLocation: fix() }, LOOPBACK)).json() as { kind: string; envelope?: { spokenText?: string } };
    expect(result.envelope?.spokenText).toBe("已按当前位置显示杭州市天气");
    expect(calls.some(url => url.includes("ipinfo.io"))).toBe(false);
    expect(calls.some(url => url.includes("photon"))).toBe(true);
  });

  it("weather refresh and '我在哪里' use the same trusted IP", async () => {
    const { fetchImpl, calls } = upstream();
    const value = app({ mode: "online", config: testConfig(), fetchImpl });
    const weather = await (await value.request("/api/weather/here", { method: "POST",
      headers: { ...authed, "x-vivic-client-ip": "1.2.3.4" }, body: "{}" })).json() as { kind: string };
    expect(weather.kind).toBe("weather");
    const locale = await (await value.request("/api/locale", { method: "POST",
      headers: { ...authed, "x-vivic-client-ip": "1.2.3.4" }, body: "{}" })).json() as { kind: string; locale?: { basis: string } };
    expect(locale).toMatchObject({ kind: "locale", locale: { basis: "network" } });
    expect(calls.filter(url => url === "https://ipinfo.io/1.2.3.4/json")).toHaveLength(1);
  });
});

describe("per-IP region cache", () => {
  it("keys the 30 minute cache by IP and never reuses another address", async () => {
    const { fetchImpl, calls } = upstream();
    const client = createDataClient({ fetchImpl });
    await client.weatherHere(undefined, undefined, "1.2.3.4");
    await client.weatherHere(undefined, undefined, "1.2.3.4");
    expect(calls.filter(url => url.includes("ipinfo.io"))).toEqual(["https://ipinfo.io/1.2.3.4/json"]);
    await client.weatherHere(undefined, undefined, "5.6.7.8");
    expect(calls.filter(url => url.includes("ipinfo.io"))).toEqual([
      "https://ipinfo.io/1.2.3.4/json", "https://ipinfo.io/5.6.7.8/json"]);
  });

  it("treats an invalid IP as no IP instead of putting it in a URL", async () => {
    const { fetchImpl, calls } = upstream();
    const client = createDataClient({ fetchImpl });
    await client.weatherHere(undefined, undefined, "not-an-ip");
    expect(calls.filter(url => url.includes("ipinfo.io"))).toEqual(["https://ipinfo.io/json"]);
  });

  it("honors VIVIC_IP_REGION_ENDPOINT for per-IP lookups", async () => {
    vi.stubEnv("VIVIC_IP_REGION_ENDPOINT", "https://geo.example/ipinfo/json");
    const { fetchImpl, calls } = upstream();
    const client = createDataClient({ fetchImpl });
    expect(await client.weatherHere(undefined, undefined, "1.2.3.4")).toMatchObject({ kind: "weather", basis: "network" });
    expect(calls[0]).toBe("https://geo.example/ipinfo/1.2.3.4/json");
  });
});
