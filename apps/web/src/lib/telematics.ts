import { INTERSTATES } from "./basemap/interstates";
import { haversineMiles } from "./geo";
import { compass, nearestOnPolyline, projectOnLine, type LatLng } from "./geo-line";

/**
 * What the ELD's positions mean in money and in words: is a tractor moving under a load, idling, or parked; what an hour of idling burned; how long a trailer has sat and what that owes; whether a
 * truck is inside a stop's geofence; where it is along a lane and when it will get there. Pure: plain data in, plain data out, and a person's typed figure always beats a computed one.
 */

// ── Tractors ────────────────────────────────────────────────────────────────────────────────────

/** A tractor idling burns about a gallon an hour. A fixed, stated figure, never a measurement. */
export const IDLE_GAL_PER_HOUR = 1.0;
/** Under this a truck is standing, whatever the engine says. */
export const MOVING_MPH = 3;

export type EngineState = "moving" | "idle" | "off";
export type TractorState = "moving_load" | "moving" | "idling" | "parked";

export function engineStateOf(raw: string | null | undefined): EngineState | null {
  return raw === "moving" || raw === "idle" || raw === "off" ? raw : null;
}

/** Moving under a load (gold), moving without one, engine on and standing (amber), or engine off (parked). Null with no signal at all. */
export function classifyTractor(t: { engine: EngineState | null; speedMph: number | null; onLoad: boolean }): TractorState | null {
  if (t.engine == null && t.speedMph == null) return null;
  if (t.engine === "off") return "parked";
  if ((t.speedMph ?? 0) >= MOVING_MPH || t.engine === "moving") return t.onLoad ? "moving_load" : "moving";
  return "idling";
}

export type IdleWaste = { gallons: number; cashLost: number | null };

/** Gallons burned idling and what they cost at the fleet's fuel price (null without a price, never a guess). */
export function idleWaste(idleHours: number, pricePerGallon: number | null): IdleWaste {
  const hours = Math.max(0, idleHours);
  const gallons = hours * IDLE_GAL_PER_HOUR;
  return { gallons, cashLost: pricePerGallon == null ? null : gallons * pricePerGallon };
}

/** "3h 14m", "42m", "0m". */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

// ── Trailers ────────────────────────────────────────────────────────────────────────────────────

export type DwellTerms = { freeHours: number; perDay: number };
/** A person's own figure for this stay. Anything left out falls back to the company's. */
export type DwellOverride = { ratePerDay?: number | null; billableDays?: number | null; waived?: boolean | null; by?: string | null; note?: string | null };

export type Dwell = {
  /** Time since the trailer was dropped, in hours and in days. */
  hours: number;
  days: number;
  /** Hours past the free time (0 inside it). */
  overFreeHours: number;
  /** Sitting past the free time with no reload for it: the dwell alert. */
  alert: boolean;
  /** What the company's terms say, before any typed figure. */
  computedDays: number;
  computedRate: number;
  computedAmount: number;
  /** What is owed once a person's figures and a waiver are applied. */
  billableDays: number;
  rate: number;
  amount: number;
  waived: boolean;
  /** Which figures a person typed, so the screen can show them as typed. */
  source: { days: "company" | "typed"; rate: "company" | "typed" };
};

const cents = (n: number) => Math.round(n * 100) / 100;

/**
 * How long a dropped trailer has sat and what that owes. Days past the free time are charged at the day rate, by the hour (4.2 days sitting with 48 hours free is 2.2 days over). A typed rate,
 * typed billable days, or a waiver (the whole fee) beats the company's figures, and never silently: `source` says which is which. Null for a trailer that is hooked or has no drop time.
 */
export function dwell(unhookedAt: Date | number | null | undefined, now: number, terms: DwellTerms, hasReload: boolean, override?: DwellOverride | null): Dwell | null {
  if (unhookedAt == null) return null;
  const since = unhookedAt instanceof Date ? unhookedAt.getTime() : unhookedAt;
  const hours = Math.max(0, (now - since) / 3_600_000);
  const overFreeHours = Math.max(0, hours - terms.freeHours);
  const computedDays = overFreeHours / 24;
  const typedDays = override?.billableDays != null && Number.isFinite(override.billableDays);
  const typedRate = override?.ratePerDay != null && Number.isFinite(override.ratePerDay);
  const billableDays = typedDays ? Math.max(0, override!.billableDays!) : computedDays;
  const rate = typedRate ? Math.max(0, override!.ratePerDay!) : terms.perDay;
  const waived = override?.waived === true;
  return {
    hours,
    days: hours / 24,
    overFreeHours,
    alert: overFreeHours > 0 && !hasReload,
    computedDays: cents(computedDays),
    computedRate: terms.perDay,
    computedAmount: cents(computedDays * terms.perDay),
    billableDays: cents(billableDays),
    rate,
    amount: waived ? 0 : cents(billableDays * rate),
    waived,
    source: { days: typedDays ? "typed" : "company", rate: typedRate ? "typed" : "company" }
  };
}

/** "4.2 days", "1 day", "7 hours". */
export function sittingText(hours: number): string {
  if (hours < 24) return `${Math.floor(hours)} ${Math.floor(hours) === 1 ? "hour" : "hours"}`;
  const d = Math.round((hours / 24) * 10) / 10;
  return `${d} ${d === 1 ? "day" : "days"}`;
}

// ── On the road ─────────────────────────────────────────────────────────────────────────────────

/** Inside this many miles of a stop is "at the facility". */
export const GEOFENCE_MILES = 1;

export function geofence(pos: LatLng, stop: LatLng, miles = GEOFENCE_MILES): { inside: boolean; miles: number } {
  const d = haversineMiles(pos, stop);
  return { inside: d <= miles, miles: d };
}

/** How far along a lane a point is (0 at the origin, 1 at the destination), how many straight-line miles remain, and how far off the straight line it sits. */
export function laneProgress(origin: LatLng, destination: LatLng, pos: LatLng): { fraction: number; remainingStraightMiles: number; offMiles: number } {
  const { fraction, offMiles } = projectOnLine(origin, destination, pos);
  return { fraction, remainingStraightMiles: haversineMiles(origin, destination) * (1 - fraction), offMiles };
}

/** Road miles left: the load's own loaded miles when they are known, else the straight line with a 15 percent road allowance. */
export function milesToGo(fraction: number, loadedMiles: number | null, straightMiles: number): number {
  const total = loadedMiles != null && loadedMiles > 0 ? loadedMiles : straightMiles * 1.15;
  return Math.max(0, total * (1 - fraction));
}

/** When it gets there: now plus the miles left at the speed it is doing (a standing truck is given a typical 55). */
export function etaAt(now: number, milesLeft: number, speedMph: number | null): number {
  const mph = speedMph != null && speedMph >= MOVING_MPH ? speedMph : 55;
  return now + (milesLeft / mph) * 3_600_000;
}

export type ScheduleState = "on_schedule" | "late";

/** Against the delivery window: late once the ETA is past the window's close by more than the grace. Null with no window. */
export function scheduleState(eta: number, windowLatest: Date | number | null | undefined, graceMinutes = 15): ScheduleState | null {
  if (windowLatest == null) return null;
  const close = windowLatest instanceof Date ? windowLatest.getTime() : windowLatest;
  return eta > close + graceMinutes * 60_000 ? "late" : "on_schedule";
}

/** "I-40 E": the nearest bundled interstate corridor within `maxMiles`, with the direction the truck is heading along it. Null off every corridor. */
export function nearestCorridor(pos: LatLng, headingDeg: number | null, maxMiles = 30): string | null {
  let best: { name: string; miles: number; bearing: number } | null = null;
  for (const c of INTERSTATES) {
    const n = nearestOnPolyline(pos, c.coords);
    if (n && n.miles <= maxMiles && (!best || n.miles < best.miles)) best = { name: c.name, ...n };
  }
  if (!best) return null;
  if (headingDeg == null) return best.name;
  // The numbering says which way a route runs: even interstates are east-west, odd ones north-south (I-35 bends northeast near Wichita and is still "N").
  const eastWest = Number(best.name.replace(/\D/g, "")) % 2 === 0;
  const h = (headingDeg * Math.PI) / 180;
  const dir = eastWest ? (Math.sin(h) >= 0 ? "E" : "W") : Math.cos(h) >= 0 ? "N" : "S";
  return `${best.name} ${dir}`;
}

/** "70 MPH · I-80 W" (or "70 MPH · heading NE" off a corridor). */
export function speedLine(speedMph: number | null, pos: LatLng, headingDeg: number | null): string {
  const road = nearestCorridor(pos, headingDeg) ?? (headingDeg != null ? `heading ${compass(headingDeg)}` : null);
  return [speedMph != null ? `${Math.round(speedMph)} MPH` : null, road].filter(Boolean).join(" · ");
}

// ── The HUD ─────────────────────────────────────────────────────────────────────────────────────

export type FleetCounts = { tractors: number; movingLoad: number; moving: number; idling: number; parked: number; noSignal: number; droppedTrailers: number; hookedTrailers: number };

export function fleetCounts(tractors: Array<{ state: TractorState | null }>, trailers: Array<{ hooked: boolean }>): FleetCounts {
  const n = (s: TractorState) => tractors.filter((t) => t.state === s).length;
  return {
    tractors: tractors.length,
    movingLoad: n("moving_load"),
    moving: n("moving"),
    idling: n("idling"),
    parked: n("parked"),
    noSignal: tractors.filter((t) => t.state == null).length,
    droppedTrailers: trailers.filter((t) => !t.hooked).length,
    hookedTrailers: trailers.filter((t) => t.hooked).length
  };
}
