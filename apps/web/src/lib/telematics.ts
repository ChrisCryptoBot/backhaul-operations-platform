import { haversineMiles } from "./geo";
import { alongPolyline, compass, type LatLng } from "./geo-line";

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

/** "3h 14m", "42m", "0m". Exact at any length: it words a stay in a truck's history and an idle episode beside its gallons and cash, where a rounded day would hide hours. */
export function durationText(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}

/** The same length for a person scanning, in days past two of them: "3h 14m", "10 days". For an age or a table cell only, never for time that backs a figure. */
export function ageWords(minutes: number): string {
  const m = Math.max(0, Math.floor(minutes));
  return m >= 48 * 60 ? `${Math.floor(m / (24 * 60))} days` : durationText(m);
}

/** "no fix yet", "just now", "42 min ago", "3h 14m ago", "10 days ago". */
export function agoText(at: string | null | undefined, now: number): string {
  if (!at) return "no fix yet";
  const m = Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${ageWords(m)} ago`;
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

/** A road route: the points along the road (lng, lat pairs), its driven miles, and the roads it runs on with the share of the way each one ends at. */
export type RoadLine = { coords: ReadonlyArray<readonly [number, number]>; miles: number; roads?: ReadonlyArray<{ name: string; until: number }> };
/** What the road line and its miles rest on, said wherever they are shown: standard car directions, not truck routing. */
export const ROAD_ROUTE_NOTE = "Car route — check truck restrictions. The road line and miles left follow standard Mapbox driving directions (mapbox/driving), not truck routing (no bridge heights or weight limits).";
/** Why there is no road line or arrival. */
export const NO_ROAD_NOTE = "No road route for this load yet, so no line is drawn and no arrival is worked out.";
export const OFF_ROAD_NOTE = "The truck is off its road route and the road from where it is could not be had yet, so no arrival is worked out.";

/** Farther than this from a road line, a truck is not on it (a detour, a yard, a bad fix). */
export const OFF_ROUTE_MILES = 2;

/** Miles left along a road route for a truck on it (within OFF_ROUTE_MILES), with the road it is on there; null when it is not on it. */
export function milesAlong(here: LatLng, road: RoadLine): { miles: number; roadName: string | null } | null {
  if (!(road.miles > 0)) return null;
  const at = alongPolyline(here, road.coords);
  if (!at || !(at.totalMiles > 0) || at.offMiles > OFF_ROUTE_MILES) return null;
  const share = at.alongMiles / at.totalMiles;
  // The road is named only for a fix that is on the road itself, not merely near the route.
  const named = at.offMiles <= 0.25 ? (road.roads?.find((r) => share <= r.until)?.name ?? "") : "";
  return { miles: Math.max(0, road.miles * (1 - share)), roadName: named || null };
}

/**
 * The stops still ahead of a truck on this load, by what is recorded: the ones after the last with an arrival. A load under way has left its first stop. Never empty: the last stop is always ahead
 * until the load is done. `approaching` is true while the first stop is still ahead and the truck is not at it (the planned route starts there, so it is not on it yet).
 */
export function stopsAhead<T extends LatLng & { arrivedAt: Date | string | null }>(status: string, stops: readonly T[], here: LatLng): { ahead: T[]; approaching: boolean } {
  let from = 0;
  stops.forEach((s, i) => {
    if (s.arrivedAt != null) from = i + 1;
  });
  if (status === "in_progress") from = Math.max(from, 1);
  from = Math.min(from, Math.max(0, stops.length - 1));
  return { ahead: stops.slice(from), approaching: from === 0 && stops.length > 0 && !geofence(here, stops[0]!).inside };
}

/**
 * Miles left on a load, on a road or not at all: along the planned route when the truck is on it (and past its first stop), else along the way there from where it was. Null with neither, and then
 * nothing is said: a straight line is never an arrival.
 */
export function roadMilesLeft(i: { here: LatLng; approaching: boolean; planned: RoadLine | null | undefined; way: RoadLine | null | undefined }): { miles: number; roadName: string | null; road: RoadLine } | null {
  for (const road of i.approaching ? [i.way] : [i.planned, i.way]) {
    const left = road ? milesAlong(i.here, road) : null;
    if (road && left) return { ...left, road };
  }
  return null;
}

/**
 * Whether a truck will make its last stop's window: late once the window has closed and it is not there (that needs only the clock), else by the arrival on the road miles left. Null when it is at
 * the destination, when the stop has no window, or when there are no road miles and the window is still open.
 */
export function roadSchedule(i: { here: LatLng; destination: LatLng; milesLeft: number | null; speedMph: number | null; windowLatest: Date | number | null | undefined; now: number }): ScheduleState | null {
  if (geofence(i.here, i.destination).inside) return null;
  if (scheduleState(i.now, i.windowLatest) === "late") return "late";
  return i.milesLeft == null ? null : scheduleState(etaAt(i.now, i.milesLeft, i.speedMph), i.windowLatest);
}

/** "I-40 E": a numbered road with the way the truck is heading along it (even interstates and US routes run east-west, odd ones north-south). Any other road is its name alone. */
export function roadHeading(name: string | null | undefined, headingDeg: number | null): string | null {
  if (!name) return null;
  const n = /^(?:I|US)-(\d+)$/.exec(name);
  if (!n || headingDeg == null) return name;
  const h = (headingDeg * Math.PI) / 180;
  const dir = Number(n[1]) % 2 === 0 ? (Math.sin(h) >= 0 ? "E" : "W") : Math.cos(h) >= 0 ? "N" : "S";
  return `${name} ${dir}`;
}

/** "70 MPH · I-80 W", or "70 MPH · heading NE" when the road is not known. The road is the load's own route's, never a guess from the map. */
export function speedLine(speedMph: number | null, roadName: string | null, headingDeg: number | null): string {
  const road = roadHeading(roadName, headingDeg) ?? (headingDeg != null ? `heading ${compass(headingDeg)}` : null);
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
