import { toCents } from "./form1099";
import { projectToLoads } from "./invoice-records";

/**
 * Money integrity (docs/MONEY_PLAN.md, Wave 6 step 2): seven checks that the desk's own money records agree with each other, and with QuickBooks and the factor as far as the desk keeps
 * their side. Pure and in whole cents: the server reads the records (server/tl/data-health.ts, moneyRead) and hands them over. Each check counts what it applied to and what passed, and names
 * a few failures with a link. A check that cannot be done from stored data says "not checked" and why; it is never counted as passed, and nothing is estimated.
 *
 *   invoice_lines_total   every invoice and credit memo (not void): its total is the sum of its lines.
 *   payments_over_total   every invoice (not void): payments, credits and any write-off together are no more than its total, and its paid total is the sum of its payment rows.
 *   load_projection       every invoice (not void) with loads: each load's invoiced and received amounts and its paid state are rule A's projection of the invoice (projectToLoads).
 *   settled_load_voided   every load on a final driver statement or on a paid invoice: the load is not cancelled or deleted since.
 *   fuel_deducted_twice   every fuel purchase taken off a final statement: on one final statement only, and the purchase points back to that statement.
 *   qbo_mismatch          with QuickBooks connected, every invoice and credit memo made before the last finished sync: one not void is in QuickBooks, one voided before it is not.
 *                         What was changed inside QuickBooks is not compared (the desk keeps no copy of QuickBooks' side), nor are payments.
 *   factor_mismatch       every invoice (not void) that has been with a factor: its factoring figures agree with each other, with its own state and with its loads.
 *                         The factor's own figures (its statement or status file) are applied, not kept, so they are not compared.
 */
export type MoneyCheckKey = "invoice_lines_total" | "payments_over_total" | "load_projection" | "settled_load_voided" | "fuel_deducted_twice" | "qbo_mismatch" | "factor_mismatch";

export type MoneyLoad = {
  loadId: string;
  label: string;
  status: string;
  deleted: boolean;
  factoringStatus: string;
  invoicedCents: number | null;
  paidCents: number | null;
  paymentStatus: string | null;
};

export type MoneyInvoice = {
  id: string;
  number: string;
  /** invoice | credit_memo */
  kind: string;
  /** open | paid | void */
  status: string;
  createdAt: number;
  voidedAt: number | null;
  issuedAt: Date;
  termsDays: number;
  paidAt: Date | null;
  totalCents: number;
  paidTotalCents: number;
  writeOffCents: number | null;
  /** Every payment row (customer, factor, accounting, import and applied credits), added up. */
  paymentsCents: number;
  /** In line order. */
  lines: Array<{ loadId: string | null; cents: number }>;
  /** The loads joined to the invoice. */
  loads: MoneyLoad[];
  factoring: {
    status: string;
    fundedAt: number | null;
    advanceCents: number | null;
    feeCents: number | null;
    reserveCents: number | null;
    releasedCents: number | null;
    chargebackCents: number | null;
    releasedAt: number | null;
    chargedBackAt: number | null;
  };
  /** QuickBooks holds a document for it (an external reference for this invoice or credit memo). */
  inQbo: boolean;
};

export type MoneyStatement = { id: string; number: string; loads: Array<{ loadId: string; label: string; status: string; deleted: boolean }> };
export type MoneyFuelLine = { fuelId: string; label: string; settlementId: string; settlementNumber: string; /** Where the purchase itself says it was taken off. */ purchaseSettlementId: string | null };

export type MoneyInput = {
  invoices: readonly MoneyInvoice[];
  /** Final statements only (a void statement keeps its rows but takes nothing off). */
  statements: readonly MoneyStatement[];
  /** Fuel rows of final statements. */
  fuelLines: readonly MoneyFuelLine[];
  qbo: { connected: boolean; /** The last QuickBooks sync that finished (ms), null when none has. */ lastSyncAt: number | null };
  /** The read stopped at its cap: counts are of what was read. */
  truncated: boolean;
};

export type MoneyExample = { id: string; label: string; detail: string; href: string };
export type MoneyCheck = {
  key: MoneyCheckKey;
  label: string;
  why: string;
  /** "not_checked": nothing could be compared (said in notCheckedWhy); checked and passed are then zero. */
  state: "checked" | "not_checked";
  notCheckedWhy: string | null;
  checked: number;
  passed: number;
  failed: number;
  examples: MoneyExample[];
  /** What this check cannot see, from stored data alone, even when it runs. */
  limits: string | null;
};
export type MoneyIntegrity = { checks: MoneyCheck[]; failed: number; notChecked: number; truncated: boolean };

export const MONEY_EXAMPLES = 8;
/** The most invoices (and, separately, final statements) one read takes, newest first. */
export const MONEY_READ_CAP = 20_000;

export const MONEY_CHECKS: ReadonlyArray<{ key: MoneyCheckKey; label: string; why: string; limits: string | null }> = [
  { key: "invoice_lines_total", label: "Invoice total equals its lines", why: "The PDF, the journal and QuickBooks bill the lines; a total that disagrees bills a different figure than the one aged and collected.", limits: null },
  { key: "payments_over_total", label: "Payments and credits within the invoice", why: "More received or credited than was billed is a payment on the wrong invoice or a credit given twice; a paid total that is not its payments misstates the balance.", limits: null },
  { key: "load_projection", label: "Each load's money matches its invoice", why: "Loads, aging and the KPI read the load's invoiced and received amounts; rule A says they are the invoice's lines and payments, shared in line order.", limits: null },
  { key: "settled_load_voided", label: "Settled and paid loads still stand", why: "A load paid to the driver or collected from the customer and then cancelled or deleted leaves money with no load behind it.", limits: null },
  { key: "fuel_deducted_twice", label: "Fuel taken off one statement only", why: "A card purchase taken off two final statements charges the driver twice.", limits: null },
  { key: "qbo_mismatch", label: "QuickBooks holds what the desk holds", why: "An invoice the sync could not send, or a void it could not carry across, leaves the books and the desk apart.", limits: "Changes made inside QuickBooks, and payments, are not compared: the desk keeps no copy of QuickBooks' side." },
  { key: "factor_mismatch", label: "Factoring figures agree", why: "Advance, reserve, fee, release and chargeback drive the journal, the reconciliation and cash; figures that disagree book the wrong cash.", limits: "The factor's own figures (its statement or status file) are applied, not kept on the desk, so they are not compared." }
];

const META = new Map(MONEY_CHECKS.map((c) => [c.key, c]));

/** "1234.50" (a Decimal's toFixed(2)) as whole cents; null stays null. A value that is not a plain decimal is refused, never rounded. */
export function decimalCents(v: string | null | undefined): number | null {
  if (v == null) return null;
  const c = toCents(v);
  if (c == null) throw new Error(`Not a money amount: ${v}`);
  return c;
}

export const usdCents = (c: number) => `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const centsText = (c: number) => `${c < 0 ? "-" : ""}${Math.floor(Math.abs(c) / 100)}.${String(Math.abs(c) % 100).padStart(2, "0")}`;

class Tally {
  checked = 0;
  passed = 0;
  failed = 0;
  examples: MoneyExample[] = [];
  see(ok: boolean, ex: () => MoneyExample) {
    this.checked += 1;
    if (ok) this.passed += 1;
    else {
      this.failed += 1;
      if (this.examples.length < MONEY_EXAMPLES) this.examples.push(ex());
    }
  }
  out(key: MoneyCheckKey): MoneyCheck {
    const m = META.get(key)!;
    return { key, label: m.label, why: m.why, state: "checked", notCheckedWhy: null, checked: this.checked, passed: this.passed, failed: this.failed, examples: this.examples, limits: m.limits };
  }
}
const notChecked = (key: MoneyCheckKey, why: string): MoneyCheck => {
  const m = META.get(key)!;
  return { key, label: m.label, why: m.why, state: "not_checked", notCheckedWhy: why, checked: 0, passed: 0, failed: 0, examples: [], limits: m.limits };
};

const invHref = (i: Pick<MoneyInvoice, "id">) => `/invoices/${i.id}`;
const live = (i: MoneyInvoice) => i.status !== "void";
const FACTORED_OPEN = ["requested", "submitted", "funded"];

/** Rule A's projection of an invoice onto its loads, in the order projectionOf uses (the loads its lines name, in line order, then the rest), in cents. */
export function expectedProjection(i: MoneyInvoice): Map<string, { invoicedCents: number | null; paidCents: number | null; paymentStatus: string | null }> {
  const order: string[] = [];
  for (const l of i.lines) if (l.loadId && !order.includes(l.loadId)) order.push(l.loadId);
  for (const l of i.loads) if (!order.includes(l.loadId)) order.push(l.loadId);
  const amountOf = (id: string) => i.lines.filter((l) => l.loadId === id).reduce((s, l) => s + l.cents, 0);
  const out = projectToLoads({
    number: i.number,
    status: i.status as "open" | "paid" | "void",
    issuedAt: i.issuedAt,
    termsDays: i.termsDays,
    paidTotal: centsText(i.paidTotalCents),
    paidAt: i.paidAt,
    loads: order.map((loadId) => ({ loadId, amount: centsText(amountOf(loadId)) }))
  });
  return new Map(out.map((p) => [p.loadId, { invoicedCents: decimalCents(p.invoicedAmount == null ? null : p.invoicedAmount.toFixed(2)), paidCents: decimalCents(p.paidAmount == null ? null : p.paidAmount.toFixed(2)), paymentStatus: p.paymentStatus }]));
}

/** Why an invoice's factoring disagrees with itself, its state or its loads; null when it agrees. */
export function factorProblem(i: MoneyInvoice): string | null {
  const f = i.factoring;
  const fundedish = f.status === "funded" || f.status === "paid";
  if ((fundedish || f.chargebackCents != null) && f.fundedAt == null) return "funded, with no funding day";
  if (fundedish && f.advanceCents == null) return "funded, with no advance recorded";
  if (fundedish && f.advanceCents != null && f.reserveCents != null && f.advanceCents + f.reserveCents !== i.totalCents) return `advance ${usdCents(f.advanceCents)} and reserve ${usdCents(f.reserveCents)} are not the ${usdCents(i.totalCents)} billed`;
  if (f.releasedCents != null && f.reserveCents != null && f.releasedCents > f.reserveCents - (f.feeCents ?? 0)) return `released ${usdCents(f.releasedCents)}, more than the reserve less the fee`;
  if (f.releasedCents != null && f.releasedAt == null) return "reserve released, with no release day";
  if (f.chargebackCents != null && f.chargedBackAt == null) return "charged back, with no chargeback day";
  if (f.chargebackCents != null && f.status !== "rejected") return `charged back, but the factoring says ${f.status}`;
  if (f.status === "paid" && i.status !== "paid") return "the factor says paid, but the invoice is open";
  if (i.status === "paid" && FACTORED_OPEN.includes(f.status)) return `the invoice is paid, but the factoring still says ${f.status}`;
  const off = i.loads.find((l) => !l.deleted && l.factoringStatus !== f.status);
  if (off) return `load ${off.label} says ${off.factoringStatus}, the invoice ${f.status}`;
  return null;
}

export function moneyIntegrity(input: MoneyInput): MoneyIntegrity {
  const invoices = input.invoices;

  const lines = new Tally();
  for (const i of invoices.filter(live)) {
    const sum = i.lines.reduce((s, l) => s + l.cents, 0);
    lines.see(sum === i.totalCents, () => ({ id: i.id, label: i.number, detail: `lines ${usdCents(sum)}, total ${usdCents(i.totalCents)}`, href: invHref(i) }));
  }

  const payments = new Tally();
  for (const i of invoices.filter((x) => live(x) && x.kind === "invoice")) {
    const taken = i.paymentsCents + (i.writeOffCents ?? 0);
    const over = taken > i.totalCents;
    const drift = i.paidTotalCents !== i.paymentsCents;
    payments.see(!over && !drift, () => ({
      id: i.id,
      label: i.number,
      detail: over ? `received and credited ${usdCents(i.paymentsCents)}${i.writeOffCents ? ` and ${usdCents(i.writeOffCents)} written off` : ""} on ${usdCents(i.totalCents)}` : `paid total ${usdCents(i.paidTotalCents)}, payment rows ${usdCents(i.paymentsCents)}`,
      href: invHref(i)
    }));
  }

  const projection = new Tally();
  for (const i of invoices.filter((x) => live(x) && x.kind === "invoice" && x.loads.length > 0)) {
    const want = expectedProjection(i);
    let bad: string | null = null;
    for (const l of i.loads) {
      if (l.deleted) continue;
      const w = want.get(l.loadId);
      if (!w) continue;
      if ((l.invoicedCents ?? 0) !== (w.invoicedCents ?? 0)) bad = `load ${l.label} invoiced ${usdCents(l.invoicedCents ?? 0)}, its lines ${usdCents(w.invoicedCents ?? 0)}`;
      else if ((l.paidCents ?? 0) !== (w.paidCents ?? 0)) bad = `load ${l.label} received ${usdCents(l.paidCents ?? 0)}, its share ${usdCents(w.paidCents ?? 0)}`;
      else if ((l.paymentStatus ?? null) !== w.paymentStatus) bad = `load ${l.label} says ${l.paymentStatus ?? "not invoiced"}, the invoice ${w.paymentStatus}`;
      if (bad) break;
    }
    projection.see(bad == null, () => ({ id: i.id, label: i.number, detail: bad!, href: invHref(i) }));
  }

  const standing = new Tally();
  const gone = (l: { status: string; deleted: boolean }) => l.deleted || l.status === "cancelled";
  const goneWord = (l: { deleted: boolean }) => (l.deleted ? "deleted" : "cancelled");
  for (const s of input.statements) for (const l of s.loads) standing.see(!gone(l), () => ({ id: `${s.id}:${l.loadId}`, label: l.label, detail: `on statement ${s.number}, and ${goneWord(l)}`, href: `/settlements/${s.id}` }));
  for (const i of invoices.filter((x) => x.kind === "invoice" && x.status === "paid")) for (const l of i.loads) standing.see(!gone(l), () => ({ id: `${i.id}:${l.loadId}`, label: l.label, detail: `on paid invoice ${i.number}, and ${goneWord(l)}`, href: invHref(i) }));

  const fuel = new Tally();
  const byFuel = new Map<string, MoneyFuelLine[]>();
  for (const f of input.fuelLines) byFuel.set(f.fuelId, [...(byFuel.get(f.fuelId) ?? []), f]);
  for (const [id, rows] of byFuel) {
    const on = [...new Map(rows.map((r) => [r.settlementId, r.settlementNumber])).entries()];
    const twice = on.length > 1;
    const points = rows[0]!.purchaseSettlementId;
    const stray = !twice && points !== on[0]![0];
    fuel.see(!twice && !stray, () => ({ id, label: rows[0]!.label, detail: twice ? `taken off ${on.map(([, n]) => n).join(" and ")}` : `taken off ${on[0]![1]}, but the purchase ${points ? "points to another statement" : "is on no statement"}`, href: `/settlements/${on[0]![0]}` }));
  }

  let qbo: MoneyCheck;
  if (!input.qbo.connected) qbo = notChecked("qbo_mismatch", "QuickBooks is not connected.");
  else if (input.qbo.lastSyncAt == null) qbo = notChecked("qbo_mismatch", "No QuickBooks sync has finished yet.");
  else {
    const t = new Tally();
    const at = input.qbo.lastSyncAt;
    for (const i of invoices) {
      if (i.createdAt > at) continue;
      if (live(i)) t.see(i.inQbo, () => ({ id: i.id, label: i.number, detail: "not in QuickBooks, though a sync has run since it was made", href: invHref(i) }));
      else if (i.voidedAt != null && i.voidedAt <= at) t.see(!i.inQbo, () => ({ id: i.id, label: i.number, detail: "void on the desk, still in QuickBooks", href: invHref(i) }));
    }
    qbo = t.out("qbo_mismatch");
  }

  const factor = new Tally();
  for (const i of invoices.filter((x) => live(x) && x.kind === "invoice" && (x.factoring.status !== "none" || x.factoring.chargebackCents != null))) {
    const why = factorProblem(i);
    factor.see(why == null, () => ({ id: i.id, label: i.number, detail: why!, href: invHref(i) }));
  }

  const checks = [lines.out("invoice_lines_total"), payments.out("payments_over_total"), projection.out("load_projection"), standing.out("settled_load_voided"), fuel.out("fuel_deducted_twice"), qbo, factor.out("factor_mismatch")];
  return { checks, failed: checks.reduce((s, c) => s + c.failed, 0), notChecked: checks.filter((c) => c.state === "not_checked").length, truncated: input.truncated };
}
