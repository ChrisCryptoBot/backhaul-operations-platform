import type { AcceptGate, MarketBand } from "@/truelane/lib/domain/marketVerdict";

/**
 * The verdict as data. Everything a verdict says is worked out here, once, from what the audited math already decided: this file does no costing and changes no rule, it only says
 * the answer. A card, a row in a table, a phone, a watch, a voice, an agent's audit log are all ways of drawing the same object, so the object is what has to last (docs/VERDICT_CARD.md).
 *
 * Four states, and only four. Each has a word, and a shape taken from the road (a round go, a diamond warning, an octagon stop, an empty ring for nothing to judge), so a verdict reads
 * in black and white and to someone who cannot tell red from green. Colour comes last and only repeats what the word and the shape have said. Your cost owns the verdict; the market
 * can only make a good load worth a second look, or, when it pays more than 20% under (the audited strong-caution band), a Reject. It never turns one green, and it never makes a load
 * that loses money look any better. A market rate nobody gave is not evidence
 * against a load: with no market rate the desk reads the load against its own recent loads on the lane, under the same audited rules, and with too few of those it is judged on its
 * cost alone and the card says the market was not checked.
 *
 * Pure.
 */
export type VerdictState = "take" | "think" | "reject" | "unjudged";

export const VERDICT_WORD: Record<VerdictState, string> = { take: "Take it", think: "Think twice", reject: "Reject", unjudged: "Can't judge yet" };

/** The tone a state lights up with. A state with nothing to judge has none: it is not a point on the scale from good to bad. */
export const VERDICT_TONE: Record<VerdictState, "ok" | "warn" | "bad" | "none"> = { take: "ok", think: "warn", reject: "bad", unjudged: "none" };

/** What the pay was read against: a market rate somebody typed, or with none typed, the desk's own recent loads on the lane. */
export type Benchmark = "market" | "lane";

/** What a lane's record has to be, by default, to stand in for a market rate: enough loads to mean something, and recent, since rates move. Settings > Thresholds can change both. */
export const LANE_MIN_LOADS = 3;
export const LANE_DAYS = 90;

/**
 * The lines the audited rules draw, for showing in Settings beside the thresholds that can move. Not read by the verdict: the rules (src/truelane) decide, and
 * tests/thresholds.test.ts pins these figures to them, so that if an audit ever moves a line this stops being quietly wrong on the screen.
 */
export const CARD_LINES = { atMarketPct: 10, rejectPct: 20, thinCentsPerMile: 5 } as const;

const BENCHMARK_NAME: Record<Benchmark, string> = { market: "Market", lane: "Your lane" };

export type VerdictFacts = {
  band: MarketBand;
  gate: AcceptGate;
  /** All in, over every mile driven. */
  allInPerMile: number | null;
  floorPerMile: number;
  /** Over the floor (negative: short of it). */
  marginPerMile: number | null;
  /** The margin over every mile, in dollars. */
  leftOver: number | null;
  totalMiles: number;
  /** What the load pays in all, with the surcharge. */
  gross: number;
  /** The load against the market total, in dollars and as a fraction; null when there was nothing to read it against. */
  marketDollars: number | null;
  marketPct: number | null;
  /** What those two were read against. Left out: a market rate. */
  benchmark?: Benchmark;
  /** What it would have to pay to cover its cost. */
  payNeeded: number | null;
  thinMargin: boolean;
  timeTrap: boolean;
  profitPerHour: number | null;
  hourlyTarget: number | null;
  /** Whether the market total typed is suspect (e.g. under $0.50/mi or over $15/mi). */
  marketSuspect?: boolean;
};

export type RulerMark = { value: number; at: number };
/** Where the load lands against what it costs. The floor is always in the same place on the line, so the eye learns it: right of it pays, left of it loses. */
export type Ruler = { floor: RulerMark; offer: RulerMark; market: RulerMark | null; marketName: string };

export type Verdict = {
  state: VerdictState;
  word: string;
  tone: "ok" | "warn" | "bad" | "none";
  /** The verdict in one sentence, with the money in it. */
  sentence: string;
  /** Null when there is nothing honest to draw: with no fuel price the floor is not the whole cost. */
  ruler: Ruler | null;
  marketSuspect?: boolean;
};

const dollars = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const rate = (n: number) => `$${n.toFixed(2)}/mi`;
const pct = (fraction: number) => `${(Math.abs(fraction) * 100).toFixed(0)}%`;

/** The floor's place on the line, and the room either side of it. Fixed, so that a load's distance from its cost is read by position alone. */
export const FLOOR_AT = 40;
const ROOM_RIGHT = 54;
const ROOM_LEFT = 34;
/** The line never zooms in closer than this many dollars a mile: two cents over the floor should look like two cents, not like a long way. */
const NEAREST_REACH = 0.25;

const on = (at: number) => Math.round(at * 10) / 10;

export function rulerOf(input: { floor: number; offer: number; market: number | null; benchmark?: Benchmark }): Ruler {
  const { floor, offer, market, benchmark = "market" } = input;
  const above = Math.max(offer - floor, (market ?? floor) - floor, NEAREST_REACH);
  const under = Math.max(floor - offer, floor - (market ?? floor), NEAREST_REACH);
  // One scale for both sides, the smaller of the two that fit, so a dollar is the same length everywhere on the line.
  const scale = Math.min(ROOM_RIGHT / above, ROOM_LEFT / under);
  const place = (value: number): RulerMark => ({ value, at: on(FLOOR_AT + (value - floor) * scale) });
  return { floor: { value: floor, at: FLOOR_AT }, offer: place(offer), market: market == null ? null : place(market), marketName: BENCHMARK_NAME[benchmark] };
}

/**
 * Whether booking needs a reason. The audited rules' own gate, with one difference on the desk (Chris, 2026-10-31): a load that clears its cost with nothing to read it against needs none.
 * Most small fleets have no market rate to hand, so asking for a reason on every load would only teach people to stop reading the card. The rules themselves are the phone's and stay
 * as they are; this is the desk's reading of them.
 */
export const bookingGate = (gate: AcceptGate): AcceptGate => (gate === "no_market" ? null : gate);

/**
 * The state of a verdict. The band and the gate are the audited rules' own answer; nothing is judged again here. Reject is two things the rules already mark with a hard stop: a load
 * under its cost, and one paying more than 20% under what it is read against, which the rules ask a reason for. A reason can still book either: Reject says what the desk
 * advises, it does not take the choice away.
 */
export function verdictState(f: Pick<VerdictFacts, "band" | "gate" | "thinMargin" | "timeTrap">): VerdictState {
  if (f.band === "below_floor") return "reject";
  if (f.band === "needs_fuel") return "unjudged";
  if (f.band === "strong_caution") return "reject";
  const clean = (f.band === "above_market" || f.band === "at_market" || f.band === "no_benchmark") && bookingGate(f.gate) == null && !f.thinMargin && !f.timeTrap;
  return clean ? "take" : "think";
}

function sentenceOf(state: VerdictState, f: VerdictFacts): string {
  const margin = f.marginPerMile == null ? null : Math.abs(f.marginPerMile);
  const trip = f.leftOver == null ? null : Math.abs(f.leftOver);
  const clears = margin == null ? "Clears your cost" : `Clears your cost by ${rate(margin)}${trip != null ? `, ${dollars(trip)} on this trip` : ""}`;
  const onLane = f.benchmark === "lane";
  const against = onLane ? "your lane average" : "the market";
  if (state === "reject" && f.band !== "below_floor") {
    const under = f.marketPct != null ? `${pct(f.marketPct)} under ${against}` : `far under ${against}`;
    return `${clears}, but pays ${under}. Too far under to take.`;
  }
  if (state === "reject") {
    const short = margin == null ? "Short of your cost" : `Short of your cost by ${rate(margin)}${trip != null ? `, ${dollars(trip)} on this trip` : ""}`;
    return f.payNeeded != null ? `${short}. It would have to pay ${dollars(f.payNeeded)} to cover it.` : `${short}.`;
  }
  if (state === "unjudged") return "The truck has no mpg or fuel price, so its cost is not known yet. Add them on its page.";
  if (state === "take") {
    if (f.marketSuspect) return `${clears}. Check the market rate typed for this check.`;
    if (f.band === "above_market") return `${clears}, and pays above ${against}.`;
    if (f.band === "at_market") return onLane ? `${clears}, and pays about what this lane usually pays you.` : `${clears}, and pays about what the market does.`;
    return `${clears}. Market not checked.`;
  }
  if (f.band === "negotiate" && f.marketPct != null) return `${clears}, but pays ${pct(f.marketPct)} under ${against}. Ask for more.`;
  if (f.thinMargin) return "It clears your cost, but by less than five cents a mile.";
  if (f.timeTrap) return f.profitPerHour != null && f.hourlyTarget != null ? `${clears}, but it earns ${dollars(f.profitPerHour)} an hour against your ${dollars(f.hourlyTarget)} target.` : `${clears}, but it is slow money.`;
  return `${clears}.`;
}

/** The market as a figure over every mile, on the same footing as the load's own. */
export function marketPerMile(f: Pick<VerdictFacts, "gross" | "marketDollars" | "totalMiles">): number | null {
  return f.marketDollars == null || !(f.totalMiles > 0) ? null : (f.gross - f.marketDollars) / f.totalMiles;
}

export function readVerdict(f: VerdictFacts): Verdict {
  const state = verdictState(f);
  const drawable = state !== "unjudged" && f.allInPerMile != null;
  const market = f.marketSuspect ? null : marketPerMile(f);
  return {
    state,
    word: VERDICT_WORD[state],
    tone: VERDICT_TONE[state],
    sentence: sentenceOf(state, f),
    ruler: drawable ? rulerOf({ floor: f.floorPerMile, offer: f.allInPerMile!, market, benchmark: f.benchmark }) : null,
    marketSuspect: f.marketSuspect
  };
}

/** What a verdict is standing on. `firm` is what was measured or is the desk's own record; the rest is taken on trust, and the card says so. */
export type Ground = { label: string; firm: boolean };

export function groundOf(i: { miles: "measured" | "typed"; fuel: "own" | "typed" | "none"; market: "typed" | "none" | { laneLoads: number; laneDays: number }; driver: boolean }): Ground[] {
  return [
    { label: i.miles === "measured" ? "Miles measured on the road" : "Miles as typed", firm: i.miles === "measured" },
    { label: i.fuel === "own" ? "The truck's own fuel price" : i.fuel === "typed" ? "Fuel price typed for this check" : "No fuel price", firm: i.fuel === "own" },
    typeof i.market === "object" ? { label: `Your ${i.market.laneLoads} loads on this lane in the last ${i.market.laneDays} days`, firm: true } : { label: i.market === "typed" ? "Market rate as typed" : "Market not checked", firm: false },
    { label: i.driver ? "This driver's usual pay" : "No driver on this truck", firm: i.driver }
  ];
}
