import { stateOfAddress, zoneAt, zoneForState, zoneLabel } from "@/truelane/lib/rateCon/stopTime";
import { twelveHour } from "@/lib/clock-12";
import { geocode } from "./mapbox";

/**
 * The time zone a stop's printed time is in. A rate confirmation prints a wall-clock time at the dock ("8:00" in Atlanta, "1:00" in Denver);
 * the desk stores instants, so the zone decides which instant that is. Best source first: the stop's coordinates (a temporary geocode, never
 * stored), then its state when the whole state is one zone, then Central, flagged as assumed so the review says so. Never "the server's
 * clock": a null zone would read in whatever zone the machine running the desk is in.
 */
export const DESK_ZONE = "America/Chicago";

export type StopZone = { zone: string; source: "coordinates" | "state" | "assumed" };

/** The zone from the address text alone: no network, so it is the answer wherever a lookup is not possible. */
export function zoneForAddress(address: string | null | undefined): StopZone {
  const byState = zoneForState(stateOfAddress(address));
  return byState ? { zone: byState, source: "state" } : { zone: DESK_ZONE, source: "assumed" };
}

/** Each stop's zone, in order. A stop that cannot be placed on the map falls back on its own; nothing here throws. */
export async function resolveStopZones(addresses: Array<string | null | undefined>): Promise<StopZone[]> {
  return Promise.all(
    addresses.map(async (address) => {
      const text = (address ?? "").trim();
      const place = text ? await geocode(text) : null;
      const zone = place ? zoneAt(place.lat, place.lng) : null;
      return zone ? { zone, source: "coordinates" as const } : zoneForAddress(text);
    })
  );
}

/** "9:00 AM ET", or "1:00 PM to 4:00 PM MT": the time as the document printed it, with the stop's own zone. Null when no time was printed. */
export function printedLabel(time: string | null | undefined, endTime: string | null | undefined, zone: string): string | null {
  const start = time ? twelveHour(time) : null;
  if (!start) return null;
  const end = endTime ? twelveHour(endTime) : null;
  return `${end ? `${start} to ${end}` : start} ${zoneLabel(zone)}`;
}
