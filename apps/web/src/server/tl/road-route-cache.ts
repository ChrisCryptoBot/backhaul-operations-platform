import type { RoadLine } from "@/lib/telematics";

/**
 * A load's road route, kept in this server's memory only: never written to the database (the directions provider's terms do not allow keeping its routes, and nothing here needs them to
 * outlive a restart). Keyed by the load and the points of its stops in order, so a load whose stops change has no route until one is fetched for the new stops. Bounded like the geocoding
 * memory: at most MAX_ROUTES entries, the oldest dropped first, each kept ROUTE_TTL_MS; a fetch that failed or was refused is remembered FAIL_TTL_MS so a busy screen does not ask again.
 *
 * This module only reads and writes the memory; it makes no call. The one place that fetches is server/geo/road-route.ts (a single load's own view). Every other reader (the map's points, the
 * Late chip, the hover) asks `readRoadRoute`, which never fetches.
 */
export const ROUTE_TTL_MS = 12 * 60 * 60_000;
export const FAIL_TTL_MS = 10 * 60_000;
export const MAX_ROUTES = 300;

type Entry = { at: number; route: RoadLine | null };
const store: Map<string, Entry> = ((globalThis as { __tlRoadRoutes?: Map<string, Entry> }).__tlRoadRoutes ??= new Map());

/** The key for a load and its stop points in order (six places, the stored precision). */
export function routeKey(loadId: string, stops: ReadonlyArray<{ lat: number; lng: number }>): string {
  return `${loadId}|${stops.map((s) => `${s.lat.toFixed(6)},${s.lng.toFixed(6)}`).join(";")}`;
}

/** What is known for these stops: a route, `null` (a recent fetch failed or was refused: do not ask again yet), or `undefined` (nothing kept). Never fetches. */
export function readRoadRoute(loadId: string, stops: ReadonlyArray<{ lat: number; lng: number }>, now = Date.now()): RoadLine | null | undefined {
  const key = routeKey(loadId, stops);
  const e = store.get(key);
  if (!e) return undefined;
  if (now - e.at >= (e.route ? ROUTE_TTL_MS : FAIL_TTL_MS)) {
    store.delete(key);
    return undefined;
  }
  return e.route;
}

/** Keep a route (or a failure, as `null`) for these stops, dropping the oldest entry when full. */
export function keepRoadRoute(loadId: string, stops: ReadonlyArray<{ lat: number; lng: number }>, route: RoadLine | null, now = Date.now()): void {
  const key = routeKey(loadId, stops);
  store.delete(key);
  while (store.size >= MAX_ROUTES) store.delete(store.keys().next().value as string);
  store.set(key, { at: now, route });
}

/** For tests: forget every route. */
export function forgetRoadRoutes(): void {
  store.clear();
}

export const roadRoutesKept = (): number => store.size;
