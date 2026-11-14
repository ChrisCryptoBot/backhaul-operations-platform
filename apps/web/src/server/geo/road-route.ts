import type { RoadLine } from "@/lib/telematics";
import { keepRoadRoute, readRoadRoute } from "@/server/tl/road-route-cache";
import { drive, mapboxConfigured } from "./mapbox";

/**
 * A load's road route, fetched at most once: the one door from a single load's own view (its load page, the truck a dispatcher clicked on the radar) to the directions provider. Never called by a
 * screen that reads many loads (the map's points, the list, the Late chip, the hover): those read the memory only (`readRoadRoute`).
 *
 * Fails soft to `null` (and the straight lane is used) when no key is set, when the spend ledger refuses (drive() claims `mapbox_directions` first), when the provider has no route, or when the
 * load has more than 25 placed stops. A failure is remembered for ten minutes; two views asking at the same moment share one request.
 */
const inFlight: Map<string, Promise<RoadLine | null>> = ((globalThis as { __tlRoadRouteFlight?: Map<string, Promise<RoadLine | null>> }).__tlRoadRouteFlight ??= new Map());

const METERS_PER_MILE = 1609.344;

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
      const d = await drive(stops.map((s) => ({ label: "", lat: s.lat, lng: s.lng })), { geometry: true });
      const route: RoadLine | null = d && d.coords && d.coords.length >= 2 && d.meters > 0 ? { coords: d.coords, miles: d.meters / METERS_PER_MILE } : null;
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
