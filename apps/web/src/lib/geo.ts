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

export type Drive = { meters: number; seconds: number; legsMeters: number[] };

/** The first route in a directions answer, or null when there is none. */
export function parseRoute(json: unknown): Drive | null {
  const route = (json as { routes?: Array<{ distance?: number; duration?: number; legs?: Array<{ distance?: number }> }> } | null)?.routes?.[0];
  if (!route || typeof route.distance !== "number" || typeof route.duration !== "number" || !(route.distance >= 0) || !(route.duration >= 0)) return null;
  return { meters: route.distance, seconds: route.duration, legsMeters: (route.legs ?? []).map((l) => (typeof l.distance === "number" ? l.distance : Number.NaN)) };
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
