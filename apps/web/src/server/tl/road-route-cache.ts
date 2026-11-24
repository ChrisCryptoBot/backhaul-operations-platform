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
/** All the points kept together: a coast-to-coast road is tens of thousands, so the routes are bounded by their size as well as their count. */
export const MAX_POINTS = 1_000_000;

type Entry = { at: number; route: RoadLine | null };
const size = (e: Entry | undefined): number => e?.route?.coords.length ?? 0;
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
  put(key, { at: now, route });
}

function put(key: string, e: Entry): void {
  store.delete(key);
  let points = size(e);
  for (const v of store.values()) points += size(v);
  while (store.size > 0 && (store.size >= MAX_ROUTES || points > MAX_POINTS)) {
    const oldest = store.keys().next().value as string;
    points -= size(store.get(oldest));
    store.delete(oldest);
  }
  store.set(key, e);
}

/** The way there: the road from where the truck was to the stops still ahead of it, for a truck that is off its planned route or has not reached its first stop. Kept like a planned route, and at most one a load. */
const wayKey = (loadId: string, ahead: ReadonlyArray<{ lat: number; lng: number }>): string => `way>${routeKey(loadId, ahead)}`;

/** What is kept for these stops ahead and when it was asked for; undefined when nothing is. Never fetches. */
export function readWayThere(loadId: string, ahead: ReadonlyArray<{ lat: number; lng: number }>, now = Date.now()): Entry | undefined {
  const e = store.get(wayKey(loadId, ahead));
  return e && now - e.at < ROUTE_TTL_MS ? e : undefined;
}

export function keepWayThere(loadId: string, ahead: ReadonlyArray<{ lat: number; lng: number }>, route: RoadLine | null, now = Date.now()): void {
  put(wayKey(loadId, ahead), { at: now, route });
}

/** Whether there is room for routes nobody asked to see yet: under four fifths full, so fetching them never pushes out the ones already kept (which would then be fetched again, and again). */
export function roomToWarm(): boolean {
  let points = 0;
  for (const v of store.values()) points += size(v);
  return store.size < MAX_ROUTES * 0.8 && points < MAX_POINTS * 0.8;
}

/** For tests: forget every route. */
export function forgetRoadRoutes(): void {
  store.clear();
}

export const roadRoutesKept = (): number => store.size;
