import { Prisma } from "@prisma/client";
import { stateCode } from "@/lib/fuel-normalize";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Fuel-tax mileage, modeled after ProMiles: give it each leg's start and end place and it routes the leg and answers how many of its miles were in each jurisdiction, in route order. The desk
 * keeps the legs as a truck's routed miles when the ELD did not report the truck (server/partners/ifta.ts, Wave 5 step 5b). As with the other adapters, the shapes are what the desk ASSUMES,
 * not the company's documentation.
 */
export type ProMilesAnswer = { trips: Array<{ id: string; total_miles: number; jurisdictions: Array<{ state: string; miles: number }> }> };

export interface ProMilesClient {
  /** `miles` is the desk's own figure for the leg; the company routes the road itself and ignores it. */
  mileage(body: { trips: Array<{ id: string; origin: string; destination: string; miles: number | null }> }): Promise<ProMilesAnswer>;
}

type In = AdapterShapes["ifta"]["in"];
type Out = AdapterShapes["ifta"]["out"];

export const liveProMilesClient: ProMilesClient = {
  async mileage() {
    throw new NotLive();
  }
};

/**
 * The company's trips into the desk's legs: each leg's jurisdictions in the order given, exact to a tenth, a state written out read as its code. A jurisdiction that is not one is left out and
 * counted (never guessed); a leg the company did not answer for, or answered with no miles, is counted as unrouted.
 */
export function normalizeProMiles(input: In, answer: ProMilesAnswer): Out {
  const byId = new Map(answer.trips.map((t) => [t.id, t]));
  let unreadable = 0;
  let unrouted = 0;
  const legs = input.legs.map((leg) => {
    const trip = byId.get(leg.id);
    const jurisdictions = (trip?.jurisdictions ?? []).flatMap((j) => {
      const code = stateCode(j.state);
      if (!code || !Number.isFinite(j.miles) || j.miles < 0) {
        unreadable += 1;
        return [];
      }
      return [{ state: code, miles: new Prisma.Decimal(j.miles).toDecimalPlaces(1).toFixed(1) }];
    });
    if (jurisdictions.every((j) => new Prisma.Decimal(j.miles).isZero())) unrouted += 1;
    return { id: leg.id, jurisdictions };
  });
  return { legs, skipped: { unreadable, unrouted } };
}

// ── The simulator ────────────────────────────────────────────────────────────────────────────

/**
 * The states a trip passes through and what share of its miles each carries, for the lanes the demo runs and a few big corridors. A trip between two states with no entry here is split between
 * the two ends in proportion to nothing clever (half and half); a trip inside one state is all that state's. The shares add to 1.
 */
export const CORRIDORS: Record<string, Array<[string, number]>> = {
  "TX>GA": [["TX", 0.34], ["LA", 0.14], ["MS", 0.2], ["AL", 0.16], ["GA", 0.16]],
  "TX>TN": [["TX", 0.4], ["LA", 0.15], ["AR", 0.3], ["TN", 0.15]],
  "GA>NC": [["GA", 0.3], ["SC", 0.45], ["NC", 0.25]],
  "IL>IN": [["IL", 0.55], ["IN", 0.45]],
  "MO>MO": [["MO", 1]],
  "PA>OH": [["PA", 0.4], ["MD", 0.08], ["WV", 0.18], ["OH", 0.34]],
  "CA>TX": [["CA", 0.22], ["AZ", 0.2], ["NM", 0.16], ["TX", 0.42]],
  "IL>TX": [["IL", 0.2], ["MO", 0.25], ["OK", 0.2], ["TX", 0.35]]
};

const stateOf = (place: string): string | null => {
  const m = /,\s*([A-Za-z]{2})\b\s*(?:\d{5}(?:-\d{4})?)?\s*$/.exec(place.trim());
  return m ? m[1]!.toUpperCase() : null;
};

/**
 * One trip's miles by state: the corridor in either direction, else the two ends, exact to a tenth (the last state takes what is left, so the parts add up to the trip). A place with no
 * readable state gives nothing (the miles are not invented onto a state).
 */
export function sandboxSplit(origin: string, destination: string, miles: number): Array<{ state: string; miles: number }> {
  const from = stateOf(origin);
  const to = stateOf(destination);
  if (!from || !to) return [];
  const total = new Prisma.Decimal(miles).toDecimalPlaces(1);
  const share = (path: Array<[string, number]>) => {
    let done = new Prisma.Decimal(0);
    return path.map(([state, f], i) => {
      const part = i === path.length - 1 ? total.minus(done) : total.times(f).toDecimalPlaces(1, Prisma.Decimal.ROUND_DOWN);
      done = done.plus(part);
      return { state, miles: part.toNumber() };
    });
  };
  if (from === to) return [{ state: from, miles: total.toNumber() }];
  const fwd = CORRIDORS[`${from}>${to}`];
  if (fwd) return share(fwd);
  const back = CORRIDORS[`${to}>${from}`];
  if (back) return share([...back].reverse());
  return share([[from, 0.5], [to, 0.5]]);
}

/** The simulator drives on the desk's own figure for each leg; a leg with none (or none readable) it cannot measure, so it answers no miles for it. */
export const sandboxProMilesClient: ProMilesClient = {
  async mileage(body) {
    return { trips: body.trips.map((t) => ({ id: t.id, total_miles: t.miles ?? 0, jurisdictions: t.miles != null && t.miles > 0 ? sandboxSplit(t.origin, t.destination, t.miles) : [] })) };
  }
};

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: ProMilesClient, provider: string, input: In) {
  try {
    const answer = await client.mileage({ trips: input.legs.map((l) => ({ id: l.id, origin: l.origin, destination: l.destination, miles: l.miles != null ? new Prisma.Decimal(l.miles).toNumber() : null })) });
    return ok(normalizeProMiles(input, answer));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "ProMiles did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveProMilesClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxProMilesClient, provider, input);

export const proMilesAdapter: ProviderAdapter<In, Out> = { live, sandbox };
