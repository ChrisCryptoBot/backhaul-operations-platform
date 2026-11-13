import { isFeeShortCode } from "./invoice-records";
import { floorFor, type LeakIntake } from "./leak-intake";
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
 *  - money: partner records (money plan Wave 6 step 3; gap 6 rule 2: a fee for being paid early is a cost of money, never a cut in gross). A factor's fee and a quick-pay or factor fee taken
 *    short, priced exactly from the stored invoice in whole cents, each invoice once; fuel bought with the card's discount recorded as zero, counted and never priced (no expected discount
 *    is stored); a filed IFTA return the recalculation on final rates now puts lower; and factor chargebacks, shown as a lens (the money is the fleet's to collect again, not lost).
 *
 * Two bases, never mixed. A load booked on the desk carries the floor and the detention terms frozen on it at booking. A load imported from a carrier's TMS export carries neither, so it is priced from the
 * figures the carrier gave at intake (lib/leak-intake.ts) and every such line is its own line, labelled "intake, not frozen at booking": its dollars are added to the total (they are real, and say what they
 * rest on) but never folded into a line that rests on a frozen figure.
 */
export type LeakKey =
  | "empty_miles"
  | "empty_miles_intake"
  | "below_floor"
  | "below_floor_intake"
  | "detention_unbilled"
  | "detention_unbilled_intake"
  | "tonu_uninvoiced"
  | "detention_waived"
  | "detention_waived_intake"
  | "dwell_forgone"
  | "factoring_fees"
  | "fee_short_pays"
  | "fuel_no_discount"
  | "ifta_overpaid"
  | "factor_chargebacks";
export type LeakGroup = "billed_miss" | "choice" | "cost" | "money" | "lens";

/** What every intake-priced line says it is, so a reader can never take it for a frozen figure. */
export const INTAKE_FLOOR_TAG = "intake floor, not frozen at booking";
export const INTAKE_TERMS_TAG = "intake terms, not frozen at booking";

type LeakMeta = {
  key: LeakKey;
  label: string;
  group: LeakGroup;
  counted: boolean;
  /** Priced from the carrier's intake (an imported load), not from a figure frozen at booking. */ intake: boolean;
  /** Read from a partner's record kept on the desk (the factor's figures on the invoice, a fuel card purchase, a filed IFTA return), not from a load. */ partner: boolean;
  basis: string;
  unpricedWhy: string;
};

export const LEAKS: ReadonlyArray<LeakMeta> = [
  { key: "detention_unbilled", label: "Detention not billed", group: "billed_miss", counted: true, intake: false, partner: false, basis: "Waiting past the free time at the truck's detention rate, on loads finished that week, and not on any invoice (as of now).", unpricedWhy: "waited past the free time but the truck has no detention rate" },
  { key: "detention_unbilled_intake", label: `Detention not billed, imported loads (${INTAKE_TERMS_TAG})`, group: "billed_miss", counted: true, intake: true, partner: false, basis: "Waiting past the free time, from the stop times in the imported file, at the customer's detention terms given at intake (else the fleet's), less what the file's invoice carried above the rate. The terms were not frozen on the load at booking.", unpricedWhy: "waited past the free time but the intake gives no detention rate for this customer or for the fleet" },
  { key: "tonu_uninvoiced", label: "TONU fees not invoiced", group: "billed_miss", counted: true, intake: false, partner: false, basis: "TONU fees recorded on a load that has no invoice yet (as of now), by the week the TONU was recorded.", unpricedWhy: "" },
  { key: "detention_waived", label: "Detention waived", group: "choice", counted: true, intake: false, partner: false, basis: "Detention a person marked as not billed, with their reason in the audit log, by the week the load finished.", unpricedWhy: "" },
  { key: "detention_waived_intake", label: `Detention waived, imported loads (${INTAKE_TERMS_TAG})`, group: "choice", counted: true, intake: true, partner: false, basis: "Detention a person marked as not billed on an imported load, with their reason in the audit log, worked out at the intake detention terms.", unpricedWhy: "" },
  { key: "dwell_forgone", label: "Trailer dwell waived or lowered", group: "choice", counted: true, intake: false, partner: false, basis: "The drop from the dwell owed to the figure a person set, read from the audit trail. History starts the day the audit began recording it.", unpricedWhy: "" },
  { key: "empty_miles", label: "Empty-mile cost", group: "cost", counted: true, intake: false, partner: false, basis: "Empty miles (before pickup and after delivery) times the truck's own break-even floor, frozen on the load when it was accepted. Before fuel.", unpricedWhy: "the load has no frozen floor, so its empty miles are counted but not priced" },
  { key: "empty_miles_intake", label: `Empty-mile cost, imported loads (${INTAKE_FLOOR_TAG})`, group: "cost", counted: true, intake: true, partner: false, basis: "Empty miles (before pickup and after delivery) times the cost a mile the carrier gave at intake, the truck's own else the fleet's, before fuel. An imported load has no floor frozen at booking, so this is not the truck's frozen floor.", unpricedWhy: "the intake gives no cost a mile for this truck and no fleet figure, so the empty miles are counted but not priced" },
  { key: "below_floor", label: "Paid under the floor", group: "lens", counted: false, intake: false, partner: false, basis: "What a load paid after fuel, tolls and other costs, short of the truck's own floor times the miles driven. Its empty miles are already inside this, so it is not added to the total.", unpricedWhy: "" },
  { key: "below_floor_intake", label: `Paid under the floor, imported loads (${INTAKE_FLOOR_TAG})`, group: "lens", counted: false, intake: true, partner: false, basis: "What an imported load paid, short of the intake cost a mile times the miles driven. A file carries no fuel, tolls or other costs, so nothing is taken off the pay and the shortfall can only be understated. Its empty miles are already inside this, so it is not added to the total.", unpricedWhy: "" },
  { key: "factoring_fees", label: "Factoring fees", group: "money", counted: true, intake: false, partner: true, basis: "The factor's fee stored on each invoice it funded and has not charged back, by the week it funded it (Invoice.factoringFundedAt). A cost of money, never taken off gross (gap 6, rule 2). An invoice is counted once: a fee taken short on the same invoice is not counted again.", unpricedWhy: "" },
  { key: "fee_short_pays", label: "Quick-pay and factor fees taken short", group: "money", counted: true, intake: false, partner: false, basis: "Short pays written off with the code quick_pay_fee or factor_fee, by the week the invoice closed (Invoice.paidAt), at the amount written off. Not counted on an invoice that already carries a factoring fee, or that the factor owned when it closed (the factor's, as in the journal).", unpricedWhy: "" },
  { key: "fuel_no_discount", label: "Fuel bought with no card discount", group: "money", counted: true, intake: false, partner: true, basis: "Settled fuel purchases whose card or file recorded the discount as zero, by the week bought (else posted). No expected discount for a card, network or stop is stored, so what was missed is counted and never priced. A purchase whose source said nothing about a discount is not counted.", unpricedWhy: "no expected discount is stored for the card, network or stop, so the discount missed cannot be priced" },
  { key: "ifta_overpaid", label: "IFTA returns filed higher than the recalculation", group: "money", counted: true, intake: false, partner: true, basis: "A filed IFTA return's total less the same quarter recalculated now, when that is above zero (tax overpaid or a credit not claimed), by the week it was filed. Priced only when every rate is final and none is missing; otherwise counted and not priced. The whole fleet's filing, shown only with all terminals in view.", unpricedWhy: "the quarter's rates are not all final, or one is missing, so the recalculation is not settled and nothing is priced" },
  { key: "factor_chargebacks", label: "Factor chargebacks (not in the total)", group: "money", counted: false, intake: false, partner: true, basis: "The recourse the factor charged back, gross: the amount stored on the invoice by the week it was charged back (Invoice.factoringChargedBackAt). It is not reduced when the customer pays later; that money arrives as a payment, and each item says whether it has. The invoice is the fleet's to collect again, so this is not a loss and is never added to the total.", unpricedWhy: "" }
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
  /** Imported from a file (channel "import:<batch>"): it carries no frozen floor and no frozen detention terms, so it is priced from the carrier's intake. */
  imported?: boolean;
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
  /** What the dollars rest on, in words (the intake figure and whose it is), printed beside the item. Null for a figure frozen on the load. */
  basisNote?: string | null;
  /** Where the item is opened, when it is not a load (an invoice, a fuel purchase, an IFTA quarter). */
  href?: string | null;
  /** The one stored record a partner item was read from ("invoice:<id>", "fuel:<id>", "ifta:<id>"): no record is priced in two counted lines. */
  recordId?: string | null;
};

const cents = (n: number): number => Math.round(n * 100);
const atCents = (c: number): number => c / 100;
const fromCents = (c: number): number => c / 100;
const finite = (n: number | null | undefined): n is number => n != null && Number.isFinite(n);

/**
 * The leaks one finished load carries on its own (detention and dwell come from their own reads). A floor frozen on the load always wins. An imported load with none is priced from the carrier's intake
 * (`intake`): its own lines, labelled as such. A load booked on the desk with none is counted and not priced, as before: the intake speaks for imported history only.
 */
export function loadLeaks(l: LeakLoad, intake?: LeakIntake | null): LeakItem[] {
  const base = { at: l.doneAt, loadId: l.loadId, label: l.loadNumber ?? "A load", lane: l.lane, customer: l.customer, truck: l.truck };
  const out: LeakItem[] = [];
  if (l.isTonu) {
    if (l.tonuRevenue > 0 && !l.invoiced) out.push({ ...base, key: "tonu_uninvoiced", dollars: l.tonuRevenue, miles: 0 });
    return out;
  }
  if (finite(l.floor) && l.floor > 0) {
    if (l.emptyMiles > 0) out.push({ ...base, key: "empty_miles", dollars: l.emptyMiles * l.floor, miles: l.emptyMiles });
    if (l.drivenMiles > 0) {
      const short = l.floor * l.drivenMiles - (l.gross - l.expenses);
      if (cents(short) > 0) out.push({ ...base, key: "below_floor", dollars: short, miles: 0 });
    }
    return out;
  }
  if (l.imported) {
    const f = floorFor(intake, l.truck);
    if (l.emptyMiles > 0) out.push({ ...base, key: "empty_miles_intake", dollars: f ? l.emptyMiles * f.rpm : null, miles: l.emptyMiles, basisNote: f?.note ?? null });
    if (f && l.drivenMiles > 0) {
      const short = f.rpm * l.drivenMiles - (l.gross - l.expenses);
      if (cents(short) > 0) out.push({ ...base, key: "below_floor_intake", dollars: short, miles: 0, basisNote: f.note });
    }
    return out;
  }
  if (l.emptyMiles > 0) out.push({ ...base, key: "empty_miles", dollars: null, miles: l.emptyMiles });
  return out;
}

// ── Partner records (money plan Wave 6 step 3) ──────────────────────────────────────────────────

/** An invoice reduced to what the partner lines need, in whole cents. `place` is the one load it carries (lane, truck), or null for an invoice of several loads. */
export type PartnerInvoice = {
  id: string;
  number: string;
  /** open | paid | void */
  status: string;
  customer: string | null;
  feeCents: number | null;
  fundedAt: number | null;
  chargebackCents: number | null;
  chargedBackAt: number | null;
  paidAt: number | null;
  writeOffCents: number | null;
  writeOffCode: string | null;
  /** Payments by the customer (not credits) after the chargeback, for the chargeback's note. */
  paidSinceChargebackCents: number;
  place: { loadId: string; lane: string | null; truck: string | null } | null;
};
export type PartnerFuel = { id: string; label: string; at: number; truck: string | null };
/** A filed IFTA return and the same quarter recalculated now. Totals are exact decimal text ("123.45"); `liveTotal` is null when the recalculation has no total. */
export type PartnerIfta = { id: string; quarter: string; filedAt: number; filedTotal: string; liveTotal: string | null; liveRatesFinal: boolean; liveMissingRate: boolean };
export type PartnerRecords = { invoices: readonly PartnerInvoice[]; fuel: readonly PartnerFuel[]; ifta: readonly PartnerIfta[] };

/** "123.45" or "-0.10" as whole cents (exact; never through a float sum). */
function textCents(s: string): number {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) throw new Error(`Not a money amount: ${s}`);
  const c = Number.parseInt(m[2]!, 10) * 100 + Number.parseInt((m[3] ?? "0").padEnd(2, "0"), 10);
  return m[1] ? -c : c;
}

/**
 * The partner lines' items. Each priced item carries the cents stored on its record (as dollars with two places, so the ledger's cent sums are exact) and its record id. One invoice is priced
 * once: its factoring fee when it has one; else a fee taken short, unless the factor owned the invoice when it closed (that write-off is the factor's, as the journal books it).
 */
export function partnerLeaks(r: PartnerRecords): LeakItem[] {
  const out: LeakItem[] = [];
  for (const i of r.invoices) {
    if (i.status === "void") continue;
    const base = { loadId: i.place?.loadId ?? null, label: i.number, lane: i.place?.lane ?? null, customer: i.customer, truck: i.place?.truck ?? null, miles: 0, href: `/invoices/${i.id}`, recordId: `invoice:${i.id}` };
    const fee = i.chargebackCents == null && i.fundedAt != null && i.feeCents != null && i.feeCents > 0;
    if (fee) out.push({ ...base, key: "factoring_fees", at: i.fundedAt!, dollars: atCents(i.feeCents!) });
    const factorOwned = i.fundedAt != null && i.paidAt != null && i.paidAt >= i.fundedAt && !(i.chargedBackAt != null && i.paidAt >= i.chargedBackAt);
    if (!fee && !factorOwned && i.paidAt != null && i.writeOffCents != null && i.writeOffCents > 0 && isFeeShortCode(i.writeOffCode))
      out.push({ ...base, key: "fee_short_pays", at: i.paidAt, dollars: atCents(i.writeOffCents), basisNote: i.writeOffCode === "quick_pay_fee" ? "quick-pay fee" : "factor fee" });
    if (i.chargebackCents != null && i.chargebackCents > 0 && i.chargedBackAt != null)
      out.push({ ...base, key: "factor_chargebacks", at: i.chargedBackAt, dollars: atCents(i.chargebackCents), basisNote: i.paidSinceChargebackCents > 0 ? `the customer has paid $${(i.paidSinceChargebackCents / 100).toFixed(2)} since` : "not collected since" });
  }
  for (const f of r.fuel) out.push({ key: "fuel_no_discount", at: f.at, dollars: null, miles: 0, loadId: null, label: f.label, lane: null, customer: null, truck: f.truck, href: "/fuel?days=90", recordId: `fuel:${f.id}` });
  for (const q of r.ifta) {
    const base = { key: "ifta_overpaid" as const, at: q.filedAt, miles: 0, loadId: null, label: `${q.quarter} IFTA return`, lane: null, customer: null, truck: null, href: `/ifta?quarter=${q.quarter}`, recordId: `ifta:${q.id}` };
    if (!q.liveRatesFinal || q.liveMissingRate || q.liveTotal == null) {
      out.push({ ...base, dollars: null });
      continue;
    }
    const over = textCents(q.filedTotal) - textCents(q.liveTotal);
    if (over > 0) out.push({ ...base, dollars: atCents(over), basisNote: `filed $${q.filedTotal}, recalculated $${q.liveTotal}` });
  }
  return out;
}

export type LedgerLine = {
  key: LeakKey;
  label: string;
  group: LeakGroup;
  counted: boolean;
  /** Priced from the carrier's intake, not from a figure frozen at booking. */
  intake: boolean;
  /** Read from a partner's record (factor, fuel card, IFTA return). */
  partner: boolean;
  basis: string;
  /** The sum of the items that could be priced. */
  dollars: number;
  /** All the items, priced or not. */
  items: number;
  unpriced: number;
  unpricedMiles: number;
};
export type LedgerPeriod = {
  lines: LedgerLine[];
  total: number;
  items: number;
  unpriced: number;
  /** The part of the counted total (and of its items) that rests on the carrier's intake, not on a figure frozen at booking. Always inside `total`, never added to it. */
  intake: { dollars: number; items: number; unpriced: number };
  /** The part of the counted total that is cost of money and partner records (the "money" group). Always inside `total`, never added to it. */
  money: { dollars: number; items: number; unpriced: number };
};

export type DrillRow = { name: string; dollars: number; /** The part of `dollars` priced from the intake. */ intake: number; items: number; unpriced: number; byKey: Partial<Record<LeakKey, number>> };
export type TopItem = { key: LeakKey; loadId: string | null; label: string; at: number; dollars: number; lane: string | null; customer: string | null; truck: string | null; intake: boolean; partner: boolean; basisNote: string | null; href: string | null };

export type LedgerWeek = { label: string; end: number; byKey: Record<LeakKey, number>; total: number; /** The counted "money" lines added together (inside `total`), for a screen too narrow for a column each. */ money: number };

export type OpenDwell = { dollars: number; trailers: number; rows: Array<{ id: string; number: string; sinceMs: number; owed: number }> };

/**
 * What the ledger could not look at, counted apart from the dollars: imported loads whose file carried no stop times cannot be checked for detention at all (nothing is estimated for them), and
 * the screen lists a few so they can be found.
 */
export type LedgerCoverage = { importedLoads: number; noStopTimes: { loads: number; sample: Array<{ loadId: string; label: string }> } };
export const NO_COVERAGE: LedgerCoverage = { importedLoads: 0, noStopTimes: { loads: 0, sample: [] } };

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
  /** Imported loads that could not be checked for detention (the file had no stop times), for the "counted, not priced" list. */
  coverage: LedgerCoverage;
  /** With terminals in view: partner items in the period that belong to no one terminal (an invoice whose loads span terminals or that has none, fuel on no truck or a truck with no terminal, an IFTA return), left out of this view's figures. */
  fleetOnly: { items: number; byKey: Partial<Record<LeakKey, number>> };
};

const emptyByKey = (): Record<LeakKey, number> => Object.fromEntries(LEAKS.map((m) => [m.key, 0])) as Record<LeakKey, number>;

function periodOf(items: readonly LeakItem[]): LedgerPeriod {
  const lines: LedgerLine[] = LEAKS.map((m) => {
    const mine = items.filter((i) => i.key === m.key);
    const priced = mine.filter((i) => i.dollars != null);
    return {
      key: m.key,
      label: m.label,
      group: m.group,
      counted: m.counted,
      intake: m.intake,
      partner: m.partner,
      basis: m.basis,
      dollars: fromCents(priced.reduce((s, i) => s + cents(i.dollars!), 0)),
      items: mine.length,
      unpriced: mine.length - priced.length,
      unpricedMiles: mine.filter((i) => i.dollars == null).reduce((s, i) => s + i.miles, 0)
    };
  });
  const counted = lines.filter((l) => l.counted);
  const fromIntake = counted.filter((l) => l.intake);
  const money = counted.filter((l) => l.group === "money");
  return {
    lines,
    total: fromCents(counted.reduce((s, l) => s + cents(l.dollars), 0)),
    items: counted.reduce((s, l) => s + l.items, 0),
    unpriced: counted.reduce((s, l) => s + l.unpriced, 0),
    intake: { dollars: fromCents(fromIntake.reduce((s, l) => s + cents(l.dollars), 0)), items: fromIntake.reduce((s, l) => s + l.items, 0), unpriced: fromIntake.reduce((s, l) => s + l.unpriced, 0) },
    money: { dollars: fromCents(money.reduce((s, l) => s + cents(l.dollars), 0)), items: money.reduce((s, l) => s + l.items, 0), unpriced: money.reduce((s, l) => s + l.unpriced, 0) }
  };
}

function drill(items: readonly LeakItem[], by: (i: LeakItem) => string | null, limit: number): DrillRow[] {
  const rows = new Map<string, { cents: number; intake: number; items: number; unpriced: number; byKey: Map<LeakKey, number> }>();
  for (const i of items) {
    if (!leakMeta(i.key).counted) continue;
    const name = by(i);
    if (!name) continue;
    const r = rows.get(name) ?? { cents: 0, intake: 0, items: 0, unpriced: 0, byKey: new Map() };
    r.items += 1;
    if (i.dollars == null) r.unpriced += 1;
    else {
      r.cents += cents(i.dollars);
      if (leakMeta(i.key).intake) r.intake += cents(i.dollars);
      r.byKey.set(i.key, (r.byKey.get(i.key) ?? 0) + cents(i.dollars));
    }
    rows.set(name, r);
  }
  return [...rows.entries()]
    .map(([name, r]) => ({ name, dollars: fromCents(r.cents), intake: fromCents(r.intake), items: r.items, unpriced: r.unpriced, byKey: Object.fromEntries([...r.byKey].map(([k, v]) => [k, fromCents(v)])) as Partial<Record<LeakKey, number>> }))
    .sort((a, b) => b.dollars - a.dollars || b.items - a.items || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/**
 * Every item, as a ledger: the period (and the one before it), twelve weeks, the lanes, customers and trucks it came from, and the biggest single items. `now` and `tz` are the clock the weeks and periods are
 * counted on (the workspace's own zone).
 */
export function buildLeakLedger(items: readonly LeakItem[], opts: { period: KpiPeriod; compare: boolean; openDwell?: OpenDwell | null; coverage?: LedgerCoverage | null; fleetOnly?: readonly LeakItem[] | null }, now: number, tz: string = activeTz()): LeakLedger {
  const window = periodWindow(opts.period, now, tz);
  const previous = opts.compare ? previousWindow(opts.period, now, tz) : null;
  const inNow = items.filter((i) => inWindow(i.at, window));
  const inBefore = previous ? items.filter((i) => inWindow(i.at, previous)) : null;
  const weeks: LedgerWeek[] = weekBuckets(now, 12, tz).map((b) => {
    const mine = items.filter((i) => i.at > b.start && i.at <= b.end);
    const byKey = emptyByKey();
    for (const m of LEAKS) byKey[m.key] = fromCents(mine.filter((i) => i.key === m.key && i.dollars != null).reduce((s, i) => s + cents(i.dollars!), 0));
    const total = fromCents(LEAKS.filter((m) => m.counted).reduce((s, m) => s + cents(byKey[m.key]), 0));
    const money = fromCents(LEAKS.filter((m) => m.counted && m.group === "money").reduce((s, m) => s + cents(byKey[m.key]), 0));
    return { label: b.label, end: b.end, byKey, total, money };
  });
  const top = inNow
    .filter((i) => i.dollars != null && leakMeta(i.key).counted)
    .sort((a, b) => b.dollars! - a.dollars! || b.at - a.at)
    .slice(0, 25)
    .map((i): TopItem => ({ key: i.key, loadId: i.loadId, label: i.label, at: i.at, dollars: i.dollars!, lane: i.lane, customer: i.customer, truck: i.truck, intake: leakMeta(i.key).intake, partner: leakMeta(i.key).partner, basisNote: i.basisNote ?? null, href: i.href ?? null }));
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
    openDwell: opts.openDwell ?? { dollars: 0, trailers: 0, rows: [] },
    coverage: opts.coverage ?? NO_COVERAGE,
    fleetOnly: fleetOnlyIn(opts.fleetOnly ?? [], window)
  };
}

function fleetOnlyIn(items: readonly LeakItem[], window: TimeWindow): LeakLedger["fleetOnly"] {
  const mine = items.filter((i) => inWindow(i.at, window));
  const byKey: Partial<Record<LeakKey, number>> = {};
  for (const i of mine) byKey[i.key] = (byKey[i.key] ?? 0) + 1;
  return { items: mine.length, byKey };
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
