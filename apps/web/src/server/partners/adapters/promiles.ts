import { Prisma } from "@prisma/client";
import { err, ok } from "@/truelane/partners/contract";
import type { AdapterShapes } from "../call";
import { notImplemented } from "../not-implemented";
import { NotLive, type Adapter, type ProviderAdapter } from "./types";

/**
 * Fuel tax (IFTA), modeled after ProMiles: give it each trip's origin and destination and it answers how many miles of the trip were driven in each state. The desk adds the trips up for a
 * quarter and keeps the result (server/partners/ifta.ts). As with the other adapters, the shapes are what the desk ASSUMES, not the company's documentation.
 */
export type ProMilesAnswer = { trips: Array<{ id: string; total_miles: number; jurisdictions: Array<{ state: string; miles: number }> }> };

export interface ProMilesClient {
  mileage(body: { trips: Array<{ id: string; origin: string; destination: string; miles: number }> }): Promise<ProMilesAnswer>;
}

type In = AdapterShapes["ifta"]["in"];
type Out = AdapterShapes["ifta"]["out"];

export const liveProMilesClient: ProMilesClient = {
  async mileage() {
    throw new NotLive();
  }
};

/** The fleet's usual miles to the gallon when a truck has none set. */
export const DEFAULT_MPG = 6.5;

/**
 * The company's trips into the quarter's jurisdictions: miles added up by state, and the fuel those miles burned (miles over the truck's miles to the gallon). Gallons here are fuel CONSUMED
 * from the miles driven; the fuel bought in each state, which IFTA nets against it, comes from fuel-card purchases and is not in this answer.
 */
export function normalizeProMiles(input: In, answer: ProMilesAnswer): Out {
  const mpgOf = new Map<string, number>();
  for (const t of input.trips ?? []) mpgOf.set(t.id, t.mpg && t.mpg > 0 ? t.mpg : DEFAULT_MPG);
  const miles = new Map<string, Prisma.Decimal>();
  const gallons = new Map<string, Prisma.Decimal>();
  for (const trip of answer.trips) {
    const mpg = mpgOf.get(trip.id) ?? DEFAULT_MPG;
    for (const j of trip.jurisdictions) {
      const state = j.state.trim().toUpperCase();
      if (!/^[A-Z]{2}$/.test(state)) continue;
      miles.set(state, (miles.get(state) ?? new Prisma.Decimal(0)).plus(j.miles));
      gallons.set(state, (gallons.get(state) ?? new Prisma.Decimal(0)).plus(new Prisma.Decimal(j.miles).div(mpg)));
    }
  }
  return { jurisdictions: [...miles.keys()].sort().map((state) => ({ state, miles: miles.get(state)!.toDecimalPlaces(1).toNumber(), gallons: gallons.get(state)!.toDecimalPlaces(2).toNumber() })) };
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

/** One trip's miles by state: the corridor in either direction, else the two ends. A place with no readable state is left out of the answer (the miles are not invented onto a state). */
export function sandboxSplit(origin: string, destination: string, miles: number): Array<{ state: string; miles: number }> {
  const from = stateOf(origin);
  const to = stateOf(destination);
  if (!from || !to) return [];
  const share = (path: Array<[string, number]>) => path.map(([state, f]) => ({ state, miles: new Prisma.Decimal(miles).times(f).toDecimalPlaces(1).toNumber() }));
  if (from === to) return [{ state: from, miles }];
  const fwd = CORRIDORS[`${from}>${to}`];
  if (fwd) return share(fwd);
  const back = CORRIDORS[`${to}>${from}`];
  if (back) return share([...back].reverse());
  return share([[from, 0.5], [to, 0.5]]);
}

export const sandboxProMilesClient: ProMilesClient = {
  async mileage(body) {
    return { trips: body.trips.map((t) => ({ id: t.id, total_miles: t.miles, jurisdictions: sandboxSplit(t.origin, t.destination, t.miles) })) };
  }
};

// ── The adapter ──────────────────────────────────────────────────────────────────────────────

async function run(client: ProMilesClient, provider: string, input: In) {
  try {
    const answer = await client.mileage({ trips: (input.trips ?? []).map((t) => ({ id: t.id, origin: t.origin, destination: t.destination, miles: t.miles })) });
    return ok(normalizeProMiles(input, answer));
  } catch (e) {
    return e instanceof NotLive ? notImplemented(provider) : err("upstream_error", "ProMiles did not answer.");
  }
}

const live: Adapter<In, Out> = ({ provider, input }) => run(liveProMilesClient, provider, input);
const sandbox: Adapter<In, Out> = ({ provider, input }) => run(sandboxProMilesClient, provider, input);

export const proMilesAdapter: ProviderAdapter<In, Out> = { live, sandbox };
