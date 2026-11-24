import type { RoadLine } from "@/lib/telematics";
import { thinLine } from "@/lib/geo-line";
import { milesAlong } from "@/lib/telematics";
import { FAIL_TTL_MS, keepRoadRoute, keepWayThere, readRoadRoute, readWayThere } from "@/server/tl/road-route-cache";
import { drive, mapboxConfigured } from "./mapbox";

/**
 * A load's road route, fetched at most once: the one door from a single load's own view (its load page, the truck a dispatcher clicked on the radar) to the directions provider. Never called by a
 * screen that reads many loads (the map's points, the list, the Late chip, the hover): those read the memory only (`readRoadRoute`).
 *
 * Fails soft to `null` (and then no line is drawn and no arrival is worked out: a straight line is never put in its place) when no key is set, when the spend ledger refuses (drive() claims `mapbox_directions` first), when the provider has no route, or when the
 * load has more than 25 placed stops. A failure is remembered for ten minutes; two views asking at the same moment share one request.
 */
const inFlight: Map<string, Promise<RoadLine | null>> = ((globalThis as { __tlRoadRouteFlight?: Map<string, Promise<RoadLine | null>> }).__tlRoadRouteFlight ??= new Map());

const METERS_PER_MILE = 1609.344;

async function roadThrough(points: ReadonlyArray<{ lat: number; lng: number }>): Promise<RoadLine | null> {
  const d = await drive(points.map((s) => ({ label: "", lat: s.lat, lng: s.lng })), { geometry: true });
  if (!d || !d.coords || d.coords.length < 2 || !(d.meters > 0)) return null;
  // Where each named road ends, as a share of the whole: the line's own length and the driven distance differ by a hair.
  let done = 0;
  const roads = (d.roads ?? []).map((r) => ({ name: r.name, until: Math.min(1, (done += r.meters) / d.meters) }));
  return { coords: thinLine(d.coords), miles: d.meters / METERS_PER_MILE, roads };
}

/**
 * The road from where the truck is to the stops still ahead of it: for a truck off its planned route, or one that has not reached its first stop. One is kept a load; a truck following it is on it,
 * so it is asked for again only when the truck has left it, and never within ten minutes of the last time it was asked for.
 */
export async function ensureWayThere(loadId: string, here: { lat: number; lng: number }, ahead: ReadonlyArray<{ lat: number; lng: number }>): Promise<RoadLine | null> {
  if (ahead.length < 1 || ahead.length > 24) return null;
  const kept = readWayThere(loadId, ahead);
  if (kept && (Date.now() - kept.at < FAIL_TTL_MS || (kept.route && milesAlong(here, kept.route)))) return kept.route;
  if (!mapboxConfigured()) return null;
  const key = `way>${loadId}|${ahead.map((s) => `${s.lat},${s.lng}`).join(";")}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    let route: RoadLine | null = null;
    try {
      route = await roadThrough([here, ...ahead]);
    } catch {
      /* none could be had: remembered below, so a busy screen does not ask again */
    }
    keepWayThere(loadId, ahead, route);
    inFlight.delete(key);
    return route;
  })();
  inFlight.set(key, p);
  return p;
}

export async function ensureRoadRoute(loadId: string, stops: ReadonlyArray<{ lat: number; lng: number }>): Promise<RoadLine | null> {
  if (stops.length < 2 || stops.length > 25) return null;
  const kept = readRoadRoute(loadId, stops);
  if (kept !== undefined) return kept;
  if (!mapboxConfigured()) return null; // no key: nothing to remember, a key set later is used at once
  const key = `${loadId}|${stops.length}|${stops.map((s) => `${s.lat},${s.lng}`).join(";")}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      const route = await roadThrough(stops);
      keepRoadRoute(loadId, stops, route);
      return route;
    } catch {
      keepRoadRoute(loadId, stops, null);
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}
