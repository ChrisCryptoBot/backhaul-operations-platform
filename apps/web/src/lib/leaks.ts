import { inWindow, periodWindow, previousWindow, weekBuckets, type KpiPeriod, type TimeWindow } from "./kpi-periods";
import { activeTz } from "./tz";

/**
 * The Leak Ledger: one dollar figure per leak, by week, with the loads behind each line. Every figure is a sum over stored loads (and, for trailer dwell, stored stays and the audit trail), labelled with its
 * basis, and a load that cannot be priced is counted and shown as unpriced, never given an invented rate. Pure: the server reads the rows and hands them over.
 *
 * What a leak is here, and what is added together:
 *  - billed-miss: money the desk says is owed and is not on any invoice (unbilled detention, a TONU fee not invoiced).
 *  - choice: money a person decided not to bill (waived detention, trailer dwell waived or lowered).
 *  - cost: money burned running empty, priced at the floor frozen on each load when it was accepted.
 *  - lens: a second way of looking at the same dollars (what a load paid under the truck's own floor already contains its empty miles), shown but never added to the total.
 */
export type LeakKey = "empty_miles" | "below_floor" | "detention_unbilled" | "tonu_uninvoiced" | "detention_waived" | "dwell_forgone";
export type LeakGroup = "billed_miss" | "choice" | "cost" | "lens";

export const LEAKS: ReadonlyArray<{ key: LeakKey; label: string; group: LeakGroup; counted: boolean; basis: string; unpricedWhy: string }> = [
  { key: "detention_unbilled", label: "Detention not billed", group: "billed_miss", counted: true, basis: "Waiting past the free time at the truck's detention rate, on loads finished that week, and not on any invoice (as of now).", unpricedWhy: "waited past the free time but the truck has no detention rate" },
  { key: "tonu_uninvoiced", label: "TONU fees not invoiced", group: "billed_miss", counted: true, basis: "TONU fees recorded on a load that has no invoice yet (as of now), by the week the TONU was recorded.", unpricedWhy: "" },
  { key: "detention_waived", label: "Detention waived", group: "choice", counted: true, basis: "Detention a person marked as not billed, with their reason in the audit log, by the week the load finished.", unpricedWhy: "" },
  { key: "dwell_forgone", label: "Trailer dwell waived or lowered", group: "choice", counted: true, basis: "The drop from the dwell owed to the figure a person set, read from the audit trail. History starts the day the audit began recording it.", unpricedWhy: "" },
  { key: "empty_miles", label: "Empty-mile cost", group: "cost", counted: true, basis: "Empty miles (before pickup and after delivery) times the truck's own break-even floor, frozen on the load when it was accepted. Before fuel.", unpricedWhy: "the load has no frozen floor, so its empty miles are counted but not priced" },
  { key: "below_floor", label: "Paid under the floor", group: "lens", counted: false, basis: "What a load paid after fuel, tolls and other costs, short of the truck's own floor times the miles driven. Its empty miles are already inside this, so it is not added to the total.", unpricedWhy: "" }
];

const META = new Map(LEAKS.map((l) => [l.key, l]));
export const leakMeta = (k: LeakKey) => META.get(k)!;

/** One finished load, reduced to what the ledger needs. */
export type LeakLoad = {
  loadId: string;
  loadNumber: string | null;
  doneAt: number;
  lane: string;
  customer: string | null;
  truck: string | null;
  driver: string | null;
  isTonu: boolean;
  emptyMiles: number;
  drivenMiles: number;
  gross: number;
  expenses: number;
  /** The truck's break-even floor, $ per mile driven before fuel, frozen when the load was accepted. */
  floor: number | null;
  tonuRevenue: number;
  invoiced: boolean;
};

/** One thing that leaked: a load, or a trailer's stay. `dollars` is null when it cannot be priced. */
export type LeakItem = {
  key: LeakKey;
  at: number;
  dollars: number | null;
  /** The empty miles behind an unpriced empty-mile item (so the screen can say how many miles are unpriced). */
  miles: number;
  loadId: string | null;
  label: string;
  lane: string | null;
  customer: string | null;
  truck: string | null;
};

const cents = (n: number): number => Math.round(n * 100);
const fromCents = (c: number): number => c / 100;
const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/** The leaks one finished load carries on its own (detention and dwell come from their own reads). */
export function loadLeaks(l: LeakLoad): LeakItem[] {
  const base = { at: l.doneAt, loadId: l.loadId, label: l.loadNumber ?? "A load", lane: l.lane, customer: l.customer, truck: l.truck };
  const out: LeakItem[] = [];
  if (l.isTonu) {
    if (l.tonuRevenue > 0 && !l.invoiced) out.push({ ...base, key: "tonu_uninvoiced", dollars: l.tonuRevenue, miles: 0 });
    return out;
  }
  if (l.emptyMiles > 0) out.push({ ...base, key: "empty_miles", dollars: finite(l.floor) && l.floor > 0 ? l.emptyMiles * l.floor : null, miles: l.emptyMiles });
  if (finite(l.floor) && l.floor > 0 && l.drivenMiles > 0) {
    const short = l.floor * l.drivenMiles - (l.gross - l.expenses);
    if (cents(short) > 0) out.push({ ...base, key: "below_floor", dollars: short, miles: 0 });
  }
  return out;
}

export type LedgerLine = {
  key: LeakKey;
  label: string;
  group: LeakGroup;
  counted: boolean;
  basis: string;
  /** The sum of the items that could be priced. */
  dollars: number;
  /** All the items, priced or not. */
  items: number;
  unpriced: number;
  unpricedMiles: number;
};
export type LedgerPeriod = { lines: LedgerLine[]; total: number; items: number; unpriced: number };

export type DrillRow = { name: string; dollars: number; items: number; unpriced: number; byKey: Partial<Record<LeakKey, number>> };
export type TopItem = { key: LeakKey; loadId: string | null; label: string; at: number; dollars: number; lane: string | null; customer: string | null; truck: string | null };

export type LedgerWeek = { label: string; end: number; byKey: Record<LeakKey, number>; total: number };

export type OpenDwell = { dollars: number; trailers: number; rows: Array<{ id: string; number: string; sinceMs: number; owed: number }> };

export type LeakLedger = {
  window: TimeWindow;
  previous: TimeWindow | null;
  current: LedgerPeriod;
  prior: LedgerPeriod | null;
  weeks: LedgerWeek[];
  byLane: DrillRow[];
  byCustomer: DrillRow[];
  byTruck: DrillRow[];
  /** The biggest single items in the period, the loads to open first. */
  top: TopItem[];
  /** What is sitting there right now and not yet a dated leak: trailers past their free time, owed and not billed. */
  openDwell: OpenDwell;
};

const emptyByKey = (): Record<LeakKey, number> => ({ empty_miles: 0, below_floor: 0, detention_unbilled: 0, tonu_uninvoiced: 0, detention_waived: 0, dwell_forgone: 0 });

function periodOf(items: readonly LeakItem[]): LedgerPeriod {
  const lines: LedgerLine[] = LEAKS.map((m) => {
    const mine = items.filter((i) => i.key === m.key);
    const priced = mine.filter((i) => i.dollars != null);
    return {
      key: m.key,
      label: m.label,
      group: m.group,
      counted: m.counted,
      basis: m.basis,
      dollars: fromCents(priced.reduce((s, i) => s + cents(i.dollars!), 0)),
      items: mine.length,
      unpriced: mine.length - priced.length,
      unpricedMiles: mine.filter((i) => i.dollars == null).reduce((s, i) => s + i.miles, 0)
    };
  });
  const counted = lines.filter((l) => l.counted);
  return { lines, total: fromCents(counted.reduce((s, l) => s + cents(l.dollars), 0)), items: counted.reduce((s, l) => s + l.items, 0), unpriced: counted.reduce((s, l) => s + l.unpriced, 0) };
}

function drill(items: readonly LeakItem[], by: (i: LeakItem) => string | null, limit: number): DrillRow[] {
  const rows = new Map<string, { cents: number; items: number; unpriced: number; byKey: Map<LeakKey, number> }>();
  for (const i of items) {
    if (!leakMeta(i.key).counted) continue;
    const name = by(i);
    if (!name) continue;
    const r = rows.get(name) ?? { cents: 0, items: 0, unpriced: 0, byKey: new Map() };
    r.items += 1;
    if (i.dollars == null) r.unpriced += 1;
    else {
      r.cents += cents(i.dollars);
      r.byKey.set(i.key, (r.byKey.get(i.key) ?? 0) + cents(i.dollars));
    }
    rows.set(name, r);
  }
  return [...rows.entries()]
    .map(([name, r]) => ({ name, dollars: fromCents(r.cents), items: r.items, unpriced: r.unpriced, byKey: Object.fromEntries([...r.byKey].map(([k, v]) => [k, fromCents(v)])) as Partial<Record<LeakKey, number>> }))
    .sort((a, b) => b.dollars - a.dollars || b.items - a.items || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Every item, as a ledger: the period (and the one before it), twelve weeks, the lanes, customers and trucks it came from, and the biggest single items. `now` and `tz` are the clock the weeks and periods are
 * counted on (the workspace's own zone).
 */
export function buildLeakLedger(items: readonly LeakItem[], opts: { period: KpiPeriod; compare: boolean; openDwell?: OpenDwell | null }, now: number, tz: string = activeTz()): LeakLedger {
  const window = periodWindow(opts.period, now, tz);
  const previous = opts.compare ? previousWindow(opts.period, now, tz) : null;
  const inNow = items.filter((i) => inWindow(i.at, window));
  const inBefore = previous ? items.filter((i) => inWindow(i.at, previous)) : null;
  const weeks: LedgerWeek[] = weekBuckets(now, 12, tz).map((b) => {
    const mine = items.filter((i) => i.at > b.start && i.at <= b.end);
    const byKey = emptyByKey();
    for (const m of LEAKS) byKey[m.key] = fromCents(mine.filter((i) => i.key === m.key && i.dollars != null).reduce((s, i) => s + cents(i.dollars!), 0));
    const total = fromCents(LEAKS.filter((m) => m.counted).reduce((s, m) => s + cents(byKey[m.key]), 0));
    return { label: b.label, end: b.end, byKey, total };
  });
  const top = inNow
    .filter((i) => i.dollars != null && leakMeta(i.key).counted)
    .sort((a, b) => b.dollars! - a.dollars! || b.at - a.at)
    .slice(0, 25)
    .map((i): TopItem => ({ key: i.key, loadId: i.loadId, label: i.label, at: i.at, dollars: i.dollars!, lane: i.lane, customer: i.customer, truck: i.truck }));
  return {
    window,
    previous,
    current: periodOf(inNow),
    prior: inBefore ? periodOf(inBefore) : null,
    weeks,
    byLane: drill(inNow, (i) => i.lane, 10),
    byCustomer: drill(inNow, (i) => i.customer, 10),
    byTruck: drill(inNow, (i) => i.truck, 10),
    top,
    openDwell: opts.openDwell ?? { dollars: 0, trailers: 0, rows: [] }
  };
}

/** A dollar figure from an audit trail's text ("$165.00"), or null when it is not one ("Waived"). */
export function dollarsOf(text: unknown): number | null {
  if (typeof text !== "string") return null;
  const m = /^\s*\$?\s*(-?[\d,]+(?:\.\d+)?)\s*$/.exec(text);
  if (!m) return null;
  const n = Number.parseFloat(m[1]!.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * What a dwell waiver or adjustment gave up, from the audit event's "Owed" before and after: a waiver reads "$165.00" then "$0.00" (or "Waived"), an adjustment "$165.00" then "$90.00". Only a drop counts;
 * raising the figure is not a leak. Null when either side is not a dollar figure and the after is not a waiver.
 */
export function dwellForgone(before: unknown, after: unknown): number | null {
  const was = dollarsOf(before);
  if (was == null) return null;
  const now = typeof after === "string" && /waived/i.test(after) ? 0 : dollarsOf(after);
  if (now == null) return null;
  const gave = was - now;
  return cents(gave) > 0 ? gave : null;
}
