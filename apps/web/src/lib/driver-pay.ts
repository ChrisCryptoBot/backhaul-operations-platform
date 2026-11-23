import { DEDUCTION_ROW_LABEL, type DeductionOption, type DeductionRowKind } from "./deductions";
import { paidMethodLabel } from "./pay-method";
import { statementRows, type Statement, type StatementLine } from "./settlement";
import type { StatementYtd } from "./statement-pdf";

/**
 * A driver's pay as their own phone is told it (sync plan Step 5a), pure: statements and balances, in whole cents, with exactly the keys the phone project's tables hold
 * (supabase/migrations/20261122000500_bridge_driver_pay.sql). What a load pays the company never goes: a percent-paid line carries its amount only, because the percent and the amount
 * together give the rate away.
 */
export type PayLine = { kind: string; label: string; detail: string | null; amount_cents: number; load_number: string | null };
export type PayState = "finalized" | "sent" | "paid" | "void";
export type DriverStatementRow = {
  org_id: string;
  driver_sub: string;
  desk_statement_id: string;
  number: string;
  state: PayState;
  period_start: string;
  period_end: string;
  total_cents: number;
  lines: PayLine[];
  finalized_at: string | null;
  paid_on: string | null;
  paid_method: string | null;
  pdf_path: string | null;
  desk_rev: string;
};
export type DriverBalanceRow = {
  org_id: string;
  driver_sub: string;
  desk_driver_id: string;
  escrow_cents: number;
  advances: { label: string; owed_cents: number }[];
  next_off: { label: string; amount_cents: number }[];
  unsettled_cents: number;
  unsettled_loads: number;
  unsettled_unpriced: number;
  ytd: { year: number; statements: number; pay_cents: number; net_cents: number } | null;
};

const cents = (n: number): number => Math.round((n + Number.EPSILON * Math.sign(n)) * 100);
const cut = (s: string, n = 160): string => s.slice(0, n);

/** How a load's pay was worked out, in words a driver may see. */
export const SHARE_OF_LOAD = "Your share of the load";
export const driverBasis = (l: Pick<StatementLine, "payKind" | "basis">): string => (l.payKind === "percent" ? SHARE_OF_LOAD : l.basis);

/** The statement with every percent-paid line's sum taken out: what the phone's PDF is drawn from. */
export function driverSafeStatement<T extends Pick<Statement, "lines">>(st: T): T {
  return { ...st, lines: st.lines.map((l) => ({ ...l, basis: driverBasis(l) })) };
}

export function payState(s: { status: string; paidAt: string | null; payrollSentAt: string | null }): PayState {
  if (s.status === "void") return "void";
  if (s.paidAt) return "paid";
  return s.payrollSentAt ? "sent" : "finalized";
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A statement's lines in its own order. They add up to its total to the cent, or the statement is not sent. */
export function payLines(st: Pick<Statement, "lines" | "fuel" | "adjustments" | "deductions">): PayLine[] {
  const safe = driverSafeStatement(st);
  return statementRows(safe).map((r): PayLine => {
    const detail =
      r.kind === "load"
        ? [r.deliveredAt ? `Delivered ${day(r.deliveredAt)}` : null, r.basis].filter(Boolean).join(" · ")
        : r.kind === "fuel"
          ? [r.basis ? day(`${r.basis}T00:00:00Z`) : null, r.gallons != null ? `${r.gallons} gal` : null].filter(Boolean).join(" · ")
          : r.kind in DEDUCTION_ROW_LABEL
            ? DEDUCTION_ROW_LABEL[r.kind as DeductionRowKind]
            : null;
    return { kind: r.kind, label: cut(r.label), detail: detail ? cut(detail) : null, amount_cents: cents(r.amount), load_number: r.loadNumber };
  });
}

const LINE_KEYS = "amount_cents,detail,kind,label,load_number";
const STATEMENT_KEYS = "desk_rev,desk_statement_id,driver_sub,finalized_at,lines,number,org_id,paid_method,paid_on,pdf_path,period_end,period_start,state,total_cents";
const keysOf = (o: object) => Object.keys(o).sort().join(",");

/** Refuses a row with any key it should not have, lines that do not come to the total, or a secret of its loads in words a driver would read. Throws; the statement is not sent. */
export function assertStatementSafe(row: DriverStatementRow, secrets: readonly number[] = []): void {
  if (keysOf(row) !== STATEMENT_KEYS) throw new Error("statement has unexpected keys");
  for (const l of row.lines) if (keysOf(l) !== LINE_KEYS) throw new Error("statement line has unexpected keys");
  if (row.lines.reduce((n, l) => n + l.amount_cents, 0) !== row.total_cents) throw new Error("statement lines do not come to its total");
  // A load line is written by the desk, so its words can be held to this; a typed adjustment is the dispatcher's own words on the driver's own statement.
  for (const l of row.lines) {
    if (l.kind !== "load") continue;
    const text = `${l.detail ?? ""}`.replaceAll(",", "");
    for (const n of secrets) if (n > 0 && Math.round(n * 100) !== Math.abs(l.amount_cents) && new RegExp(`(^|[^0-9.])${String(n).replace(".", "\\.")}([^0-9]|$)`).test(text)) throw new Error("statement line carries what the load pays");
  }
}

export function toStatementRow(i: {
  orgId: string;
  driverSub: string;
  s: { id: string; number: string; status: string; start: string; end: string; finalizedAt: string | null; paidAt: string | null; paidMethod: string | null; payrollSentAt: string | null; statement: Pick<Statement, "lines" | "fuel" | "adjustments" | "deductions" | "total"> };
  pdfPath: string | null;
  rev: string;
}): DriverStatementRow {
  const state = payState(i.s);
  return {
    org_id: i.orgId,
    driver_sub: i.driverSub,
    desk_statement_id: i.s.id,
    number: i.s.number,
    state,
    period_start: i.s.start,
    period_end: i.s.end,
    total_cents: cents(i.s.statement.total),
    lines: payLines(i.s.statement),
    finalized_at: i.s.finalizedAt,
    paid_on: state === "paid" && i.s.paidAt ? i.s.paidAt.slice(0, 10) : null,
    paid_method: state === "paid" && i.s.paidMethod ? cut(paidMethodLabel(i.s.paidMethod), 40) : null,
    pdf_path: i.pdfPath,
    desk_rev: i.rev
  };
}

export function toBalanceRow(i: {
  orgId: string;
  driverSub: string;
  deskDriverId: string;
  escrowHeldCents: number;
  advances: readonly { label: string; owedCents: number }[];
  options: readonly DeductionOption[];
  unsettled: { cents: number; loads: number; unpriced: number };
  ytd: StatementYtd | null;
}): DriverBalanceRow {
  return {
    org_id: i.orgId,
    driver_sub: i.driverSub,
    desk_driver_id: i.deskDriverId,
    escrow_cents: i.escrowHeldCents,
    advances: i.advances.filter((a) => a.owedCents > 0).slice(0, 50).map((a) => ({ label: cut(a.label), owed_cents: a.owedCents })),
    next_off: i.options.filter((o) => o.proposedCents > 0).slice(0, 50).map((o) => ({ label: cut(o.label), amount_cents: o.proposedCents })),
    unsettled_cents: i.unsettled.cents,
    unsettled_loads: i.unsettled.loads,
    unsettled_unpriced: i.unsettled.unpriced,
    ytd: i.ytd ? { year: i.ytd.year, statements: i.ytd.statements, pay_cents: i.ytd.grossCents, net_cents: i.ytd.netCents } : null
  };
}

/** What to write and remove, given what the bridge has: a statement only when the desk's copy moved on; balances only when a figure changed. */
export function payPlan(i: {
  statements: readonly { driverSub: string; id: string; rev: string }[];
  thereStatements: readonly { id: string; driver_sub: string; desk_statement_id: string; desk_rev: string; pdf_path: string | null }[];
  balances: readonly DriverBalanceRow[];
  thereBalances: readonly DriverBalanceRow[];
}) {
  const key = (sub: string, id: string) => `${sub}|${id}`;
  const have = new Map(i.thereStatements.map((r) => [key(r.driver_sub, r.desk_statement_id), r]));
  const want = new Set(i.statements.map((s) => key(s.driverSub, s.id)));
  const bHave = new Map(i.thereBalances.map((b) => [b.driver_sub, b]));
  const bWant = new Set(i.balances.map((b) => b.driver_sub));
  const same = (a: DriverBalanceRow, b: DriverBalanceRow) => FIELDS.every((f) => stable(a[f]) === stable(b[f]));
  return {
    write: i.statements.filter((s) => have.get(key(s.driverSub, s.id))?.desk_rev !== s.rev),
    remove: i.thereStatements.filter((r) => !want.has(key(r.driver_sub, r.desk_statement_id))),
    balances: i.balances.filter((b) => {
      const h = bHave.get(b.driver_sub);
      return !h || !same(b, h);
    }),
    removeBalances: i.thereBalances.map((b) => b.driver_sub).filter((s) => !bWant.has(s))
  };
}
const FIELDS = ["desk_driver_id", "escrow_cents", "advances", "next_off", "unsettled_cents", "unsettled_loads", "unsettled_unpriced", "ytd"] as const;
/** Same value, whatever order the database hands an object's keys back in. */
const stable = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${k}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null);
