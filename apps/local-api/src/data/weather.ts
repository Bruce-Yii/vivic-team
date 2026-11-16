import { z } from "zod";
import type { EvidenceRef } from "@vivic/contracts";
import { DataError, FORECAST_ENDPOINT, GEOCODING_ENDPOINT, readProviderJson } from "./transport.js";
import { distanceKm, reversePlace, type DevicePosition, type DeviceRegion, type PositionPlace } from "./deviceRegion.js";

const safeName = z.string().trim().min(1).max(100).refine(value => !/[\p{Cc}\p{Cf}<>]/u.test(value));
const LocationSchema = z.object({
  id: z.number().int().positive(), name: safeName, latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180), country: safeName, country_code: z.string().regex(/^[A-Z]{2}$/),
  admin1: safeName.optional(), admin2: safeName.optional(), timezone: z.string().min(1).max(100),
  feature_code: z.string().min(1).max(10),
  /** GeoNames population; absent for most villages. Only used to rank candidates. */
  population: z.number().int().nonnegative().optional(),
});
const GeocodingSchema = z.object({ results: z.array(LocationSchema).max(10).optional(), error: z.literal(false).optional() });
// A region search spans countries, and one foreign row missing a field must not void the page.
const RowsSchema = z.object({ results: z.array(z.unknown()).max(10).optional(), error: z.literal(false).optional() });
/**
 * The provider's daily strip. Every series is optional and every value may be
 * null: a field the provider did not return is dropped by the parser, never
 * defaulted to a made-up number.
 */
const DailySchema = z.object({
  time: z.array(z.number().int().positive().max(10_000_000_000)).max(8).optional(),
  temperature_2m_max: z.array(z.number().min(-100).max(65).nullable()).max(8).optional(),
  temperature_2m_min: z.array(z.number().min(-100).max(65).nullable()).max(8).optional(),
  weather_code: z.array(z.number().int().nullable()).max(8).optional(),
  precipitation_probability_max: z.array(z.number().min(0).max(100).nullable()).max(8).optional(),
});
const ForecastSchema = z.object({
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  utc_offset_seconds: z.literal(0),
  current_units: z.object({ time: z.literal("unixtime"), temperature_2m: z.literal("°C") }),
  current: z.object({ time: z.number().int().positive().max(10_000_000_000), interval: z.number().int().min(1).max(3600),
    temperature_2m: z.number().min(-100).max(65), weather_code: z.number().int(), is_day: z.union([z.literal(0), z.literal(1)]) }),
  daily: DailySchema.optional(),
});
export type WeatherLocation = z.infer<typeof LocationSchema>;
/** A device geolocation fix (already rounded to ~1 km) with its city-level name. */
export type PositionLocation = PositionPlace & { latitude: number; longitude: number; accuracyM: number; capturedAt: string };
export type ConditionIcon = "sun" | "cloud" | "rain" | "snow" | "fog" | "storm" | "night";
/** One provider daily row the card may render. A row missing max, min or code is
 *  skipped instead of being completed with a guess. */
export interface ForecastDay {
  /** YYYY-MM-DD, the provider's (GMT) calendar day. */
  date: string;
  tempMaxC: number;
  tempMinC: number;
  weatherCode: number;
  conditionIcon: ConditionIcon;
  /** 0–100; absent when the provider returned no probability. */
  precipitationProbability?: number;
}
/** Days ahead the verified adapter can serve (0 = today, 1..6 = forecast).
 *  The card still carries the provider strip as evidence. */
export type WeatherDay = number;
/** How the card's city was chosen: the browser fix, the connection's city, or
 *  a city the user named (no `basis`). */
export type WeatherBasis = "device" | "network";
export interface WeatherEvidence {
  kind: "weather"; tempC: number; conditionIcon: ConditionIcon; location: WeatherLocation | PositionLocation;
  basis?: WeatherBasis;
  observedAt: string; fetchedAt: string; weatherCode: number; isDay: boolean; intervalSeconds: number;
  modelGrid: { latitude: number; longitude: number }; sources: EvidenceRef[];
  /** Set when the request asked for a forecast day rather than current conditions. */
  day?: WeatherDay;
  /** The subject of a forecast card; absent when the provider had no usable row
   *  (the card then honestly falls back to current conditions). */
  forecastDay?: ForecastDay;
  /** The provider's daily strip, when it returned one. Evidence only. */
  forecast?: ForecastDay[];
}
export type WeatherResult = WeatherEvidence | { kind: "clarify"; message: string; candidates: WeatherLocation[] };
const withBasis = (result: WeatherResult, basis: WeatherBasis): WeatherResult =>
  result.kind === "weather" ? { ...result, basis } : result;

export const CitySchema = z.string().trim().min(2).max(100)
  .refine(value => /^[\p{L}\p{M}\p{N} .,'’\-，]+$/u.test(value) && value.split(/[,，]/).length <= 2);

/** WMO codes from the official forecast docs; unknown codes never default to sun. */
export function conditionIcon(code: number, isDay: boolean): ConditionIcon {
  if (code === 0 || code === 1) return isDay ? "sun" : "night";
  if ([2, 3].includes(code)) return "cloud";
  if ([45, 48].includes(code)) return "fog";
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return "rain";
  if ([71, 73, 75, 77, 85, 86].includes(code)) return "snow";
  if ([95, 96, 97, 99].includes(code)) return "storm";
  throw new DataError("invalid-response");
}

/** The provider daily window: current conditions stay unchanged, the extra days
 *  are requested so "明天" can be answered from the same verified call. */
const FORECAST_DAYS = 7;
const DAILY_FIELDS = "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max";
const iconOf = (code: number): ConditionIcon | null => { try { return conditionIcon(code, true); } catch { return null; } };

/** Daily rows the card can show, in date order. Missing values never default. */
const forecastDays = (daily: z.infer<typeof DailySchema> | undefined): ForecastDay[] => {
  if (!daily?.time?.length) return [];
  const days: ForecastDay[] = [];
  for (let index = 0; index < Math.min(daily.time.length, FORECAST_DAYS); index += 1) {
    const time = daily.time[index];
    const high = daily.temperature_2m_max?.[index];
    const low = daily.temperature_2m_min?.[index];
    const code = daily.weather_code?.[index];
    if (typeof time !== "number" || typeof high !== "number" || typeof low !== "number"
      || typeof code !== "number" || high < low) continue;
    const icon = iconOf(code);
    if (!icon) continue;
    const chance = daily.precipitation_probability_max?.[index];
    days.push({ date: new Date(time * 1000).toISOString().slice(0, 10), tempMaxC: high, tempMinC: low,
      weatherCode: code, conditionIcon: icon,
      ...(typeof chance === "number" ? { precipitationProbability: Math.round(chance) } : {}) });
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
};

/** The location's own timezone when it is known, so "明天" is the location's day. */
const zoneOf = (location: WeatherLocation | PositionLocation, fallback?: string): string =>
  ("timezone" in location && location.timezone) || fallback || "UTC";

const dayIn = (at: number, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(new Date(at));
  } catch { return new Date(at).toISOString().slice(0, 10); }
};
const addIsoDays = (iso: string, days: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Administrative level of a GeoNames feature, highest first. PPLC is a national
 * capital, PPLA a first-order (province/state) seat, PPLA2 a second-order seat;
 * ADM* are the administrative areas themselves. A plain PPL is a village.
 */
const featureTier = (code: string): number =>
  code === "PPLC" ? 6
    : code === "PPLA" || code === "ADM1" ? 5
      : code === "PPLA2" || code === "ADM2" ? 4
        : code === "PPLA3" || code === "ADM3" ? 3
          : /^PPLA[45]$/u.test(code) ? 2
            : /^(?:PPL|ADM4)$/u.test(code) ? 1 : 0;

/** One place, not one provider row: the same name with the same admin chain and
 *  country is the same place, even when GeoNames returns a PPL and an ADM row. */
const placeKey = (row: WeatherLocation, normalize: (value: string) => string): string =>
  [row.name, row.admin1 ?? "", row.admin2 ?? "", row.country_code].map(normalize).join("\u0000");

const populationOf = (row: WeatherLocation): number => row.population ?? 0;

/** Larger is more likely to be the place the user means. */
const rankPlaces = (rows: WeatherLocation[]): WeatherLocation[] => [...rows].sort((a, b) =>
  featureTier(b.feature_code) - featureTier(a.feature_code)
  || populationOf(b) - populationOf(a)
  || a.name.localeCompare(b.name));

/**
 * The single place the sentence refers to, when the ranking makes that safe:
 * one candidate, a strictly higher administrative level, or a population lead of
 * at least 2×. Everything else is a real tie and stays a question (sc-21 used to
 * ask among three rows, two of which were the same place).
 */
const dominantPlace = (sorted: WeatherLocation[]): WeatherLocation | undefined => {
  const [best, next] = sorted;
  if (!best) return undefined;
  if (!next) return best;
  if (featureTier(best.feature_code) > featureTier(next.feature_code)) return best;
  // A missing population never wins on population alone.
  if (!best.population) return undefined;
  const second = populationOf(next);
  return best.population >= 20_000 && best.population >= second * 2 ? best : undefined;
};

/** At most three *distinct* places in a question the user can answer. */
const placeLabels = (rows: WeatherLocation[], normalize: (value: string) => string): string[] => {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const row of rankPlaces(rows)) {
    const label = [...new Set([row.name, row.admin1, row.country].filter((value): value is string => Boolean(value)))].join(" / ");
    const key = normalize(label);
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
    if (labels.length === 3) break;
  }
  return labels;
};

export async function lookupWeather(city: string, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}, day?: WeatherDay, now = Date.now()): Promise<WeatherResult> {
  const parsed = CitySchema.safeParse(city);
  if (!parsed.success) return { kind: "clarify", message: "请明确一个城市；同名地点可写成「上海,上海市天气」。", candidates: [] };
  const [rawName, qualifier] = parsed.data.replace(/，/g, ",").split(",");
  const name = rawName!.trim().replace(/市$/, "");
  const query = qualifier === undefined ? name : `${name},${qualifier.trim()}`;
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/市$/, "").trim();
  const geoUrl = new URL(GEOCODING_ENDPOINT);
  geoUrl.search = new URLSearchParams({ name: query, count: "10", language: /\p{Script=Han}/u.test(query) ? "zh" : "en", format: "json" }).toString();
  const geo = await readProviderJson(geoUrl, GeocodingSchema, options);
  const geoFetchedAt = new Date().toISOString();
  // Match verified place identity; never choose simply by ordering or GPS. The
  // ranking below only breaks same-name ties, and only when it is decisive.
  const matched = (geo.results ?? []).filter(row => normalize(row.name) === normalize(name)
    && /^(?:PPL[A-Z0-9]*|ADM[1-4])$/.test(row.feature_code));
  let candidates = [...new Map(matched.map(row => [placeKey(row, normalize), row] as const)).values()];
  if (qualifier) candidates = candidates.filter(row => [row.admin1, row.admin2, row.country, row.country_code]
    .some(value => value && normalize(value) === normalize(qualifier)));
  // A municipality named explicitly by the user is a city, not every village
  // sharing its name. Keep using provider-verified coordinates and attribution.
  if (!qualifier && ["上海", "北京", "天津", "重庆"].includes(name)) {
    const municipality = candidates.filter(row => row.country_code === "CN" && row.admin1
      && normalize(row.admin1) === normalize(name) && /^(?:PPLC|PPLA|ADM1)$/.test(row.feature_code));
    if (municipality.length === 1) candidates = municipality;
  }
  const winner = dominantPlace(rankPlaces(candidates));
  if (!winner) {
    const labels = placeLabels(candidates, normalize);
    return { kind: "clarify", candidates, message: candidates.length
      ? `找到多个同名或近似地点：${labels.join("；")}。请补充省州或国家，如「城市,省州天气」。`.slice(0, 400)
      : "没有找到明确的城市，请补充城市名、省州或国家。" };
  }
  // A full result page can still hide further same-name places; keep asking for a
  // narrower search in that case. (The live provider returns 3 rows for 南京, so
  // this guard does not turn sc-21 back into a question.)
  if (geo.results?.length === 10) return { kind: "clarify", candidates, message: "地点匹配过多，请补充省州或国家。" };
  return currentWeatherAt(winner, geoNamesSource(geoUrl, geoFetchedAt), options, day, now);
}
const geoNamesSource = (url: URL, fetchedAt: string): EvidenceRef =>
  ({ title: "Open-Meteo geocoding · GeoNames", url: url.href, fetchedAt, provider: "open-meteo/geocoding", readFullPage: false });

/**
 * Weather exactly at the device's (rounded) position. The name is only a
 * label: if reverse geocoding fails the weather is still real, shown as 当前位置.
 */
export async function lookupWeatherAt(position: DevicePosition, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}, day?: WeatherDay, now = Date.now(), timeZone?: string): Promise<WeatherResult> {
  let place: PositionPlace | null = null, placeSource: EvidenceRef | null = null;
  try {
    const reverse = await reversePlace(position, options, "default");
    place = reverse.place;
    if (place) placeSource = { title: "Photon reverse geocoding · OpenStreetMap", url: reverse.url.href,
      fetchedAt: new Date().toISOString(), provider: "photon/reverse", readFullPage: false };
  } catch (error) {
    if (options.signal.aborted) throw error;
  }
  const location: PositionLocation = { ...(place ?? { name: "当前位置" }), latitude: position.latitude,
    longitude: position.longitude, accuracyM: Math.round(position.accuracyM), capturedAt: position.capturedAt };
  return withBasis(await currentWeatherAt(location, placeSource, options, day, now, timeZone), "device");
}

/** Nearest verified GeoNames place to the network estimate; the estimate itself is never used as coordinates. */
const NEAR_REGION_KM = 60;
export async function lookupWeatherNear(region: DeviceRegion, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}, day?: WeatherDay, now = Date.now(), timeZone?: string): Promise<WeatherResult> {
  const geoUrl = new URL(GEOCODING_ENDPOINT);
  geoUrl.search = new URLSearchParams({ name: region.city, count: "10", language: "zh", format: "json" }).toString();
  const geo = await readProviderJson(geoUrl, RowsSchema, options);
  const geoFetchedAt = new Date().toISOString();
  const nearest = (geo.results ?? []).flatMap(row => { const parsed = LocationSchema.safeParse(row); return parsed.success ? [parsed.data] : []; })
    .filter(row => row.country_code === region.country && /^(?:PPL[A-Z0-9]*|ADM[1-4])$/.test(row.feature_code))
    .map(row => ({ row, km: distanceKm(row, region) })).filter(({ km }) => km <= NEAR_REGION_KM)
    .sort((a, b) => a.km - b.km)[0];
  if (!nearest) return { kind: "clarify", candidates: [], message: deviceRegionPrompt };
  return withBasis(await currentWeatherAt(nearest.row, geoNamesSource(geoUrl, geoFetchedAt), options, day, now, timeZone), "network");
}
export const deviceRegionPrompt = "暂时无法确定所在城市，请直接说城市名，例如「上海天气」。";

async function currentWeatherAt(location: WeatherLocation | PositionLocation, placeSource: EvidenceRef | null, options: {
  signal: AbortSignal; maxBytes: number; fetchImpl: typeof fetch;
}, day?: WeatherDay, now = Date.now(), fallbackZone?: string): Promise<WeatherResult> {
  const forecastUrl = new URL(FORECAST_ENDPOINT);
  forecastUrl.search = new URLSearchParams({ latitude: String(location.latitude), longitude: String(location.longitude),
    current: "temperature_2m,weather_code,is_day", daily: DAILY_FIELDS, temperature_unit: "celsius", timezone: "GMT",
    timeformat: "unixtime", forecast_days: String(FORECAST_DAYS) }).toString();
  const forecast = await readProviderJson(forecastUrl, ForecastSchema, options);
  const fetchedAt = new Date().toISOString();
  const observedAt = new Date(forecast.current.time * 1000).toISOString();
  const age = now - forecast.current.time * 1000;
  if (age > 3 * 3600_000 || age < -15 * 60_000) throw new DataError("invalid-response");
  const days = forecastDays(forecast.daily);
  // "明天" is the location's own tomorrow, not the server's: the provider strip
  // is in GMT dates, so the requested date is derived in the place's timezone.
  const wanted = typeof day === "number" ? addIsoDays(dayIn(now, zoneOf(location, fallbackZone)), day) : undefined;
  const selected = wanted ? days.find(entry => entry.date === wanted) : undefined;
  return { kind: "weather", location, tempC: forecast.current.temperature_2m,
    conditionIcon: conditionIcon(forecast.current.weather_code, forecast.current.is_day === 1), observedAt, fetchedAt,
    weatherCode: forecast.current.weather_code, isDay: forecast.current.is_day === 1, intervalSeconds: forecast.current.interval,
    modelGrid: { latitude: forecast.latitude, longitude: forecast.longitude }, sources: [
      ...(placeSource ? [placeSource] : []),
      { title: day ? "Open-Meteo daily forecast (model data)" : "Open-Meteo current weather (model data)",
        url: forecastUrl.href, fetchedAt, provider: "open-meteo/forecast", readFullPage: false },
    ],
    ...(day ? { day } : {}),
    ...(selected ? { forecastDay: selected } : {}),
    ...(days.length ? { forecast: days } : {}) };
}
