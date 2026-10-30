import { loadedLegHours, nearestHomes, roundMiles, splitRouteMiles, METERS_TO_MILES, type Place, type StopRole } from "@/lib/geo";
import { drive, geocode, mapboxConfigured } from "./mapbox";

/**
 * Measuring a quote: the loaded miles and drive hours of its route, the empty miles in the middle of it, and for every truck with a base the
 * empty miles from the base to the pickup and from the last delivery back. Everything is a suggestion the form fills only where nobody typed.
 */
export type MeasureInput = {
  stops: Array<{ address: string; role: StopRole }>;
  /** `point` is the base's stored coordinates when there are some, so it is not looked up again. */
  homes: Array<{ id: string; address: string; point?: Place | null }>;
};

export type TruckMiles = { toPickup: number | null; home: number | null };

export type Measured =
  | {
      ok: true;
      loadedMiles: number;
      /** Empty driving between a delivery and the next pickup, inside the route. It is counted as empty miles, never dropped. */
      emptyMidMiles: number;
      /** Drive time for the loaded miles alone, at the route's own average speed. */
      loadedHours: number;
      perTruck: Record<string, TruckMiles>;
    }
  | { ok: false; error: string };

const MEASURE_AT_ONCE = 8;
const miles = (meters: number) => roundMiles(meters * METERS_TO_MILES);

async function legMiles(from: Place | null, to: Place | null): Promise<number | null> {
  if (!from || !to) return null;
  const d = await drive([from, to]);
  return d ? miles(d.meters) : null;
}

export async function measureQuote(input: MeasureInput): Promise<Measured> {
  if (!mapboxConfigured()) return { ok: false, error: "Live lookup is off: no Mapbox key is set. Type the miles." };
  if (input.stops.length < 2) return { ok: false, error: "Add a pickup and a delivery to measure it." };
  const found = await Promise.all(input.stops.map((s) => geocode(s.address)));
  const missing = found.map((p, i) => (p ? null : input.stops[i]!.address.trim())).filter((x): x is string => x != null);
  if (missing.length > 0) return { ok: false, error: `Could not find ${missing.join(" or ")}. Pick it from the list, or type the miles.` };
  const points = found as Place[];

  const route = await drive(points);
  if (!route) return { ok: false, error: "The map could not drive that route. Type the miles." };
  const split = splitRouteMiles({ totalMeters: route.meters, legsMeters: route.legsMeters, roles: input.stops.map((s) => s.role) });

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const perTruck: Record<string, TruckMiles> = {};
  // The nearest bases only, a few at a time: each one costs two map requests, and a big fleet has thousands of bases.
  const chosen = nearestHomes(input.homes, first);
  for (let i = 0; i < chosen.length; i += MEASURE_AT_ONCE) {
    await Promise.all(
      chosen.slice(i, i + MEASURE_AT_ONCE).map(async (h) => {
        if (h.address.trim() === "") return;
        const base = h.point ?? (await geocode(h.address));
        const [toPickup, home] = await Promise.all([legMiles(base, first), legMiles(last, base)]);
        perTruck[h.id] = { toPickup, home };
      })
    );
  }

  return {
    ok: true,
    loadedMiles: roundMiles(split.loadedMiles),
    emptyMidMiles: roundMiles(split.emptyMidMiles),
    loadedHours: loadedLegHours(route.seconds, split.routeMiles, split.loadedMiles),
    perTruck
  };
}

