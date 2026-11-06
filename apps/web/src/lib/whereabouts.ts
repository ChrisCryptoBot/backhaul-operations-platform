import { haversineMiles, METERS_TO_MILES } from "./geo";
import { compass } from "./geo-line";
import { MOVING_MPH, durationText, nearestCorridor, type EngineState } from "./telematics";

/**
 * Where a truck or trailer is, in words a dispatcher can act on: at a facility the desk already knows from a load's stops, near a town, on a highway, or just a point. Pure: plain data in, plain
 * data out. The town lookup is passed in (the server hands over the offline gazetteer) so this file stays light enough for a browser to import.
 *
 * Rules, borrowed from how the phone app tags a place (docs/tabs/community/design/slices/PLACES_SLICE.md):
 *  - "At" a facility means within 300 metres AND standing. A wrong facility is worse than none, so a truck passing a dock at 60 mph is "near" it, never "at" it.
 *  - Otherwise the nearest town speaks, in the same tiers the phone uses: within 5 miles "near", within 25 "within 25 mi of", past that its distance.
 *  - Nothing here calls a map provider and nothing here feeds a figure, a ranking or a verdict: it is display only.
 */

/** A stop on file with a name and a point: where a load has picked up or delivered. */
export type KnownStop = { name: string; lat: number; lng: number };

/** The last position an ELD (or a person) gave for a unit. */
export type Fix = {
  lat: number;
  lng: number;
  speedMph: number | null;
  engine: EngineState | null;
  headingDeg: number | null;
  locatedAt: Date | string | number | null;
  /** A dropped trailer is standing by definition; pass true. Left out, the speed and engine decide. */
  standing?: boolean;
};

export type Town = (lat: number, lng: number, maxMiles: number) => { label: string; miles: number } | null;

export type Tier = "at" | "near_stop" | "near" | "around" | "town" | "point";

export type Whereabouts = {
  tier: Tier;
  /** The one line: "At Acme Foods, Memphis, TN", "Near Dallas, TX", "On I-40 E, within 25 mi of Amarillo, TX". */
  label: string;
  /** The facility, when the unit is at or right next to one. */
  facility: string | null;
  /** The nearest town, "Memphis, TN", when one is within range. */
  town: string | null;
  /** The closest stop on file within 5 miles that is not already the label, with its distance. */
  nearestStop: { name: string; miles: number } | null;
  /** Highway and heading, only while it is moving (a standing unit's "road" would be a guess). */
  road: string | null;
  standing: boolean;
  /** "32.7767, -96.7970". */
  coords: string;
  ageMinutes: number | null;
  /** "4m ago", "2h 10m ago", or null with no time. */
  ageText: string | null;
  /** Older than STALE_MINUTES: the screen should say the position may have moved. */
  stale: boolean;
};

/** "At" a facility: 300 metres, the same reach the phone uses to match a dock. */
export const AT_MILES = 300 * METERS_TO_MILES;
export const NEAR_MILES = 5;
export const AROUND_MILES = 25;
export const TOWN_MAX_MILES = 60;
/** A fix older than this is called out as possibly moved. */
export const STALE_MINUTES = 90;

/** "62 MPH". */
export const mphText = (mph: number): string => `${Math.round(mph)} MPH`;

export const coordsText = (lat: number, lng: number): string => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;

const toMs = (v: Fix["locatedAt"]): number | null => {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

const roundMi = (m: number): number => (m < 10 ? Math.round(m * 10) / 10 : Math.round(m));

/** Whether the unit is standing: the caller's word first, then the speed, then the engine. A fix with neither is treated as standing (the safe side for a facility label). */
export function isStanding(f: Pick<Fix, "speedMph" | "engine" | "standing">): boolean {
  if (f.standing != null) return f.standing;
  if (f.speedMph != null) return f.speedMph < MOVING_MPH;
  if (f.engine != null) return f.engine !== "moving";
  return true;
}

/** The closest named stop and how far, or null. Blank names are never a place. */
export function closestStop(at: { lat: number; lng: number }, stops: readonly KnownStop[], withinMiles: number): { stop: KnownStop; miles: number } | null {
  let best: { stop: KnownStop; miles: number } | null = null;
  for (const s of stops) {
    if (!s.name.trim()) continue;
    const miles = haversineMiles(at, s);
    if (miles <= withinMiles && (!best || miles < best.miles || (miles === best.miles && s.name < best.stop.name))) best = { stop: s, miles };
  }
  return best;
}

/** "I-40 E · 62 MPH" style road text for a moving unit, else null. */
function roadOf(f: Fix, standing: boolean): string | null {
  if (standing) return null;
  return nearestCorridor({ lat: f.lat, lng: f.lng }, f.headingDeg) ?? (f.headingDeg != null ? `heading ${compass(f.headingDeg)}` : null);
}

/**
 * Where the unit is. `stops` are the facilities on file near it (the caller narrows them to a box); `town` is the gazetteer lookup. Never throws on a missing piece: with no stop and no town it
 * still answers with the point.
 */
export function whereIs(f: Fix, stops: readonly KnownStop[], town: Town | null, now: number): Whereabouts {
  const standing = isStanding(f);
  const here = { lat: f.lat, lng: f.lng };
  const t = town ? town(f.lat, f.lng, TOWN_MAX_MILES) : null;
  const townLabel = t?.label ?? null;
  // A facility's town is only named when the town is close enough to be the facility's town.
  const facilityTown = t && t.miles <= AROUND_MILES ? t.label : null;
  const stop = closestStop(here, stops, NEAR_MILES);
  const road = roadOf(f, standing);
  const at = toMs(f.locatedAt);
  const ageMinutes = at == null ? null : Math.max(0, (now - at) / 60_000);
  const base = { town: townLabel, road, standing, coords: coordsText(f.lat, f.lng), ageMinutes, ageText: ageMinutes == null ? null : `${durationText(ageMinutes)} ago`, stale: ageMinutes != null && ageMinutes > STALE_MINUTES };
  const inTown = (label: string): string => (facilityTown && !label.includes(facilityTown) ? `${label}, ${facilityTown}` : label);

  if (stop && stop.miles <= AT_MILES) {
    const name = stop.stop.name.trim();
    if (standing) return { ...base, tier: "at", label: `At ${inTown(name)}`, facility: name, nearestStop: null };
    return { ...base, tier: "near_stop", label: `Passing ${inTown(name)}`, facility: name, nearestStop: null };
  }

  const nearestStop = stop ? { name: stop.stop.name.trim(), miles: roundMi(stop.miles) } : null;
  const onRoad = road && !standing ? `On ${road}` : null;
  if (t && t.miles <= NEAR_MILES) return { ...base, tier: "near", label: onRoad ? `${onRoad}, near ${t.label}` : `Near ${t.label}`, facility: null, nearestStop };
  if (t && t.miles <= AROUND_MILES) return { ...base, tier: "around", label: onRoad ? `${onRoad}, within 25 mi of ${t.label}` : `Within 25 mi of ${t.label}`, facility: null, nearestStop };
  if (t) return { ...base, tier: "town", label: onRoad ? `${onRoad}, ${roundMi(t.miles)} mi from ${t.label}` : `${roundMi(t.miles)} mi from ${t.label}`, facility: null, nearestStop };
  return { ...base, tier: "point", label: onRoad ?? "Position only", facility: null, nearestStop };
}

// ── What a list row's hover and the Where-it-is tab say about one unit ───────────────────────────

/** The same shape the tooltip kit takes (kit/tooltip.tsx `TipData`), restated so this file needs no component. */
export type UnitTip = { title?: string; sub?: string; rows?: Array<[string, string]>; note?: string };

/** Everything the desk can say about where one truck or trailer is and what it is doing. Plain JSON: a server builds it, a list row, a tooltip and the tab all read it. */
export type UnitWhere = {
  kind: "truck" | "trailer";
  id: string;
  name: string;
  /** "53V" for a trailer, the make and model or type for a truck; shown under the name. */
  sub: string | null;
  lat: number | null;
  lng: number | null;
  /** The map's picture name for it (the radar's own: `t-load`, `tr-d-e`) and the way it is heading, so a one-unit map draws the same mark. */
  icon: string;
  headingDeg: number | null;
  /** Null when the unit has no position at all. */
  where: Whereabouts | null;
  /** "Moving under load", "Idling", "Parked", "Dropped", "Hooked". */
  state: string | null;
  /** "62 MPH". */
  speed: string | null;
  idle: string | null;
  dwell: string | null;
  driver: string | null;
  load: { id: string; number: string; route: string } | null;
  /** What a person typed for where a trailer is ("Yard B, door 4"). Kept beside the computed place, never in place of it. */
  typedPlace: string | null;
  /** A truck's trailer, or the tractor a trailer is hooked to. */
  hitched: { kind: "trailer" | "tractor"; id: string | null; name: string } | null;
};

/** The hover: the place first, then the facts a dispatcher locating equipment asks for. A unit with no position says so instead of guessing. */
export function unitTip(u: UnitWhere): UnitTip {
  const rows: Array<[string, string]> = [];
  const w = u.where;
  if (!w) {
    return { title: u.name, sub: u.sub ?? undefined, rows: u.hitched ? [[u.hitched.kind === "trailer" ? "Pulling" : "Hooked to", u.hitched.name]] : undefined, note: "No position on file. It appears here once an ELD reports it." };
  }
  rows.push(["Where", w.label]);
  rows.push(["Position", w.coords]);
  if (w.road && !w.label.startsWith("On ")) rows.push(["Road", w.road]);
  const status = [u.state, u.speed].filter(Boolean).join(" · ");
  if (status) rows.push(["Status", status]);
  // The idle and dwell sentences are long: one clause to a line keeps the box narrow (the tooltip keeps line breaks).
  if (u.idle) rows.push(["Idle", u.idle.split(" · ").join("\n")]);
  if (u.dwell) rows.push(["Dwell", u.dwell.split(" · ").join("\n")]);
  if (u.driver) rows.push(["Driver", u.driver]);
  if (u.load) rows.push(["Load", `${u.load.number}${u.load.route ? ` · ${u.load.route}` : ""}`]);
  if (u.hitched) rows.push([u.hitched.kind === "trailer" ? "Pulling" : "Hooked to", u.hitched.name]);
  if (u.typedPlace) rows.push(["Noted as", u.typedPlace]);
  if (w.nearestStop) rows.push(["Nearest stop", `${w.nearestStop.name} · ${w.nearestStop.miles} mi`]);
  if (w.ageText) rows.push(["Last fix", w.ageText]);
  return { title: u.name, sub: u.sub ?? undefined, rows, note: w.stale ? "This position is old. The unit may have moved." : undefined };
}
