import { DESK_TZ } from "./zoned";

/**
 * Checks on a rate confirmation after it was read and before it becomes a load. A reader can be confidently wrong about things that look fine:
 * which stop comes first, whether the last stop is a delivery, which day it is. None of those is a missing field, so each is a check on the
 * plan, at one of two levels:
 *
 *   confirm  the dispatcher must tick "I checked the stops and their order" before saving (stops out of order, wrong ends, three or more stops);
 *   caution  shown, never blocks (an appointment already in the past, a window that ends before it opens, no appointment, no miles).
 *
 * These follow the shape of the phone's own review checks without vendoring them: the phone's file sits on the Community precheck module
 * (1,387 lines) and a closure of another eight, and it carries rate-per-mile bands tuned for drivers. Pure.
 */
export type CheckLevel = "confirm" | "caution";
export type Check = { id: string; level: CheckLevel; text: string };

export type CheckStop = { stopType: string; addressString: string; timeWindowEarliest: string | null; timeWindowLatest: string | null };
export type CheckInput = { stops: CheckStop[]; loadedMiles: number | null; nowMs?: number };

const DAY = 24 * 60 * 60 * 1000;

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** "Dallas, TX" from "123 Main St, Dallas, TX 75201"; the address as typed when it does not parse. */
const place = (address: string): string => {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const state = parts[parts.length - 1]?.match(/^([A-Z]{2})\b/)?.[1];
  return state && parts.length >= 2 ? `${parts[parts.length - 2]}, ${state}` : address.trim() || "no address";
};

const name = (s: CheckStop, i: number) => `Stop ${i + 1} (${place(s.addressString)})`;
const day = (t: number) => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: DESK_TZ });

/** The first stop that is wholly before an earlier stop's window, as a pair of indexes, or null. */
export function firstOutOfOrder(stops: readonly CheckStop[]): [number, number] | null {
  for (let j = 1; j < stops.length; j++) {
    const lateJ = ms(stops[j]!.timeWindowLatest ?? stops[j]!.timeWindowEarliest);
    if (lateJ == null) continue;
    for (let i = 0; i < j; i++) {
      const earlyI = ms(stops[i]!.timeWindowEarliest);
      if (earlyI != null && lateJ < earlyI) return [i, j];
    }
  }
  return null;
}

export function rateConChecks(input: CheckInput): Check[] {
  const { stops } = input;
  const now = input.nowMs ?? Date.now();
  const out: Check[] = [];
  if (stops.length === 0) return out;

  const pair = firstOutOfOrder(stops);
  if (pair) out.push({ id: "order", level: "confirm", text: `${name(stops[pair[1]]!, pair[1])} is due before ${name(stops[pair[0]]!, pair[0])}. Is the order of the stops right?` });
  if (stops[0]!.stopType !== "pickup") out.push({ id: "first", level: "confirm", text: `The first stop is a delivery (${place(stops[0]!.addressString)}). A load starts at a pickup.` });
  if (stops.length > 1 && stops[stops.length - 1]!.stopType !== "delivery") out.push({ id: "last", level: "confirm", text: `The last stop is a pickup (${place(stops[stops.length - 1]!.addressString)}). A load ends at a delivery.` });
  if (stops.length >= 3) out.push({ id: "many", level: "confirm", text: `This load has ${stops.length} stops. Check each one, and their order, against the document.` });

  const first = ms(stops[0]!.timeWindowEarliest);
  if (first != null && first < now - DAY) out.push({ id: "past", level: "caution", text: `The first appointment is ${day(first)}, already in the past. Is the date, or the year, right?` });
  stops.forEach((s, i) => {
    const a = ms(s.timeWindowEarliest);
    const b = ms(s.timeWindowLatest);
    if (a != null && b != null && b < a) out.push({ id: `window${i}`, level: "caution", text: `${name(s, i)} has a window that ends before it opens.` });
    if (a == null && b == null) out.push({ id: `appt${i}`, level: "caution", text: `${name(s, i)} has no appointment time. The planner and the late alerts cannot place it.` });
  });
  if (!(input.loadedMiles != null && input.loadedMiles > 0)) out.push({ id: "miles", level: "caution", text: "The document prints no miles, so this load has no per-mile figure yet." });
  return out;
}

/** Whether a reviewer has to tick the stops box before saving. */
export const needsStopCheck = (checks: readonly Check[]): boolean => checks.some((c) => c.level === "confirm");
