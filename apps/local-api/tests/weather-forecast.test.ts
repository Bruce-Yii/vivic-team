import { describe, expect, it, vi } from "vitest";
import { ActionEnvelopeSchema } from "@vivic/contracts";
import { handleDataIntent, weatherCardFields } from "../src/data/index.js";
import { lookupWeather } from "../src/data/weather.js";
import { parseWeatherInput } from "../src/data/weatherInput.js";
import { emptyContext } from "./helpers.js";

/**
 * Tomorrow's weather from the same verified Open-Meteo adapter.
 *
 * The provider request now asks for a seven-day daily strip; a "明天" request
 * selects the location's own tomorrow from it. Nothing is defaulted: a missing
 * `daily` block degrades to the previous current-weather card, a row without
 * max/min/code is skipped, and a missing precipitation probability is simply
 * absent. These fixtures are synthetic; no live provider is called.
 */

const NOW = Date.parse("2026-11-04T02:00:00Z"); // 10:00 in Asia/Shanghai
const nanjing = { id: 1799963, name: "南京", latitude: 32.06167, longitude: 118.77778, country: "中国",
  country_code: "CN", admin1: "江苏", timezone: "Asia/Shanghai", feature_code: "ADM2", population: 9_314_685 };
const unix = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const DATES = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"];
const daily = () => ({
  time: DATES.map(unix),
  // 11-06 has no max: that row must be skipped rather than completed by the host.
  temperature_2m_max: [22.1, 21.4, null, 19.2, 18.0, 17.6, 17.0],
  temperature_2m_min: [14.2, 12.1, 11.4, 10.8, 10.2, 9.9, 9.4],
  weather_code: [3, 61, 3, 45, 1, 0, 2],
  precipitation_probability_max: [20, 35, 40, 15, null, 0, 5],
});
const forecast = (extra: Record<string, unknown> = {}) => ({
  latitude: 32.06, longitude: 118.78, utc_offset_seconds: 0,
  current_units: { time: "unixtime", temperature_2m: "°C" },
  current: { time: Math.floor(NOW / 1000 / 900) * 900, interval: 900, temperature_2m: 18.4, weather_code: 3, is_day: 1 },
  daily: daily(),
  ...extra,
});
const stub = (value: unknown) => vi.fn(async (input: string | URL | Request) => Response.json(
  String(input).includes("geocoding") ? { results: [nanjing] } : value));

describe("Open-Meteo daily forecast", () => {
  it("requests a seven-day window and parses tomorrow's verified row", async () => {
    const fetchImpl = stub(forecast());
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024,
      fetchImpl: fetchImpl as unknown as typeof fetch }, 1, NOW);
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.day).toBe(1);
    // 2026-11-05 in the city's own timezone, not "index 1 in GMT".
    expect(result.forecastDay).toMatchObject({ date: "2026-11-05", tempMaxC: 21.4, tempMinC: 12.1,
      weatherCode: 61, conditionIcon: "rain", precipitationProbability: 35 });
    // The null max on 11-06 is skipped; the other six rows survive.
    expect(result.forecast?.map(day => day.date)).toEqual(["2026-11-04", "2026-11-05", "2026-11-07",
      "2026-11-08", "2026-11-09", "2026-11-10"]);
    const params = new URL(String(fetchImpl.mock.calls[1]![0])).searchParams;
    expect(params.get("forecast_days")).toBe("7");
    expect(params.get("daily")).toBe("temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max");
    // Current conditions are still requested exactly as before.
    expect(params.get("current")).toBe("temperature_2m,weather_code,is_day");
  });

  it("picks tomorrow in the place's timezone, not the server's", async () => {
    // 2026-11-03T20:00Z is already 11-04 in Shanghai, so the local tomorrow is
    // 11-05 while the GMT daily window (as the provider returns it) starts on 11-03.
    const localNow = Date.parse("2026-11-03T20:00:00Z");
    const dates = ["2026-11-03", ...DATES];
    const base = forecast();
    // Shift the whole strip one day: time and values must stay aligned.
    const value = { ...base, current: { ...base.current, time: Math.floor(localNow / 1000 / 900) * 900 },
      daily: { time: dates.map(unix),
        temperature_2m_max: [22.0, ...base.daily.temperature_2m_max!],
        temperature_2m_min: [14.0, ...base.daily.temperature_2m_min!],
        weather_code: [3, ...base.daily.weather_code!],
        precipitation_probability_max: [20, ...base.daily.precipitation_probability_max!] } };
    const result = await lookupWeather("南京", { signal: new AbortController().signal,
      maxBytes: 128 * 1024, fetchImpl: stub(value) as unknown as typeof fetch }, 1, localNow);
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.forecastDay?.date).toBe("2026-11-05");
  });

  it("degrades to the current weather card when the provider has no daily data", async () => {
    // A request for tomorrow must never invent a forecast: the previous, verified
    // current-weather card is shown and the spoken line says the forecast is missing.
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024,
      fetchImpl: stub(forecast({ daily: undefined })) as unknown as typeof fetch }, 1, NOW);
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.day).toBe(1);
    expect(result.forecastDay).toBeUndefined();
    expect(result.forecast).toBeUndefined();
    const fields = weatherCardFields(result, "南京");
    expect(fields.displayProps).toEqual({ tempC: 18.4, conditionIcon: "cloud" });
    expect(fields.sourceData).not.toHaveProperty("forecastDay");
    expect(fields.spokenText).toContain("没取到");
    expect(fields.spokenText).toContain("当前天气");
  });

  it("drops a tomorrow row the provider left incomplete instead of guessing", async () => {
    const value = forecast();
    const partial = { ...value, daily: { ...value.daily,
      temperature_2m_max: [22.1, null, 20, 19.2, 18.0, 17.6, 17.0] } };
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024,
      fetchImpl: stub(partial) as unknown as typeof fetch }, 1, NOW);
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.forecastDay).toBeUndefined();
    expect(result.forecast).toHaveLength(6);
  });

  it("keeps current-weather cards byte-for-byte compatible", async () => {
    const result = await lookupWeather("南京", { signal: new AbortController().signal, maxBytes: 128 * 1024,
      fetchImpl: stub(forecast()) as unknown as typeof fetch }, undefined, NOW);
    expect(result.kind).toBe("weather");
    if (result.kind !== "weather") return;
    expect(result.day).toBeUndefined();
    expect(result.forecastDay).toBeUndefined();
    const fields = weatherCardFields(result, "南京");
    expect(fields.displayProps).toEqual({ tempC: 18.4, conditionIcon: "cloud" });
    expect(fields.spokenText).toBe("已显示南京当前天气");
    expect(fields.sourceData).not.toHaveProperty("forecastDay");
  });
});

describe("明天 weather requests", () => {
  it("parses 明天 as the forecast day and keeps 后天 out of scope", () => {
    expect(parseWeatherInput("明天南京天气")).toEqual({ kind: "weather", city: "南京", day: 1 });
    expect(parseWeatherInput("南京明天天气")).toEqual({ kind: "weather", city: "南京", day: 1 });
    expect(parseWeatherInput("明天天气")).toEqual({ kind: "here", day: 1 });
    expect(parseWeatherInput("南京天气")).toEqual({ kind: "weather", city: "南京" });
    expect(parseWeatherInput("南京后天天气")).toEqual({ kind: "weather", city: "南京", day: 2 });
  });

  it("builds a WeatherCard that carries tomorrow's row and says so", async () => {
    const fetchImpl = stub(forecast());
    const result = await handleDataIntent("明天南京天气", emptyContext(), undefined,
      // The adapter receives the city and the day; the fixture transports the
      // provider responses (geocoding + one seven-day forecast call).
      { weather: async (city, signal, day) => {
        expect(city).toBe("南京");
        expect(day).toBe(1);
        return lookupWeather(city, { signal: signal ?? new AbortController().signal, maxBytes: 128 * 1024,
          fetchImpl: fetchImpl as unknown as typeof fetch }, day, NOW);
      } });
    expect(result?.kind).toBe("envelope");
    const envelope = ActionEnvelopeSchema.parse(result?.envelope);
    const create = envelope.actions.find(action => action.type === "card.create");
    if (create?.type !== "card.create") throw new Error("missing weather card");
    expect(create.card.type).toBe("WeatherCard");
    expect(create.card.displayProps).toEqual({ tempC: 21.4, conditionIcon: "rain" });
    expect(create.card.sourceData).toMatchObject({ requestedCity: "南京",
      forecastDay: { date: "2026-11-05", tempMaxC: 21.4, tempMinC: 12.1, precipitationProbability: 35 } });
    expect(envelope.spokenText).toBe("已显示南京明天天气");
  });
});
