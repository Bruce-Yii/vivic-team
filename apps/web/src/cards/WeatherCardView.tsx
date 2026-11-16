import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, Moon, Sun, Wind } from "lucide-react";
import { HoverCard } from "radix-ui";
import { styledGenerativeUILibrary } from "@/components/assistant-ui/elements/generative-ui";
import type { WeatherCard } from "./dataCardTypes";
import { renderVivicSpec } from "./vivicGUILibrary";

const conditions = {
  sun: { Icon: Sun, label: "晴" },
  cloud: { Icon: Cloud, label: "多云" },
  rain: { Icon: CloudRain, label: "雨" },
  snow: { Icon: CloudSnow, label: "雪" },
  wind: { Icon: Wind, label: "风" },
  fog: { Icon: CloudFog, label: "雾" },
  storm: { Icon: CloudLightning, label: "雷暴" },
  night: { Icon: Moon, label: "夜间" },
} satisfies Record<WeatherCard["displayProps"]["conditionIcon"], { Icon: typeof Sun; label: string }>;

/**
 * The verified tomorrow row the backend attaches to a forecast card. Only fields
 * the provider actually returned are rendered; anything missing is not shown,
 * and a current-weather card (no `forecastDay`) keeps its previous exact shape.
 */
const forecastOf = (card: WeatherCard): { high: number; low: number; chance?: number } | undefined => {
  const raw = (card.sourceData as Record<string, unknown>).forecastDay;
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as { tempMaxC?: unknown; tempMinC?: unknown; precipitationProbability?: unknown };
  const high = row.tempMaxC, low = row.tempMinC;
  if (typeof high !== "number" || typeof low !== "number" || !Number.isFinite(high) || !Number.isFinite(low)) return undefined;
  const chance = typeof row.precipitationProbability === "number" && Number.isFinite(row.precipitationProbability)
    ? Math.round(row.precipitationProbability) : undefined;
  return { high, low, ...(chance !== undefined ? { chance } : {}) };
};

/** Only measured/forecast temperatures and the contract's Lucide condition icon. */
export const WeatherCardView = ({ card }: { card: WeatherCard }) => {
  const { tempC, conditionIcon } = card.displayProps;
  const condition = Object.hasOwn(conditions, conditionIcon) ? conditions[conditionIcon] : undefined;
  const temperature = Number.isFinite(tempC) && tempC >= -100 && tempC <= 65
    ? `${tempC}°C`
    : "—";
  const forecast = forecastOf(card);
  // A forecast card shows the day's range (and precipitation only when known).
  const value = forecast
    ? [`明天 ${forecast.low}~${forecast.high}°C`, forecast.chance !== undefined ? `降水 ${forecast.chance}%` : ""].filter(Boolean).join("，")
    : temperature;

  const content = styledGenerativeUILibrary.Row!.render({
    $status: "done",
    gap: 3,
    align: "center",
    children: <>
      {condition && <condition.Icon size={28} strokeWidth={1.5} role="img" aria-label={condition.label} />}
      {renderVivicSpec({ _type: "Text", value, size: "2xl", weight: "semibold" })}
    </>,
  });
  if (!card.sources.some(source => source.provider === "open-meteo/forecast")) return content;
  // Place names come from GeoNames for a city lookup, from OpenStreetMap for a device geolocation fix.
  const osm = card.sources.some(source => source.provider === "photon/reverse");
  const geonames = card.sources.some(source => source.provider === "open-meteo/geocoding");
  const placeCredit = osm ? "地名：OpenStreetMap（ODbL）；" : geonames ? "地名：GeoNames；" : "";
  return <HoverCard.Root openDelay={180}>
    <HoverCard.Trigger asChild>
      <a className="nodrag block" href="https://open-meteo.com/en/licence" target="_blank" rel="noopener noreferrer"
        title={`天气：Open-Meteo；${placeCredit}CC BY 4.0。已筛选${forecast ? "明日预报" : "当前"}数据并将天气代码映射为图标。`}
        aria-label={`${value}，${condition?.label ?? "天气"}。查看 Open-Meteo${osm ? " / OpenStreetMap" : geonames ? " / GeoNames" : ""} 数据来源与 CC BY 4.0 许可。`}
        data-vivic-weather-source>{content}</a>
    </HoverCard.Trigger>
    <HoverCard.Portal><HoverCard.Content side="bottom" align="start" sideOffset={8}
      className="z-50 max-w-72 rounded-lg border border-border bg-card p-3 text-xs leading-relaxed text-card-foreground shadow-md"
      data-vivic-weather-attribution>
      <p>天气数据：<a className="underline" href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo</a></p>
      {osm && <p>地名数据：<a className="underline" href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap 贡献者</a>（ODbL），经 Photon 反查</p>}
      {geonames && <p>地名数据：<a className="underline" href="https://www.geonames.org/" target="_blank" rel="noopener noreferrer">GeoNames</a></p>}
      <p><a className="underline" href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener noreferrer">CC BY 4.0</a> · 已筛选{forecast ? "明日预报" : "当前"}字段并将天气代码映射为图标。</p>
    </HoverCard.Content></HoverCard.Portal>
  </HoverCard.Root>;
};
