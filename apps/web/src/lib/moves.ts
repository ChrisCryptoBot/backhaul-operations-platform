/**
 * "Why it moved": the change in what a lane, a customer or the whole desk made from one week to the next, split into the things that moved it. Every figure is a sum over stored loads and the effects add
 * back to the change to the cent: nothing is estimated, nothing is left over, and where the split cannot be made honestly (a lane that ran only one of the two weeks) it says so instead of guessing.
 * Pure: the server reads the loads and hands them over; nothing here reads a clock or a database.
 *
 * The figure that moves is the RESULT of a week: gross (line haul, fuel surcharge, TONU and layover pay) plus the detention that was billed, less the tracked fuel, tolls and other costs. It is not profit: the
 * truck's fixed costs are not in it. With A the earlier week and B the later one, L the loaded miles, D every mile driven, E = D - L the empty miles, H the line haul, h = H / L the line haul per loaded
 * mile, X the tracked costs and x = X / D the cost per mile driven:
 *   rate       (h_B - h_A) x L_B        paid more or less per loaded mile, on this week's miles
 *   miles      (L_B - L_A) x (h_A - x_A)  more or fewer loaded miles, at last week's rate and cost per mile
 *   deadhead   -(E_B - E_A) x x_A       more or fewer empty miles, each costing last week's cost per mile
 *   costs      -(x_B - x_A) x D_B       the cost of a mile moved (fuel price, tolls, other), on this week's miles
 *   fsc        F_B - F_A                the fuel surcharge paid
 *   other      O_B - O_A                TONU fees and layover pay
 *   detention  T_B - T_A                detention that was billed on invoices
 * These seven add to the change in result exactly (the first four are the change in line haul less the change in costs, regrouped). The deadhead line prices an empty mile at the cost the week's own
 * tracked costs imply, so it is only as complete as those costs are: loads with nothing recorded make the cost lines read low, and the screen counts them.
 */
export type MoveLoad = {
  loadId: string;
  doneAt: number;
  lane: string;
  customer: string | null;
  loadedMiles: number;
  /** Every mile driven for the load. Its empty miles are what is left after the loaded ones. */
  drivenMiles: number;
  lineHaul: number;
  fsc: number;
  /** Gross that is neither line haul nor fuel surcharge: a TONU fee, layover pay. */
  other: number;
  /** Tracked fuel, tolls and other costs. */
  expenses: number;
  /** Detention billed on the invoice. */
  detention: number;
};

export type WeekTotals = { loads: number; loadedMiles: number; emptyMiles: number; drivenMiles: number; lineHaul: number; fsc: number; other: number; detention: number; expenses: number };

export const ZERO_WEEK: WeekTotals = { loads: 0, loadedMiles: 0, emptyMiles: 0, drivenMiles: 0, lineHaul: 0, fsc: 0, other: 0, detention: 0, expenses: 0 };

/** Money is added in whole cents so a long run of loads does not drift. */
const cents = (n: number): number => Math.round(n * 100);
const dollars = (c: number): number => c / 100;

export function totalsOf(loads: readonly MoveLoad[]): WeekTotals {
  const t = { ...ZERO_WEEK };
  let lh = 0;
  let fsc = 0;
  let other = 0;
  let det = 0;
  let exp = 0;
  for (const l of loads) {
    t.loads += 1;
    t.loadedMiles += l.loadedMiles;
    t.drivenMiles += l.drivenMiles;
    lh += cents(l.lineHaul);
    fsc += cents(l.fsc);
    other += cents(l.other);
    det += cents(l.detention);
    exp += cents(l.expenses);
  }
  return { ...t, emptyMiles: t.drivenMiles - t.loadedMiles, lineHaul: dollars(lh), fsc: dollars(fsc), other: dollars(other), detention: dollars(det), expenses: dollars(exp) };
}

/** What a week made: gross and the billed detention, less the tracked costs. */
export const resultOf = (t: WeekTotals): number => dollars(cents(t.lineHaul) + cents(t.fsc) + cents(t.other) + cents(t.detention) - cents(t.expenses));

export type EffectKey = "rate" | "miles" | "deadhead" | "costs" | "fsc" | "other" | "detention" | "lane";

export const EFFECT_LABEL: Record<EffectKey, string> = {
  rate: "Rate per loaded mile",
  miles: "Loaded miles",
  deadhead: "Empty miles",
  costs: "Fuel and other costs per mile",
  fsc: "Fuel surcharge",
  other: "TONU and layover pay",
  detention: "Detention billed",
  lane: "Lane started or stopped"
};

/** The order they are shown in, and what each says in a sentence (the screen and the docs read these). */
export const EFFECT_NOTE: Record<EffectKey, string> = {
  rate: "Line haul per loaded mile, this week against last, on this week's loaded miles.",
  miles: "More or fewer loaded miles, at last week's line haul per mile less last week's cost per mile.",
  deadhead: "More or fewer empty miles, each at last week's cost per mile driven.",
  costs: "What a mile cost (fuel price, tolls, other), this week against last, on this week's miles driven.",
  fsc: "Fuel surcharge paid, this week against last.",
  other: "TONU fees and layover pay, this week against last.",
  detention: "Detention billed on invoices, this week against last. Waiting that was not billed is in the Leak Ledger.",
  lane: "The lane ran in only one of the two weeks, so its rate and its miles cannot be told apart: all of its line haul and cost change is here."
};

export const EFFECT_ORDER: readonly EffectKey[] = ["rate", "miles", "deadhead", "costs", "fsc", "other", "detention", "lane"];

export type Effect = { key: EffectKey; label: string; dollars: number };

export type Bridge = {
  before: number;
  after: number;
  change: number;
  /** "split" when rate and miles could be told apart; "whole" when a week had no loaded or driven miles. */
  method: "split" | "whole";
  /** Only the effects that are not zero, in the fixed order. They add to `change` exactly. */
  effects: Effect[];
};

/**
 * Splits the change in result between two weeks. The seven effects are worked out in cents; the few cents that rounding leaves are put on the largest effect (the one that can best absorb them), so the
 * effects always add to the change exactly.
 */
export function bridgeOf(a: WeekTotals, b: WeekTotals): Bridge {
  const before = cents(resultOf(a));
  const after = cents(resultOf(b));
  const change = after - before;
  const dF = cents(b.fsc) - cents(a.fsc);
  const dO = cents(b.other) - cents(a.other);
  const dT = cents(b.detention) - cents(a.detention);
  const splittable = a.loadedMiles > 0 && b.loadedMiles > 0 && a.drivenMiles > 0 && b.drivenMiles > 0;
  const raw = new Map<EffectKey, number>();
  if (splittable) {
    const hA = cents(a.lineHaul) / a.loadedMiles;
    const hB = cents(b.lineHaul) / b.loadedMiles;
    const xA = cents(a.expenses) / a.drivenMiles;
    const xB = cents(b.expenses) / b.drivenMiles;
    raw.set("rate", (hB - hA) * b.loadedMiles);
    raw.set("miles", (b.loadedMiles - a.loadedMiles) * (hA - xA));
    raw.set("deadhead", -(b.drivenMiles - b.loadedMiles - (a.drivenMiles - a.loadedMiles)) * xA);
    raw.set("costs", -(xB - xA) * b.drivenMiles);
  } else {
    raw.set("lane", cents(b.lineHaul) - cents(a.lineHaul) - (cents(b.expenses) - cents(a.expenses)));
  }
  raw.set("fsc", dF);
  raw.set("other", dO);
  raw.set("detention", dT);

  const rounded = new Map<EffectKey, number>([...raw.entries()].map(([k, v]) => [k, Math.round(v)]));
  const left = change - [...rounded.values()].reduce((s, v) => s + v, 0);
  if (left !== 0) {
    // The rounding that is left (a few cents at most) goes to the effect with the largest size: it is the one it matters least to.
    const biggest = [...rounded.entries()].sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]) || EFFECT_ORDER.indexOf(x[0]) - EFFECT_ORDER.indexOf(y[0]))[0];
    if (biggest) {
      rounded.set(biggest[0], biggest[1] + left);
    }
  }
  const effects: Effect[] = EFFECT_ORDER.filter((k) => (rounded.get(k) ?? 0) !== 0).map((k) => ({ key: k, label: EFFECT_LABEL[k], dollars: dollars(rounded.get(k)!) }));
  return { before: dollars(before), after: dollars(after), change: dollars(change), method: splittable ? "split" : "whole", effects };
}

export type MoveRow = {
  key: string;
  label: string;
  before: WeekTotals;
  after: WeekTotals;
  bridge: Bridge;
};

export type MoveBy = "lane" | "customer";

/** The rows to compare: the loads of each week grouped by lane or customer, each with its own bridge, biggest change first (ties by name). */
export function moveRows(before: readonly MoveLoad[], after: readonly MoveLoad[], by: MoveBy): MoveRow[] {
  const keyOf = (l: MoveLoad) => (by === "lane" ? l.lane : (l.customer?.trim() || "No customer"));
  const groups = new Map<string, { a: MoveLoad[]; b: MoveLoad[] }>();
  for (const l of before) (groups.get(keyOf(l)) ?? groups.set(keyOf(l), { a: [], b: [] }).get(keyOf(l))!).a.push(l);
  for (const l of after) (groups.get(keyOf(l)) ?? groups.set(keyOf(l), { a: [], b: [] }).get(keyOf(l))!).b.push(l);
  return [...groups.entries()]
    .map(([key, g]) => {
      const a = totalsOf(g.a);
      const b = totalsOf(g.b);
      return { key, label: key, before: a, after: b, bridge: bridgeOf(a, b) };
    })
    .sort((x, y) => Math.abs(y.bridge.change) - Math.abs(x.bridge.change) || x.label.localeCompare(y.label));
}

/** Loads that carry no tracked cost at all: the cost lines read low when there are many, so the screen says how many. */
export const withoutCosts = (loads: readonly MoveLoad[]): number => loads.filter((l) => l.expenses <= 0).length;

/** What a set of rows changed by together, in whole cents so a long list does not drift. */
export const changeOf = (rows: readonly MoveRow[]): number => dollars(rows.reduce((s, r) => s + cents(r.bridge.change), 0));
