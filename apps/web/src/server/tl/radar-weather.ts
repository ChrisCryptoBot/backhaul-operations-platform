/**
 * Severe weather for the radar: the National Weather Service's active alerts (free, keyless, public domain), cut down to the severe and extreme ones that have a drawn area. Read at most once every
 * five minutes per server and never for longer than three seconds; any failure (slow, down, a body it cannot read) answers an empty list with `ok: false`, so the map simply has no weather layer.
 * Kept apart from the whereabouts modules on purpose: they make no network call (tests/whereabouts-firewall.test.ts). Nothing here feeds a figure, a verdict or money.
 */
export const NWS_ALERTS_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
/** The NWS asks every caller to name itself. A product name only: no person's address goes out. */
export const NWS_USER_AGENT = "TrueLane-Dispatch-Desk/1 (radar weather)";
export const WEATHER_TTL_MS = 5 * 60_000;
export const WEATHER_TIMEOUT_MS = 3_000;
const SEVERE = new Set(["Severe", "Extreme"]);

type Ring = number[][];
export type WeatherGeometry = { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] };
export type WeatherAlert = { type: "Feature"; geometry: WeatherGeometry; properties: { id: string; event: string; severity: "Severe" | "Extreme"; headline: string | null; expires: string | null } };
export type RadarWeather = { mode: "weather"; ok: boolean; features: WeatherAlert[]; skippedNoShape: number; asOf: string | null };

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);

/** The alerts worth drawing, from the NWS body: severe or extreme, with a Polygon or MultiPolygon; only the five fields the tooltip shows are kept. Zone-only alerts (no geometry) are counted. */
export function readAlerts(body: unknown): { features: WeatherAlert[]; skippedNoShape: number } {
  const raw = body && typeof body === "object" && Array.isArray((body as { features?: unknown }).features) ? ((body as { features: unknown[] }).features) : [];
  const features: WeatherAlert[] = [];
  let skippedNoShape = 0;
  for (const f of raw) {
    if (!f || typeof f !== "object") continue;
    const p = ((f as { properties?: unknown }).properties ?? {}) as Record<string, unknown>;
    const severity = str(p.severity);
    if (!severity || !SEVERE.has(severity)) continue;
    const g = (f as { geometry?: unknown }).geometry as { type?: unknown; coordinates?: unknown } | null | undefined;
    if (!g) {
      skippedNoShape += 1;
      continue;
    }
    if ((g.type !== "Polygon" && g.type !== "MultiPolygon") || !Array.isArray(g.coordinates)) continue;
    features.push({
      type: "Feature",
      geometry: { type: g.type, coordinates: g.coordinates } as WeatherGeometry,
      properties: { id: str(p.id) ?? str((f as { id?: unknown }).id) ?? `alert-${features.length}`, event: str(p.event) ?? "Weather alert", severity: severity as "Severe" | "Extreme", headline: str(p.headline), expires: str(p.expires) ?? str(p.ends) }
    });
  }
  return { features, skippedNoShape };
}

let cache: { at: number; value: RadarWeather } | null = null;

/** For tests: forget the kept answer. */
export function forgetWeather(): void {
  cache = null;
}

export async function radarWeather(deps: { fetch?: typeof fetch; now?: () => number } = {}): Promise<RadarWeather> {
  const now = deps.now?.() ?? Date.now();
  if (cache && now - cache.at < WEATHER_TTL_MS) return cache.value;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await (deps.fetch ?? fetch)(NWS_ALERTS_URL, { signal: ac.signal, headers: { "User-Agent": NWS_USER_AGENT, Accept: "application/geo+json" }, cache: "no-store" });
    if (!res.ok) return { mode: "weather", ok: false, features: [], skippedNoShape: 0, asOf: null };
    const { features, skippedNoShape } = readAlerts(await res.json());
    const value: RadarWeather = { mode: "weather", ok: true, features, skippedNoShape, asOf: new Date(now).toISOString() };
    cache = { at: now, value };
    return value;
  } catch {
    // Slow, offline or unreadable: no weather layer this time; the next request tries again (a failure is not kept).
    return { mode: "weather", ok: false, features: [], skippedNoShape: 0, asOf: null };
  } finally {
    clearTimeout(timer);
  }
}
