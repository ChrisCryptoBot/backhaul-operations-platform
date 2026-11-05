import { haversineMiles } from "./geo";

/**
 * Radius search on the fleet: which units are within so many miles of a point, nearest first, the box to ask the database for before measuring exactly, and the circle the map draws. Straight-line
 * miles (the great circle), the same measure the rest of the desk uses for nearness (`haversineMiles`). Pure.
 */
export type LatLng = { lat: number; lng: number };

export const RADII = [10, 25, 50, 100, 250] as const;
export const DEFAULT_RADIUS = 50;
export const MAX_RADIUS = 1000;

/** A radius as typed or sent in a URL: a whole number of miles from 1 to 1,000, or the default. */
export function clampRadius(v: unknown): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RADIUS;
  return Math.max(1, Math.min(MAX_RADIUS, Math.round(n)));
}

const MI_PER_DEG_LAT = 69.0;
const rad = (d: number) => (d * Math.PI) / 180;

/** The latitude and longitude box that holds every point within `miles` of the centre (a little generous, so the exact test never drops a unit the box let go). */
export function boundsAround(c: LatLng, miles: number): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const dLat = miles / MI_PER_DEG_LAT;
  const cos = Math.max(0.01, Math.cos(rad(c.lat)));
  const dLng = miles / (MI_PER_DEG_LAT * cos);
  return { minLat: c.lat - dLat, maxLat: c.lat + dLat, minLng: c.lng - dLng, maxLng: c.lng + dLng };
}

/** The items within `miles` of the centre, nearest first, each with its distance. The box is tried first so a fleet of thousands is not measured one by one. */
export function within<T extends LatLng>(items: readonly T[], centre: LatLng, miles: number): Array<{ item: T; miles: number }> {
  const b = boundsAround(centre, miles);
  const out: Array<{ item: T; miles: number }> = [];
  for (const item of items) {
    if (item.lat < b.minLat || item.lat > b.maxLat || item.lng < b.minLng || item.lng > b.maxLng) continue;
    const d = haversineMiles(centre, item);
    if (d <= miles) out.push({ item, miles: d });
  }
  return out.sort((a, b) => a.miles - b.miles);
}

/** A ring of [lng, lat] points around the centre, for the map to draw the search ring. Closed (the first point repeated). */
export function radiusRing(c: LatLng, miles: number, steps = 72): Array<[number, number]> {
  const ring: Array<[number, number]> = [];
  const cos = Math.max(0.01, Math.cos(rad(c.lat)));
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([c.lng + (miles / (MI_PER_DEG_LAT * cos)) * Math.sin(a), c.lat + (miles / MI_PER_DEG_LAT) * Math.cos(a)]);
  }
  ring.push(ring[0]!);
  return ring;
}

/** "23 units (14 trucks, 9 trailers)". */
export function countsText(trucks: number, trailers: number): string {
  const n = trucks + trailers;
  return `${n} ${n === 1 ? "unit" : "units"} (${trucks} ${trucks === 1 ? "truck" : "trucks"}, ${trailers} ${trailers === 1 ? "trailer" : "trailers"})`;
}

/** "4 mi", "0.4 mi" (under 10 miles keeps a tenth). */
export const milesText = (m: number): string => (m < 10 ? `${(Math.round(m * 10) / 10).toString()} mi` : `${Math.round(m).toLocaleString("en-US")} mi`);

/** Units that sit at the same place (to about 100 metres) share a key, so a yard or a shipper's dock reads as one group. */
export const siteKey = (c: LatLng): string => `${c.lat.toFixed(3)},${c.lng.toFixed(3)}`;
