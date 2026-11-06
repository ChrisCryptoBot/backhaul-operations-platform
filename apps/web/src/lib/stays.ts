import { haversineMiles } from "./geo";
import { isStanding, type Fix } from "./whereabouts";

/**
 * Where a tractor has stood and for how long, worked out one fix at a time as the ELD is read. A stay opens when a fix shows the tractor standing, grows while later fixes put it in the same place,
 * and closes when one puts it somewhere else or shows it moving. Stays shorter than STAY_MIN_MINUTES are dropped when they close (a red light, a toll booth), so what is kept is the real record:
 * the yard, the dock, the truck stop, the night off. Raw fixes are only kept a week; stays are what answers "where was this truck, and when" a month later. Pure: no database, no clock.
 */
export const STAY_MIN_MINUTES = 20;
/** Fixes within this many miles of where a stay began are the same stay (GPS wanders, a yard is not one point). */
export const STAY_RADIUS_MILES = 0.25;

export type OpenStay = { id: string; lat: number; lng: number; arrivedAt: number; lastSeenAt: number };
export type StayFix = Pick<Fix, "lat" | "lng" | "speedMph" | "engine"> & { at: number };

export type StayStep =
  /** Nothing to write: moving with no stay open, or a fix older than what the stay already has. */
  | { kind: "none" }
  /** Start a stay here. */
  | { kind: "open"; lat: number; lng: number; at: number }
  /** Still there: move the stay's last-seen time forward. */
  | { kind: "extend"; id: string; at: number }
  /** It has gone: close the stay (`keep` false when it was too short to matter, so the row is removed), and when the fix is itself standing somewhere else, start the next stay. */
  | { kind: "close"; id: string; leftAt: number; keep: boolean; next: { lat: number; lng: number; at: number } | null };

/** Whether a stay that ran from `arrivedAt` to `lastSeenAt` is long enough to keep. */
export const longEnough = (arrivedAt: number, lastSeenAt: number): boolean => lastSeenAt - arrivedAt >= STAY_MIN_MINUTES * 60_000;

/** What one new fix does to a tractor's open stay (or to none). */
export function stepStay(open: OpenStay | null, fix: StayFix): StayStep {
  const standing = isStanding(fix);
  if (!open) return standing ? { kind: "open", lat: fix.lat, lng: fix.lng, at: fix.at } : { kind: "none" };
  if (fix.at <= open.lastSeenAt) return { kind: "none" }; // an old fix, read again or out of order, never moves a stay backwards
  const here = haversineMiles(open, fix) <= STAY_RADIUS_MILES;
  if (standing && here) return { kind: "extend", id: open.id, at: fix.at };
  return { kind: "close", id: open.id, leftAt: fix.at, keep: longEnough(open.arrivedAt, open.lastSeenAt), next: standing ? { lat: fix.lat, lng: fix.lng, at: fix.at } : null };
}
