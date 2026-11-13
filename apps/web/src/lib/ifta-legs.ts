import { Prisma } from "@prisma/client";
import { haversineMiles } from "@/lib/geo";

/**
 * A truck's quarter as legs to route (money plan Wave 5 step 5b), for a truck the ELD did not report: pure, so the routed fallback is the same every time and can be tested by hand.
 *
 *   - Loads are taken in pickup order. Each load is routed stop by stop in `stopSequence` order: one LOADED leg per pair of stops (`loaded: true`, the load's id).
 *   - Between one load's last stop and the next load's first stop, an EMPTY leg (`loaded: false`, no load): the truck repositioning.
 *   - Before the first load there is no earlier delivery to start from. The empty leg then starts at the truck's home base, and only when the load says there were empty miles to the pickup
 *     (`pickupDeadheadMiles` > 0). With no home base on the truck, no leg is made (`noStart` says which load): an empty leg is never invented from nowhere.
 *   - No leg is made home after the last load: the next empty leg starts at that delivery, so a run home would count the same road twice.
 *   - Two places that read the same (case and spacing aside) make no leg.
 *
 * Times: a stop's time is when it was arrived at, else its window. A load with no time at all (no stop time and no completion) gives no legs (`untimed`). A leg takes the time of the stop it
 * leaves; an empty leg the time of the delivery before it. `miles` is the desk's own figure for the leg (the load's loaded miles shared over its legs by straight-line distance when every stop
 * has a point, else evenly, exact to a tenth; an empty leg's is the next load's pickup empty miles). A live router measures the road and ignores it; the simulator drives on it.
 */
export type LegStop = { sequence: number; place: string; at: number | null; lat?: number | null; lng?: number | null };
export type LegLoad = { loadId: string; stops: readonly LegStop[]; completedAt: number | null; loadedMiles: string; pickupDeadheadMiles: string };
export type IftaLeg = { key: string; loadId: string | null; loaded: boolean; from: string; to: string; startsAt: number; endsAt: number; miles: string };
export type TruckLegs = { legs: IftaLeg[]; noStart: string[]; untimed: string[]; tooFewStops: string[] };

const HOUR = 3_600_000;
const same = (a: string, b: string) => a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();
const tenth = (s: string) => new Prisma.Decimal(s).toDecimalPlaces(1);
const whole = (n: number) => n - (n % 1);
const later = (a: number, b: number) => (a > b ? a : b);

/** A load's stops in sequence order, and the moments it began and ended (first stop or its loaded miles' drive at 50 mph before completion; completion or the last stop). */
function timed(load: LegLoad): { stops: LegStop[]; start: number; end: number } | null {
  const stops = [...load.stops].sort((a, b) => a.sequence - b.sequence);
  const known = stops.filter((s) => s.at != null);
  const end = load.completedAt ?? known[known.length - 1]?.at ?? null;
  const drive = whole(tenth(load.loadedMiles).div(50).times(HOUR).toNumber());
  const start = stops[0]?.at ?? (end != null ? end - drive : known[0]?.at ?? null);
  if (start == null || end == null) return null;
  return { stops, start, end: later(end, start) };
}

/** Exact tenths of `total` shared by `weights` (all zero = evenly); the last takes what is left, so they add up to it. */
export function shareMiles(total: string, weights: readonly number[]): string[] {
  const t = tenth(total);
  if (weights.length === 0) return [];
  const sum = weights.reduce((s, w) => s + w, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const all = sum > 0 ? sum : weights.length;
  const out: string[] = [];
  let done = new Prisma.Decimal(0);
  for (let i = 0; i < w.length; i++) {
    const part = i === w.length - 1 ? t.minus(done) : t.times(w[i]!).div(all).toDecimalPlaces(1, Prisma.Decimal.ROUND_DOWN);
    done = done.plus(part);
    out.push(part.toFixed(1));
  }
  return out;
}

export function truckLegs(loads: readonly LegLoad[], home: string | null): TruckLegs {
  const out: TruckLegs = { legs: [], noStart: [], untimed: [], tooFewStops: [] };
  const ready = loads
    .map((l) => ({ load: l, t: timed(l) }))
    .filter((x) => {
      if (!x.t) out.untimed.push(x.load.loadId);
      return x.t != null;
    })
    .sort((a, b) => a.t!.start - b.t!.start || a.load.loadId.localeCompare(b.load.loadId));
  let prev: { place: string; at: number; loadId: string } | null = null;
  for (const { load, t } of ready) {
    const { stops, start, end } = t!;
    const first = stops[0];
    if (!first) {
      out.tooFewStops.push(load.loadId);
      continue;
    }
    const empty = tenth(load.pickupDeadheadMiles);
    if (prev) {
      if (!same(prev.place, first.place)) out.legs.push({ key: `e:${prev.loadId}>${load.loadId}`, loadId: null, loaded: false, from: prev.place, to: first.place, startsAt: prev.at, endsAt: later(start, prev.at), miles: empty.toFixed(1) });
    } else if (empty.gt(0)) {
      if (!home) out.noStart.push(load.loadId);
      else if (!same(home, first.place)) {
        const drive = whole(empty.div(50).times(HOUR).toNumber());
        out.legs.push({ key: `e:home>${load.loadId}`, loadId: null, loaded: false, from: home, to: first.place, startsAt: start - drive, endsAt: start, miles: empty.toFixed(1) });
      }
    }
    if (stops.length < 2) {
      out.tooFewStops.push(load.loadId);
    } else {
      const pairs = stops.slice(1).map((s, i) => [stops[i]!, s] as const);
      const placed = stops.every((s) => s.lat != null && s.lng != null);
      const weights = pairs.map(([a, b]) => (placed ? haversineMiles({ lat: a.lat!, lng: a.lng! }, { lat: b.lat!, lng: b.lng! }) : same(a.place, b.place) ? 0 : 1));
      const miles = shareMiles(load.loadedMiles, weights);
      let at = start;
      pairs.forEach(([a, b], i) => {
        const startsAt = later(a.at ?? at, at);
        const endsAt = i === pairs.length - 1 ? later(end, startsAt) : later(b.at ?? startsAt, startsAt);
        at = endsAt;
        if (same(a.place, b.place)) return;
        out.legs.push({ key: `l:${load.loadId}:${a.sequence}>${b.sequence}`, loadId: load.loadId, loaded: true, from: a.place, to: b.place, startsAt, endsAt, miles: miles[i]! });
      });
    }
    const last = stops[stops.length - 1]!;
    prev = { place: last.place, at: end, loadId: load.loadId };
  }
  return out;
}

/**
 * One routed leg's miles by state as pieces with times: the leg's time shared out by miles, in the order the router named the states. Zero-mile states are dropped.
 */
export function spreadLeg(leg: Pick<IftaLeg, "startsAt" | "endsAt">, states: ReadonlyArray<{ state: string; miles: string }>): Array<{ state: string; miles: string; startedAt: number; endedAt: number }> {
  const total = states.reduce((s, x) => s.plus(x.miles), new Prisma.Decimal(0));
  const span = leg.endsAt - leg.startsAt;
  let done = new Prisma.Decimal(0);
  const out: Array<{ state: string; miles: string; startedAt: number; endedAt: number }> = [];
  states.forEach((x, i) => {
    const at = (d: Prisma.Decimal) => (total.gt(0) ? leg.startsAt + whole(d.div(total).times(span).toNumber()) : leg.startsAt);
    const startedAt = at(done);
    done = done.plus(x.miles);
    const endedAt = i === states.length - 1 ? leg.endsAt : at(done);
    if (new Prisma.Decimal(x.miles).gt(0)) out.push({ state: x.state, miles: new Prisma.Decimal(x.miles).toFixed(1), startedAt, endedAt });
  });
  return out;
}
