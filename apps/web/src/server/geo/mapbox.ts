import { parseRoute, parseSuggestions, type Drive, type Place } from "@/lib/geo";

/**
 * The desk's one door to Mapbox. Server only: the token is read from the environment here and never reaches the browser. Every call fails soft
 * (an empty list, or null), so a missing key, a timeout or an outage leaves the form working on typed values.
 *
 * Mapbox's terms matter here. Suggestions and measuring use the temporary geocoding endpoint and nothing they return is stored. A coordinate
 * that is kept (a stop's lat/lng) comes from the permanent endpoint, once, after the save (see persist.ts).
 */
const BASE = "https://api.mapbox.com";
const TIMEOUT_MS = 8000;
const TYPES = "place,address,postcode,locality";

const token = (): string => process.env.MAPBOX_ACCESS_TOKEN ?? "";

/** True when a key is set, so the form can say live lookup is on or off. */
export const mapboxConfigured = (): boolean => token() !== "";

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function geocodeUrl(endpoint: "mapbox.places" | "mapbox.places-permanent", text: string, limit: number, autocomplete: boolean): string {
  const q = new URLSearchParams({ access_token: token(), limit: String(limit), country: "us,ca", types: TYPES, autocomplete: String(autocomplete) });
  return `${BASE}/geocoding/v5/${endpoint}/${encodeURIComponent(text)}.json?${q.toString()}`;
}

/** Up to five places for what is being typed ("dal" gives Dallas, TX first). */
export async function suggestPlaces(query: string): Promise<Place[]> {
  const text = query.trim();
  if (text.length < 2 || !mapboxConfigured()) return [];
  return parseSuggestions(await getJson(geocodeUrl("mapbox.places", text, 5, true)));
}

// A short-lived memory of lookups: measuring a quote geocodes the same few truck bases again and again as the form is edited.
const MEMORY_MS = 60 * 60 * 1000;
const MEMORY_MAX = 300;
const memory = new Map<string, { at: number; place: Place | null }>();

/** The best match for a finished address or city, or null. Temporary results: used to measure, never stored. */
export async function geocode(address: string): Promise<Place | null> {
  const text = address.trim();
  if (text.length < 2 || !mapboxConfigured()) return null;
  const key = text.toLowerCase();
  const hit = memory.get(key);
  if (hit && Date.now() - hit.at < MEMORY_MS) return hit.place;
  const place = parseSuggestions(await getJson(geocodeUrl("mapbox.places", text, 1, false)), 1)[0] ?? null;
  if (place) {
    if (memory.size >= MEMORY_MAX) memory.delete(memory.keys().next().value as string);
    memory.set(key, { at: Date.now(), place });
  }
  return place;
}

/** As `geocode`, from the permanent endpoint, for a coordinate that will be stored. */
export async function geocodePermanent(address: string): Promise<Place | null> {
  const text = address.trim();
  if (text.length < 2 || !mapboxConfigured()) return null;
  return parseSuggestions(await getJson(geocodeUrl("mapbox.places-permanent", text, 1, false)), 1)[0] ?? null;
}

/** The driving route through two to twenty-five points, in order. */
export async function drive(points: readonly Place[]): Promise<Drive | null> {
  if (points.length < 2 || points.length > 25 || !mapboxConfigured()) return null;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const q = new URLSearchParams({ access_token: token(), overview: "false" });
  return parseRoute(await getJson(`${BASE}/directions/v5/mapbox/driving/${coords}?${q.toString()}`));
}
