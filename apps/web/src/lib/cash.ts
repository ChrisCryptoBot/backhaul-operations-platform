import { dayIn, factoringWindow, releasedAt, type JInvoice } from "./journal";
import { inWindow, type TimeWindow } from "./kpi-periods";
import { partnerLeaks, type PartnerInvoice } from "./leaks";

/**
 * Cash beside gross (money plan Wave 6 step 4). Pure, in whole cents. Gross stays the agreed rate everywhere (gap 6, rule 2); this reads the money that actually moved, the way the journal books
 * it (lib/journal.ts), so the two cannot disagree:
 *   customer payments   a payment row that is not an applied credit, and not made while the factor owned the invoice (that money went to the factor);
 *   factor advances     the advance on the day the factor funded it (the journal's own figure: the amount charged back when there was a chargeback, else the advance);
 *   reserve released    the reserve the factor released, on its stored day, unless the invoice was charged back;
 *   chargebacks         the advance going back to the factor on the day it charged the invoice back (a minus).
 * Cash in is the four added together. Cost of money is the Leak ledger's own two lines (factoring fees, quick-pay and factor fees taken short; lib/leaks.ts partnerLeaks), so the two screens
 * cannot disagree either. Days to cash count calendar days in the workspace's zone from the day an invoice was issued, and an invoice that has not been paid is counted as waiting, never as days.
 */
export type CashSource = "customer" | "advance" | "released" | "chargeback";
export const CASH_SOURCES: readonly CashSource[] = ["customer", "advance", "released", "chargeback"];
export const CASH_LABEL: Record<CashSource, string> = { customer: "Paid by customers", advance: "Advanced by the factor", released: "Reserve released", chargeback: "Charged back by the factor" };

export type CashInvoice = {
  id: string;
  number: string;
  /** open | paid */
  status: string;
  issuedAt: number;
  totalCents: number;
  paidTotalCents: number;
  paidAt: number | null;
  writeOffCents: number | null;
  writeOffCode: string | null;
  factoring: {
    status: string;
    fundedAt: number | null;
    advanceCents: number | null;
    feeCents: number | null;
    releasedCents: number | null;
    chargebackCents: number | null;
    releasedAt: number | null;
    chargedBackAt: number | null;
    updatedAt: number | null;
  };
  /** Every payment row, credits included (they are left out here). */
  payments: Array<{ id: string; cents: number; at: number; source: string }>;
  /** Who and where, for grouping: the customer billed, and the lane when the invoice carries one load (null for several). */
  customer: string | null;
  lane: string | null;
};

export type CashEvent = { invoiceId: string; number: string; source: CashSource; at: number; cents: number; customer: string | null; lane: string | null };

const d = (ms: number | null) => (ms == null ? null : new Date(ms));
const jFactoring = (i: CashInvoice): JInvoice["factoring"] => ({
  fundedAt: d(i.factoring.fundedAt),
  advance: i.factoring.advanceCents,
  fee: i.factoring.feeCents,
  reserveReleased: i.factoring.releasedCents,
  chargeback: i.factoring.chargebackCents,
  reserveReleasedAt: d(i.factoring.releasedAt),
  chargedBackAt: d(i.factoring.chargedBackAt),
  updatedAt: d(i.factoring.updatedAt)
});

/** The money that moved on one invoice, in the journal's terms. A funding with no advance recorded books nothing here, as the journal refuses it. */
export function cashEvents(i: CashInvoice): CashEvent[] {
  const f = jFactoring(i);
  const base = { invoiceId: i.id, number: i.number, customer: i.customer, lane: i.lane };
  const out: CashEvent[] = [];
  const { chargedAt, owns } = factoringWindow(f);
  let factoringOk = true;
  if (f.fundedAt) {
    const advance = f.chargeback ?? f.advance;
    if (advance == null) factoringOk = false;
    else {
      out.push({ ...base, source: "advance", at: f.fundedAt.getTime(), cents: advance });
      if (f.chargeback == null && f.reserveReleased != null && f.reserveReleased > 0) out.push({ ...base, source: "released", at: releasedAt({ paidAt: d(i.paidAt), factoring: f })!.getTime(), cents: f.reserveReleased });
      if (chargedAt) out.push({ ...base, source: "chargeback", at: chargedAt.getTime(), cents: -advance });
    }
  }
  for (const p of i.payments) {
    if (p.source === "credit") continue;
    if (factoringOk && owns(new Date(p.at))) continue;
    out.push({ ...base, source: "customer", at: p.at, cents: p.cents });
  }
  return out;
}

export type CashSums = Record<CashSource, number> & { net: number };
const zero = (): CashSums => ({ customer: 0, advance: 0, released: 0, chargeback: 0, net: 0 });
export function sumEvents(events: readonly CashEvent[]): CashSums {
  const s = zero();
  for (const e of events) {
    s[e.source] += e.cents;
    s.net += e.cents;
  }
  return s;
}

/** The two Leak ledger lines that are the cost of money, from the same rule, in cents. */
export function costOfMoney(invoices: readonly CashInvoice[], inside: (at: number) => boolean): { feesCents: number; shortCents: number; items: number } {
  const p: PartnerInvoice[] = invoices.map((i) => ({
    id: i.id,
    number: i.number,
    status: i.status,
    customer: i.customer,
    feeCents: i.factoring.feeCents,
    fundedAt: i.factoring.fundedAt,
    chargebackCents: i.factoring.chargebackCents,
    chargedBackAt: i.factoring.chargedBackAt,
    paidAt: i.paidAt,
    writeOffCents: i.writeOffCents,
    writeOffCode: i.writeOffCode,
    paidSinceChargebackCents: 0,
    place: null
  }));
  const items = partnerLeaks({ invoices: p, fuel: [], ifta: [] }).filter((x) => (x.key === "factoring_fees" || x.key === "fee_short_pays") && inside(x.at));
  // Each item's dollars are its stored cents over 100: back to cents exactly.
  const c = (k: string) => items.filter((x) => x.key === k).reduce((s, x) => s + Math.round(x.dollars! * 100), 0);
  return { feesCents: c("factoring_fees"), shortCents: c("fee_short_pays"), items: items.length };
}

/** Calendar days between two moments, on the workspace's clock. */
export function calendarDays(from: number, to: number, tz: string): number {
  const day = dayIn(tz);
  const utc = (ms: number) => {
    const [y, m, dd] = day(new Date(ms)).split("-").map((x) => Number.parseInt(x, 10));
    return Date.UTC(y!, m! - 1, dd!);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** When an invoice was paid in full: closed paid, on the factor's release when it released one, else the day it closed. Null while it is open. */
export function fullyPaidAt(i: CashInvoice): number | null {
  if (i.status !== "paid") return null;
  const f = i.factoring;
  if (f.chargebackCents == null && f.releasedCents != null && f.releasedCents > 0) return releasedAt({ paidAt: d(i.paidAt), factoring: jFactoring(i) })!.getTime();
  return i.paidAt;
}
export function firstCashAt(i: CashInvoice): number | null {
  const ins = cashEvents(i).filter((e) => e.cents > 0);
  return ins.length === 0 ? null : Math.min(...ins.map((e) => e.at));
}

export type DayStats = { reached: number; waiting: number; median: number | null; p90: number | null };
/** Median and 90th percentile (nearest rank) over the invoices that got there; the rest are counted as waiting, never as days. */
export function dayStats(days: ReadonlyArray<number | null>): DayStats {
  const got = days.filter((x): x is number => x != null).sort((a, b) => a - b);
  const rank = (q: number) => (got.length === 0 ? null : got[Math.max(0, Math.ceil(q * got.length) - 1)]!);
  return { reached: got.length, waiting: days.length - got.length, median: rank(0.5), p90: rank(0.9) };
}
export type DaysToCash = { invoices: number; firstCash: DayStats; paidInFull: DayStats };
export function daysToCash(issued: readonly CashInvoice[], tz: string): DaysToCash {
  const first = issued.map((i) => {
    const at = firstCashAt(i);
    return at == null ? null : calendarDays(i.issuedAt, at, tz);
  });
  const full = issued.map((i) => {
    const at = fullyPaidAt(i);
    return at == null ? null : calendarDays(i.issuedAt, at, tz);
  });
  return { invoices: issued.length, firstCash: dayStats(first), paidInFull: dayStats(full) };
}

export type PeriodCash = { cash: CashSums; cost: { feesCents: number; shortCents: number; items: number }; days: DaysToCash };
export function periodCash(invoices: readonly CashInvoice[], window: TimeWindow, tz: string): PeriodCash {
  const inside = (at: number) => inWindow(at, window);
  return {
    cash: sumEvents(invoices.flatMap(cashEvents).filter((e) => inside(e.at))),
    cost: costOfMoney(invoices, inside),
    days: daysToCash(invoices.filter((i) => inside(i.issuedAt)), tz)
  };
}

/** What is still owed on open invoices right now, and how much of it sits with invoices a factor has funded (their customer pays the factor; the fleet gets the reserve). */
export function openBalance(invoices: readonly CashInvoice[]): { cents: number; invoices: number; factoredCents: number; factoredInvoices: number } {
  const open = invoices.filter((i) => i.status === "open" && i.totalCents - i.paidTotalCents > 0);
  const fac = open.filter((i) => i.factoring.status === "funded");
  const bal = (xs: CashInvoice[]) => xs.reduce((s, i) => s + i.totalCents - i.paidTotalCents, 0);
  return { cents: bal(open), invoices: open.length, factoredCents: bal(fac), factoredInvoices: fac.length };
}

// ── Why it moved, on cash ────────────────────────────────────────────────────────────────────────

export type CashEffect = { source: CashSource; label: string; cents: number };
export type CashBridge = { before: CashSums; after: CashSums; change: number; effects: CashEffect[] };
/** Cash in this week against last, split by where it came from; the effects add up to the change to the cent. */
export function cashBridge(before: CashSums, after: CashSums): CashBridge {
  const effects = CASH_SOURCES.map((s) => ({ source: s, label: CASH_LABEL[s], cents: after[s] - before[s] }));
  return { before, after, change: after.net - before.net, effects };
}
export type CashRow = { name: string; before: number; after: number; change: number };
export type CashMoves = { bridge: CashBridge; rows: CashRow[]; days: { before: DayStats; after: DayStats } };
/**
 * Two weeks of cash, by lane or customer: every event lands in one row (an invoice of several loads is "Several lanes"; one with no customer named is "No customer named"), so the rows add up to the
 * change. Days to cash: issued to paid in full, for the invoices paid in full in each week.
 */
export function cashMoves(invoices: readonly CashInvoice[], before: { start: number; end: number }, after: { start: number; end: number }, by: "lane" | "customer", tz: string): CashMoves {
  const inWeek = (w: { start: number; end: number }) => (at: number) => at > w.start && at <= w.end;
  const events = invoices.flatMap(cashEvents);
  const a = events.filter((e) => inWeek(before)(e.at));
  const b = events.filter((e) => inWeek(after)(e.at));
  const key = (e: CashEvent) => (by === "lane" ? (e.lane ?? "Several lanes") : (e.customer ?? "No customer named"));
  const rows = new Map<string, CashRow>();
  for (const [list, side] of [[a, "before"], [b, "after"]] as const)
    for (const e of list) {
      const r = rows.get(key(e)) ?? { name: key(e), before: 0, after: 0, change: 0 };
      r[side] += e.cents;
      r.change = r.after - r.before;
      rows.set(key(e), r);
    }
  const paidIn = (w: { start: number; end: number }) =>
    dayStats(
      invoices
        .map((i) => ({ i, at: fullyPaidAt(i) }))
        .filter((x) => x.at != null && inWeek(w)(x.at))
        .map((x) => calendarDays(x.i.issuedAt, x.at!, tz))
    );
  return {
    bridge: cashBridge(sumEvents(a), sumEvents(b)),
    rows: [...rows.values()].sort((x, y) => Math.abs(y.change) - Math.abs(x.change) || x.name.localeCompare(y.name)),
    days: { before: paidIn(before), after: paidIn(after) }
  };
}

// ── One table for the file (the card shows the same figures) ─────────────────────────────────────

export type CashRowOut = { group: string; measure: string; unit: "dollars" | "invoices" | "days"; now: number | null; before: number | null };
type KpiCashLike = { current: PeriodCash; prior: PeriodCash | null; open: ReturnType<typeof openBalance>; leftOut: number };
const dollars = (c: number | null) => (c == null ? null : c / 100);
/** The KPI cash figures as rows: cash in by source, cost of money, days to cash, what is owed now, and what could not be placed in the view. Dollars exact to the cent. */
export function cashFileRows(k: KpiCashLike): CashRowOut[] {
  const p = k.prior;
  const both = (group: string, measure: string, unit: CashRowOut["unit"], f: (x: PeriodCash) => number | null): CashRowOut => ({ group, measure, unit, now: f(k.current), before: p ? f(p) : null });
  const money = (f: (x: PeriodCash) => number) => (x: PeriodCash) => dollars(f(x));
  const days = (label: string, pick: (x: PeriodCash) => DayStats): CashRowOut[] => [
    both("Days to cash", `${label}: reached`, "invoices", (x) => pick(x).reached),
    both("Days to cash", `${label}: still waiting`, "invoices", (x) => pick(x).waiting),
    both("Days to cash", `${label}: median days`, "days", (x) => pick(x).median),
    both("Days to cash", `${label}: 90th percentile days`, "days", (x) => pick(x).p90)
  ];
  return [
    ...CASH_SOURCES.map((s) => both("Cash in", CASH_LABEL[s], "dollars", money((x) => x.cash[s]))),
    both("Cash in", "Cash in, net", "dollars", money((x) => x.cash.net)),
    both("Cost of money", "Factoring fees", "dollars", money((x) => x.cost.feesCents)),
    both("Cost of money", "Quick-pay and factor fees taken short", "dollars", money((x) => x.cost.shortCents)),
    both("Cost of money", "Cost of money", "dollars", money((x) => x.cost.feesCents + x.cost.shortCents)),
    both("Days to cash", "Invoices issued", "invoices", (x) => x.days.invoices),
    ...days("First cash", (x) => x.days.firstCash),
    ...days("Paid in full", (x) => x.days.paidInFull),
    { group: "Still owed now", measure: "Open balance", unit: "dollars", now: dollars(k.open.cents), before: null },
    { group: "Still owed now", measure: "Open invoices", unit: "invoices", now: k.open.invoices, before: null },
    { group: "Still owed now", measure: "Of it, on invoices a factor funded", unit: "dollars", now: dollars(k.open.factoredCents), before: null },
    { group: "Left out", measure: "Invoices whose loads are both in and out of this view, or that carry no load", unit: "invoices", now: k.leftOut, before: null }
  ];
}
