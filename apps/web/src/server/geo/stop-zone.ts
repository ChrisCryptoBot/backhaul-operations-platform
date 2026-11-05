import { stateOfAddress, zoneAt, zoneForState } from "@/truelane/lib/rateCon/stopTime";

/**
 * The clock at a stop (src/lib/tz.ts: stop local time). Best source first: its coordinates (boundary data, right for El Paso and for a state that spans two zones), then its state when the
 * whole state is one zone, then the carrier's own clock, which is what a time with no better answer is read on. Server only: the boundary data is too big for the browser, so a screen is
 * handed the zone as a string. Pure, no network: a stop whose coordinates were never looked up is placed by its state.
 */
export function stopZoneOf(stop: { lat?: unknown; lng?: unknown; addressString?: string | null }, carrierZone: string): string {
  const lat = stop.lat == null ? NaN : Number.parseFloat(String(stop.lat));
  const lng = stop.lng == null ? NaN : Number.parseFloat(String(stop.lng));
  return zoneAt(lat, lng) ?? zoneForState(stateOfAddress(stop.addressString)) ?? carrierZone;
}
