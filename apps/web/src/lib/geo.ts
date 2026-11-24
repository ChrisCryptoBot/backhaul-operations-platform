/**
 * Places and routes, as plain numbers and labels. The Mapbox calls live on the server (src/server/geo); this file is everything that can be
 * worked out without a network: turning a geocoding feature into the "Dallas, TX" a dispatcher types, reading a directions answer, and splitting
 * a multi-stop route into loaded and mid-trip empty miles by the phone's rule. Pure, so it is tested without a key.
 */
export const METERS_TO_MILES = 1 / 1609.344;

export type Place = { label: string; lat: number; lng: number };

type Feature = {
  text?: string;
  address?: string;
  place_name?: string;
  place_type?: string[];
  /** [longitude, latitude] */
  center?: number[];
  context?: Array<{ id: string; text: string; short_code?: string }>;
};

const inContext = (f: Feature, kind: string) => f.context?.find((c) => c.id.startsWith(`${kind}.`));

/** "US-TX" is Texas; "CA-ON" is Ontario. */
const regionCode = (f: Feature): string | null => {
  const code = inContext(f, "region")?.short_code;
  return code ? code.replace(/^[A-Za-z]{2}-/, "").toUpperCase() : null;
};

/**
 * One geocoding feature as the label the desk uses and its coordinates: "Dallas, TX" for a city, "Dallas, TX 75201" for a zip code,
 * "1600 Pennsylvania Avenue, Lorain, OH 44052" for an address. A feature without a state keeps Mapbox's own name.
 */
export function condenseFeature(f: Feature): Place | null {
  const [lng, lat] = f.center ?? [];
  if (typeof lng !== "number" || typeof lat !== "number" || !f.text) return null;
  const type = f.place_type?.[0];
  const state = regionCode(f);
  const place = type === "place" ? f.text : inContext(f, "place")?.text;
  const zip = type === "postcode" ? f.text : inContext(f, "postcode")?.text;
  let label: string | null = null;
  if (state) {
    if (type === "place") label = `${f.text}, ${state}`;
    else if (type === "postcode") label = `${place ?? f.text}, ${state}${place ? ` ${f.text}` : ""}`;
    else if (type === "address") label = `${f.address ? `${f.address} ` : ""}${f.text}, ${place ?? ""}${place ? ", " : ""}${state}${zip ? ` ${zip}` : ""}`;
    else label = `${f.text}, ${place && place !== f.text ? `${place}, ` : ""}${state}`;
  }
  return { label: label ?? f.place_name ?? f.text, lat, lng };
}

/** The suggestions in a geocoding answer: at most five, one per label. Anything that is not an answer reads as no suggestions. */
export function parseSuggestions(json: unknown, max = 5): Place[] {
  const features = (json as { features?: Feature[] } | null)?.features;
  if (!Array.isArray(features)) return [];
  const seen = new Set<string>();
  const out: Place[] = [];
  for (const f of features) {
    const p = condenseFeature(f);
    if (!p || seen.has(p.label)) continue;
    seen.add(p.label);
    out.push(p);
    if (out.length >= max) break;
  }
  return out;
}

/** A driving route. `coords` (lng, lat pairs along the road) only when the line was asked for (`drive(points, { geometry: true })`). */
export type Drive = { meters: number; seconds: number; legsMeters: number[]; coords?: Array<[number, number]>; /** The roads it runs on, in order, each with how many meters of it. */ roads?: Array<{ name: string; meters: number }> };

/** "I-65" from the directions' "I 65 South" or "I 90; I 94 East" (the first one); a road with no number by its name; "" when it has neither (a ramp). */
export function roadName(ref: unknown, name: unknown): string {
  const first = typeof ref === "string" ? (ref.split(/[;/]/)[0] ?? "").trim() : "";
  const m = /^([A-Za-z]{1,3})[\s-]*(\d+[A-Za-z]?)\b/.exec(first);
  if (m) return `${m[1]!.toUpperCase()}-${m[2]!.toUpperCase()}`;
  return first || (typeof name === "string" ? name.trim() : "");
}

/** The first route in a directions answer, or null when there is none. The road line is kept only when it is a well-formed GeoJSON LineString. */
export function parseRoute(json: unknown): Drive | null {
  const route = (json as { routes?: Array<{ distance?: number; duration?: number; legs?: Array<{ distance?: number; steps?: Array<{ distance?: number; ref?: unknown; name?: unknown }> }>; geometry?: { type?: unknown; coordinates?: unknown } }> } | null)?.routes?.[0];
  if (!route || typeof route.distance !== "number" || typeof route.duration !== "number" || !(route.distance >= 0) || !(route.duration >= 0)) return null;
  const out: Drive = { meters: route.distance, seconds: route.duration, legsMeters: (route.legs ?? []).map((l) => (typeof l.distance === "number" ? l.distance : Number.NaN)) };
  const c = route.geometry?.type === "LineString" ? route.geometry.coordinates : null;
  if (Array.isArray(c) && c.length >= 2 && c.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[1] as number) <= 90 && Math.abs(p[0] as number) <= 180)) {
    out.coords = c.map((p) => [(p as number[])[0]!, (p as number[])[1]!] as [number, number]);
    const roads: Array<{ name: string; meters: number }> = [];
    for (const step of (route.legs ?? []).flatMap((l) => l.steps ?? [])) {
      if (typeof step.distance !== "number" || !(step.distance > 0)) continue;
      const name = roadName(step.ref, step.name);
      const last = roads[roads.length - 1];
      if (last && last.name === name) last.meters += step.distance;
      else roads.push({ name, meters: step.distance });
    }
    if (roads.length > 0) out.roads = roads;
  }
  return out;
}

// ── Loaded and empty miles ─────────────────────────────────────────────────────────────────────

export type StopRole = "pickup" | "delivery";
export type LegKind = "loaded" | "empty";

/** One entry per leg: empty only when the leg leaves a delivery and arrives at a pickup (the phone's rule). Pickups-first routes have none. */
export function legKinds(roles: readonly StopRole[]): LegKind[] {
  const kinds: LegKind[] = [];
  for (let i = 0; i + 1 < roles.length; i += 1) kinds.push(roles[i] === "delivery" && roles[i + 1] === "pickup" ? "empty" : "loaded");
  return kinds;
}

export type RouteMiles = { loadedMiles: number; emptyMidMiles: number; routeMiles: number };

/**
 * Splits a route total into loaded and mid-trip empty miles. The total is the directions total, not a re-sum of the legs, so a route
 * with no empty leg returns it bit for bit; if the legs do not line up with the stops, everything stays loaded.
 */
export function splitRouteMiles(p: { totalMeters: number; legsMeters: readonly number[]; roles: readonly StopRole[] }): RouteMiles {
  const routeMiles = p.totalMeters * METERS_TO_MILES;
  const kinds = legKinds(p.roles);
  const usable = kinds.length === p.legsMeters.length && p.legsMeters.every((m) => Number.isFinite(m) && m >= 0);
  const emptyMeters = usable ? p.legsMeters.reduce((sum, m, i) => (kinds[i] === "empty" ? sum + m : sum), 0) : 0;
  if (emptyMeters === 0) return { loadedMiles: routeMiles, emptyMidMiles: 0, routeMiles };
  return { loadedMiles: Math.max(0, p.totalMeters - emptyMeters) * METERS_TO_MILES, emptyMidMiles: emptyMeters * METERS_TO_MILES, routeMiles };
}

export const roundMiles = (n: number): number => Math.round(n * 10) / 10;
export const roundHours = (n: number): number => Math.round(n * 100) / 100;

/** The hours a drive of `routeMiles` took, for just the loaded part of it, at the same average speed. */
export function loadedLegHours(routeSeconds: number, routeMiles: number, loadedMiles: number): number {
  if (!(routeMiles > 0) || !(routeSeconds > 0)) return 0;
  return roundHours((routeSeconds / 3600) * (loadedMiles / routeMiles));
}

/** A stop is worth looking up once it has enough typed to be a place (the form does not ask the map about "d"). */
export const addressReady = (address: string): boolean => address.trim().length >= 3;

/** Straight-line miles between two points (great circle). For ranking which trucks are near a pickup, never for pricing a mile. */
export function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.7613 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Which truck bases to measure by road: the nearest ones to the pickup that have a stored point, then a few without (found by address). A fleet of thousands cannot be
 * measured truck by truck on every keystroke, and a base hundreds of miles away is not the one the dispatcher will pick.
 */
export function nearestHomes<T extends { point?: { lat: number; lng: number } | null; address: string }>(homes: readonly T[], from: { lat: number; lng: number }, nearest = 40, unlocated = 5): T[] {
  const withPoint = homes.filter((h) => h.point).sort((a, b) => haversineMiles(a.point!, from) - haversineMiles(b.point!, from));
  const without = homes.filter((h) => !h.point && h.address.trim() !== "");
  return [...withPoint.slice(0, nearest), ...without.slice(0, unlocated)];
}
