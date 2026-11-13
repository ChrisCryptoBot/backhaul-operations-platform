import { usd } from "./desk-format";
import { percentOf, percentText, type PayKind } from "./pay";
import { parseCentralLocal, toCentralLocal } from "./zoned";
import { DEDUCTION_ROW_LABEL, needsNegativeConfirm, type DeductionLine } from "./deductions";

/**
 * A driver's pay statement: the loads they delivered in a period, what each pays them under the pay it was assigned with, the typed hours for
 * hourly loads, and typed adjustments (an advance, a fuel card charge, a reimbursement, a bonus). The load lines follow the same rules as the
 * estimate on an assignment: per loaded mile times the loaded miles, a set amount, hourly times hours, or a percent of what the rate
 * confirmation pays. This is gross pay for the driver. Taxes and payroll deductions are not worked out here. Pure, so the editor shows the same
 * total the server will freeze.
 */
export type SettlementLoad = {
  loadId: string;
  loadNumber: string | null;
  origin: string | null;
  destination: string | null;
  /** When it was delivered, as an ISO time. */
  deliveredAt: string | null;
  loadedMiles: number;
  payKind: PayKind;
  payRate: number;
  /** What the rate confirmation pays: the agreed rate plus its fuel surcharge. A percent pay is taken of it. */
  rateConTotal: number;
  /** For hourly pay: the hours the assignment was sent with, when it had an estimate. */
  assignedHours: number | null;
  /** Where the broker's payment to the desk stands, so the dispatcher can see it. It does not hold the statement. */
  /** Where the customer's payment stands. "paid_short" is paid and closed for less than the invoice (a short pay or a write-off). */
  brokerStatus: "paid" | "paid_short" | "invoiced" | "not_invoiced";
};

export type StatementLine = {
  loadId: string;
  loadNumber: string | null;
  lane: string;
  deliveredAt: string | null;
  basis: string;
  payKind: PayKind;
  payRate: number;
  hours: number | null;
  /** Null while an hourly load has no hours. */
  amount: number | null;
  brokerStatus: SettlementLoad["brokerStatus"];
};

/**
 * A fuel card purchase deducted from a driver's pay: what the card was charged (after its discount), with the date, the place and the gallons, so the statement can list it. A deduction is a
 * positive amount here and comes off the total; it is a record the dispatcher picked for this statement, never something taken automatically.
 */
export type FuelLine = { id: string; on: string; location: string | null; gallons: number | null; pricePerGallon: number | null; discount: number | null; amount: number; loadNumber: string | null };

export type AdjustmentInput = { label: string; amount: string };
export type Adjustment = { label: string; amount: number };

const cents = (n: number) => Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7));
const dollars = (c: number) => c / 100;
/** A dollar amount to the cent, half a cent rounding up as the database does. */
const round2 = (n: number) => dollars(cents(n));

/** What one load pays the driver; null when the pay is hourly and there are no hours yet. */
export function linePay(kind: PayKind, rate: number, loadedMiles: number, hours: number | null, rateConTotal: number): number | null {
  if (kind === "flat") return round2(rate);
  if (kind === "cpm") return round2(rate * loadedMiles);
  if (kind === "percent") return percentOf(rate, rateConTotal);
  return hours == null ? null : round2(rate * hours);
}

const milesText = (n: number) => `${Number(n.toFixed(1)).toLocaleString("en-US")} mi`;

/** The sum behind a load's amount, in words: "$0.50 a mile × 245 mi", "25% of $1,150.00", "Set amount". */
export function basisText(kind: PayKind, rate: number, loadedMiles: number, hours: number | null, rateConTotal: number): string {
  if (kind === "cpm") return `$${rate.toFixed(2)} a mile × ${milesText(loadedMiles)}`;
  if (kind === "flat") return "Set amount for the load";
  if (kind === "percent") return `${percentText(rate).replace(" of the rate", "")} of ${usd(rateConTotal, 2)}`;
  return hours == null ? `$${rate.toFixed(2)} an hour: enter the hours` : `$${rate.toFixed(2)} an hour × ${Number(hours.toFixed(2))} hr`;
}

/** Hours typed for an hourly load: blank falls back to the assignment's, otherwise a positive number to two places. */
export function parseHours(raw: string | undefined): { value: number | null; error?: string } {
  const s = (raw ?? "").trim();
  if (s === "") return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 400 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { value: null, error: "Hours, above 0 and at most 400, to two places." };
  return { value: n };
}

/** A typed amount, signed: "40", "-25.50", "$1,200". Zero is not an adjustment. */
function parseAmount(raw: string): { value: number | null; error?: string } {
  const s = raw.trim().replace(/[$,\s]/g, "");
  if (s === "") return { value: null };
  const n = Number(s);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100000 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) return { value: null, error: "Dollars and cents, up to 100,000. A deduction is negative." };
  return { value: n };
}

export const MAX_ADJUSTMENTS = 20;

export type Statement = {
  lines: StatementLine[];
  adjustments: Adjustment[];
  /** The fuel card purchases deducted, and what they come to (a positive amount that comes off). */
  fuel: FuelLine[];
  fuelTotal: number;
  loadsTotal: number;
  adjustmentsTotal: number;
  /** Recurring deductions, escrow held and escrow released (Wave 4 step 3), signed, and what they come to (signed). */
  deductions: DeductionLine[];
  deductionsTotal: number;
  /** Rule K: deductions or escrow take this statement below zero, so finalizing it needs a person to confirm. */
  needsConfirm: boolean;
  /** Net pay: pay for the loads, less fuel, plus the adjustments (a deduction among them is negative), plus the deduction lines (signed). */
  total: number;
  errors: Record<string, string>;
  blockers: string[];
  cautions: string[];
};

export function computeStatement(input: { loads: SettlementLoad[]; hours: Record<string, string>; adjustments: AdjustmentInput[]; fuel?: FuelLine[]; deductions?: DeductionLine[]; deductionErrors?: Record<string, string> }): Statement {
  const errors: Record<string, string> = { ...(input.deductionErrors ?? {}) };
  const blockers: string[] = [];
  const cautions: string[] = [];

  const lines: StatementLine[] = input.loads.map((l) => {
    let hours: number | null = null;
    if (l.payKind === "hourly") {
      const typed = parseHours(input.hours[l.loadId]);
      if (typed.error) errors[`hours.${l.loadId}`] = typed.error;
      hours = typed.value ?? l.assignedHours;
    }
    const amount = linePay(l.payKind, l.payRate, l.loadedMiles, hours, l.rateConTotal);
    return {
      loadId: l.loadId,
      loadNumber: l.loadNumber,
      lane: `${l.origin ?? "?"} → ${l.destination ?? "?"}`,
      deliveredAt: l.deliveredAt,
      basis: basisText(l.payKind, l.payRate, l.loadedMiles, hours, l.rateConTotal),
      payKind: l.payKind,
      payRate: l.payRate,
      hours,
      amount,
      brokerStatus: l.brokerStatus
    };
  });

  const adjustments: Adjustment[] = [];
  const rows = input.adjustments.slice(0, MAX_ADJUSTMENTS + 1);
  if (input.adjustments.length > MAX_ADJUSTMENTS) errors.adjustments = `${MAX_ADJUSTMENTS} adjustment lines at most.`;
  rows.slice(0, MAX_ADJUSTMENTS).forEach((r, i) => {
    const label = r.label.trim();
    if (label === "" && r.amount.trim() === "") return;
    const amount = parseAmount(r.amount);
    if (label === "") errors[`adj${i}.label`] = "Say what it is for.";
    else if (label.length > 40) errors[`adj${i}.label`] = "40 characters at most.";
    if (amount.error) errors[`adj${i}.amount`] = amount.error;
    else if (amount.value == null) errors[`adj${i}.amount`] = "Type the amount. A deduction is negative.";
    if (!errors[`adj${i}.label`] && !errors[`adj${i}.amount`] && amount.value != null) adjustments.push({ label, amount: amount.value });
  });

  const loadsCents = lines.reduce((sum, l) => sum + (l.amount == null ? 0 : cents(l.amount)), 0);
  const adjustmentCents = adjustments.reduce((sum, a) => sum + cents(a.amount), 0);
  const fuel = input.fuel ?? [];
  const fuelCents = fuel.reduce((sum, f) => sum + cents(f.amount), 0);
  const deductions = input.deductions ?? [];
  const deductionCents = deductions.reduce((sum, d) => sum + cents(d.amount), 0);
  const totalCents = loadsCents - fuelCents + adjustmentCents + deductionCents;
  const needsConfirm = needsNegativeConfirm(totalCents, deductions);

  for (const l of lines) if (l.amount == null && !errors[`hours.${l.loadId}`]) blockers.push(`Enter the hours for ${l.loadNumber ?? "an hourly load"}.`);
  if (Object.keys(errors).length > 0) blockers.unshift("Fix what is marked.");
  if (lines.length === 0 && adjustments.length === 0 && !deductions.some((d) => d.kind === "escrow_release")) blockers.push("There is nothing to pay on this statement.");

  if (needsConfirm) cautions.push("The deductions and escrow take this statement below zero. Finalizing it needs you to confirm that the driver ends up owing; or skip a deduction this time.");
  else if (totalCents < 0) cautions.push("The deductions come to more than the pay, so this statement is a negative amount: money the driver owes.");
  const short = lines.filter((l) => l.brokerStatus === "paid_short").length;
  if (short > 0) cautions.push(`${short} of these ${short === 1 ? "loads was" : "loads were"} paid short by the customer. A percent is worked on the agreed rate, so the driver is paid on the full rate; adjust it below if you share the loss.`);
  const unpaid = lines.filter((l) => l.brokerStatus !== "paid" && l.brokerStatus !== "paid_short").length;
  if (unpaid > 0) cautions.push(`${unpaid} of these ${unpaid === 1 ? "loads is" : "loads are"} not paid by the customer yet. Pay the driver on your own terms; the statement does not wait for it.`);

  return { lines, adjustments, fuel, fuelTotal: dollars(fuelCents), loadsTotal: dollars(loadsCents), adjustmentsTotal: dollars(adjustmentCents), deductions, deductionsTotal: dollars(deductionCents), needsConfirm, total: dollars(totalCents), errors, blockers, cautions };
}

// ── The period ─────────────────────────────────────────────────────────────────────────────────

export const MAX_PERIOD_DAYS = 92;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;
const utcDay = (ymd: string): number | null => {
  const m = YMD.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(t);
  return back.getUTCFullYear() === Number(m[1]) && back.getUTCMonth() === Number(m[2]) - 1 && back.getUTCDate() === Number(m[3]) ? t : null;
};
const ymdOfUtc = (t: number) => new Date(t).toISOString().slice(0, 10);
export const addDays = (ymd: string, days: number): string => ymdOfUtc((utcDay(ymd) ?? 0) + days * 86_400_000);

/** The Dallas calendar date an instant falls on. */
export const dallasDay = (ms: number, tz?: string): string => toCentralLocal(ms, tz).slice(0, 10);

export type PeriodCheck = { ok: true; start: string; end: string } | { ok: false; errors: { start?: string; end?: string } };

export function validatePeriod(start: string, end: string): PeriodCheck {
  const errors: { start?: string; end?: string } = {};
  const a = utcDay(start.trim());
  const b = utcDay(end.trim());
  if (a == null) errors.start = "A real date.";
  if (b == null) errors.end = "A real date.";
  if (a != null && b != null) {
    if (b < a) errors.end = "The last day cannot be before the first.";
    else if ((b - a) / 86_400_000 + 1 > MAX_PERIOD_DAYS) errors.end = `A statement covers ${MAX_PERIOD_DAYS} days at most.`;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, start: start.trim(), end: end.trim() };
}

/** From midnight at the start of the first day to midnight at the end of the last, on the Dallas clock. */
/** `tz` is the carrier's own zone: the server passes the workspace's stored zone, because which statement a load lands on is money and must not follow a browser cookie. */
export function periodBounds(start: string, end: string, tz?: string): { from: Date; to: Date } | null {
  const from = parseCentralLocal(`${start}T00:00`, tz);
  const to = parseCentralLocal(`${addDays(end, 1)}T00:00`, tz);
  return from == null || to == null ? null : { from: new Date(from), to: new Date(to) };
}

const monthDay = (ymd: string) => new Date(utcDay(ymd) ?? 0).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** "Oct 12 to Oct 25, 2026". */
export function periodText(start: string, end: string): string {
  return `${monthDay(start)} to ${monthDay(end)}, ${end.slice(0, 4)}`;
}

export type PeriodPreset = { key: string; label: string; start: string; end: string };

/** The periods a dispatcher usually settles: last week, last two weeks, this month so far, last month. Weeks run Monday to Sunday. */
export function periodPresets(now: number, tz?: string): PeriodPreset[] {
  const today = dallasDay(now, tz);
  const dow = new Date(utcDay(today) ?? 0).getUTCDay(); // 0 is Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const lastOfPrevious = addDays(firstOfMonth, -1);
  return [
    { key: "week", label: "Last week", start: addDays(monday, -7), end: addDays(monday, -1) },
    { key: "two-weeks", label: "Last two weeks", start: addDays(monday, -14), end: addDays(monday, -1) },
    { key: "month-so-far", label: "This month so far", start: firstOfMonth, end: today },
    { key: "last-month", label: "Last month", start: `${lastOfPrevious.slice(0, 7)}-01`, end: lastOfPrevious }
  ];
}

/** A period that covers a driver's unsettled deliveries, oldest to newest, trimmed to the longest a statement can be (the newest days win). */
export function periodCovering(deliveredAt: Array<Date | string>, tz?: string): { start: string; end: string } | null {
  if (deliveredAt.length === 0) return null;
  let minMs = Infinity;
  let maxMs = -Infinity;
  for (const d of deliveredAt) {
    const ms = typeof d === "string" ? new Date(d).getTime() : d.getTime();
    if (ms < minMs) minMs = ms;
    if (ms > maxMs) maxMs = ms;
  }
  if (!Number.isFinite(minMs)) return null;
  const oldest = dallasDay(minMs, tz);
  const end = minMs === maxMs ? oldest : dallasDay(maxMs, tz);
  const earliestAllowed = addDays(end, -(MAX_PERIOD_DAYS - 1));
  return { start: oldest < earliestAllowed ? earliestAllowed : oldest, end };
}

// ── Statement rows (docs/MONEY_PLAN.md, Wave 4 step 1, rule J) ──────────────────────────────────

/** Where each kind of line starts in a statement's order, so the rows keep the statement's own order (loads, then fuel, then adjustments) and the backfill numbers them the same way. */
export const ROW_SORT = { load: 0, fuel: 10000, adjustment: 20000, deduction: 30000, escrow: 30000, escrow_release: 30000 } as const;
export type RowKind = keyof typeof ROW_SORT;

/** One frozen row: signed (pay positive, money off negative), in dollars to the cent. */
export type StatementRow = {
  sort: number;
  kind: RowKind;
  label: string;
  basis: string | null;
  amount: number;
  loadId: string | null;
  loadNumber: string | null;
  deliveredAt: string | null;
  payKind: PayKind | null;
  payRate: number | null;
  hours: number | null;
  fuelTransactionId: string | null;
  gallons: number | null;
  deductionId: string | null;
};

const none = { loadId: null, loadNumber: null, deliveredAt: null, payKind: null, payRate: null, hours: null, fuelTransactionId: null, gallons: null, deductionId: null };

/** A statement as the rows it is frozen into. Their amounts add up to `statement.total` to the cent. */
export function statementRows(st: Pick<Statement, "lines" | "fuel" | "adjustments"> & { deductions?: DeductionLine[] }): StatementRow[] {
  return [
    ...st.lines.map((l, i): StatementRow => ({ ...none, sort: ROW_SORT.load + i, kind: "load", label: `${l.loadNumber ?? "Load"}, ${l.lane}`, basis: l.basis, amount: round2(l.amount ?? 0), loadId: l.loadId, loadNumber: l.loadNumber, deliveredAt: l.deliveredAt, payKind: l.payKind, payRate: l.payRate, hours: l.hours })),
    ...st.fuel.map((f, i): StatementRow => ({ ...none, sort: ROW_SORT.fuel + i, kind: "fuel", label: `Fuel card${f.location ? `, ${f.location}` : ""}`, basis: f.on, amount: -round2(f.amount), loadNumber: f.loadNumber, fuelTransactionId: f.id, gallons: f.gallons })),
    ...st.adjustments.map((a, i): StatementRow => ({ ...none, sort: ROW_SORT.adjustment + i, kind: "adjustment", label: a.label, basis: null, amount: round2(a.amount) })),
    // Deductions, escrow held and escrow released share one block, in the statement's order.
    ...(st.deductions ?? []).map((d, i): StatementRow => ({ ...none, sort: ROW_SORT[d.kind] + i, kind: d.kind, label: d.label, basis: d.basis, amount: round2(d.amount), deductionId: d.deductionId }))
  ];
}

/** What the rows come to, in cents: the parity check against the statement's total. */
export const rowsTotalCents = (rows: Array<{ amount: number }>) => rows.reduce((sum, r) => sum + cents(r.amount), 0);

/** A statement as it was frozen: the same totals the editor shows, from the stored lines and adjustments. */
export function statementOf(lines: StatementLine[], adjustments: Adjustment[], fuel: FuelLine[] = [], deductions: DeductionLine[] = []): Statement {
  const loadsCents = lines.reduce((sum, l) => sum + (l.amount == null ? 0 : cents(l.amount)), 0);
  const adjustmentCents = adjustments.reduce((sum, a) => sum + cents(a.amount), 0);
  const fuelCents = fuel.reduce((sum, f) => sum + cents(f.amount), 0);
  const deductionCents = deductions.reduce((sum, d) => sum + cents(d.amount), 0);
  const totalCents = loadsCents - fuelCents + adjustmentCents + deductionCents;
  return { lines, adjustments, fuel, fuelTotal: dollars(fuelCents), loadsTotal: dollars(loadsCents), adjustmentsTotal: dollars(adjustmentCents), deductions, deductionsTotal: dollars(deductionCents), needsConfirm: false, total: dollars(totalCents), errors: {}, blockers: [], cautions: [] };
}

/** What a deduction-step row is called in a file or on a sheet: "Deduction", "Escrow held", "Escrow released". */
export const deductionRowLabel = (kind: DeductionLine["kind"]) => DEDUCTION_ROW_LABEL[kind];
