import { toCsv } from "./csv";
import type { AccountMap } from "./accounting-map";

/**
 * The double-entry journal (docs/MONEY_PLAN.md, Wave 3): the fallback for any accounting system that is not QuickBooks. Pure, in whole cents: the server reads the records, this books them.
 * Every entry balances (debits equal credits), and every amount comes from a record as it stands, so the journal's receivables add up to the invoice records.
 *
 * What is booked, and how:
 *   invoice / credit memo  each line to its kind's income account (a positive line is a credit, a negative one a debit), the total to Accounts Receivable. A memo's total is negative, so it
 *                          takes receivables down. Applying a memo to its invoice is not booked again: the memo already did it (a payment row with source "credit" is skipped).
 *   payment                cash in, receivables down; except while the factor owns the invoice (from the day it funded it, until any chargeback): then the customer pays the factor.
 *   short pay written off  the write-off to its expense, receivables down; not while the factor owns the invoice.
 *   factored (funded)      the advance in cash and the reserve held by the factor, receivables down by the whole invoice; the fee out of the reserve to Factoring Fees; when the customer pays,
 *                          the reserve the factor releases comes in as cash. A chargeback undoes the funding: the invoice is the fleet's to collect again and the advance goes back.
 *                          (A chargeback clears the fee and reserve on the record, so a charged-back invoice is booked with no fee: what the record says now.)
 *   1099 statement         rule E, from the statement's frozen rows (SettlementLine), each row to its account by kind (statementPostings below, which the QuickBooks bill uses too): loads and
 *                          adjustments to Driver Pay, the fuel the driver bore back out of Fuel, deductions to Deduction Income, escrow held to Driver Escrow (a liability, never income) and a
 *                          release back out of it, an advance repaid out of Driver Advances (the asset), and the net to Accounts Payable; paid, payables down and cash out. The rows must add up
 *                          to the statement's total or nothing is booked. A W-2 driver's statement is never booked here (payroll books it), and one whose driver is not marked either way is
 *                          left out and said. A voided statement is not booked: the journal is made from the records as they stand, so its entry is gone from the next export.
 *   advance given          an advance recorded outside a statement (cash, check, transfer, fuel card) is the asset going up: Driver Advances against cash, or against the fuel card for one
 *                          given on the card. Its repayments come off later statements (above), so the asset returns to nothing as the advance is cleared.
 *   fuel card purchase     to Fuel, owed to the fuel card.
 */
export type JInvoice = {
  id: string;
  number: string;
  kind: string;
  billTo: string | null;
  issuedAt: Date;
  total: number;
  paidAt: Date | null;
  writeOff: number | null;
  lines: Array<{ kind: string; amount: number }>;
  payments: Array<{ id: string; amount: number; paidAt: Date; source: string }>;
  factoring: { fundedAt: Date | null; advance: number | null; fee: number | null; reserveReleased: number | null; chargeback: number | null; updatedAt: Date | null };
};
/** A statement with its frozen rows (cents, signed as on the statement). */
export type JSettlement = { id: string; number: string; driver: string; workerType: string | null; finalizedAt: Date; total: number; rows: Array<{ kind: string; amount: number }>; paidAt: Date | null };
/** An advance given outside a statement. `method` decides what paid it out: the fuel card, or cash for every other way. */
export type JAdvance = { id: string; driver: string; workerType: string | null; givenOn: string; method: string; amount: number; label: string };

/**
 * Which account each kind of statement row is booked to. Every row is booked at its own signed amount (pay positive is a debit, money off negative is a credit), so a statement's postings
 * plus Accounts Payable for the net always balance. A kind not here stops the booking rather than guessing.
 */
export const ROW_ACCOUNT: Record<string, string> = {
  load: "driver_pay_1099",
  // Typed by hand and signed: a bonus adds to driver pay, a negative one takes it down (what it was is the fleet's to say; it has no account of its own).
  adjustment: "driver_pay_1099",
  fuel: "fuel",
  deduction: "deduction_income",
  escrow: "escrow_liability",
  escrow_release: "escrow_liability",
  advance_repaid: "driver_advances"
};
export const ROW_ACCOUNT_DESCRIPTION: Record<string, string> = {
  driver_pay_1099: "Driver pay (loads and adjustments)",
  fuel: "Fuel card, taken off the statement",
  deduction_income: "Deductions charged back (lease, insurance, ELD)",
  escrow_liability: "Escrow held for the driver, less any released",
  driver_advances: "Advance repaid"
};

/**
 * A statement's postings by account, netted per account (cents, positive = debit), with Accounts Payable for the net. The journal and the QuickBooks bill both come from this, so they agree to
 * the cent. Refused (problem) when a row's kind has no account or the rows do not add up to the total.
 */
export function statementPostings(s: Pick<JSettlement, "number" | "total" | "rows">): { postings: Array<[string, number]>; net: number } | { problem: string } {
  const unknown = [...new Set(s.rows.map((r) => r.kind).filter((k) => !ROW_ACCOUNT[k]))];
  if (unknown.length > 0) return { problem: `${s.number}: a line of a kind the books do not know (${unknown.join(", ")}).` };
  const net = s.rows.reduce((sum, r) => sum + r.amount, 0);
  if (net !== s.total) return { problem: `${s.number}: its lines come to ${(net / 100).toFixed(2)}, not the ${(s.total / 100).toFixed(2)} on the statement.` };
  const by = new Map<string, number>();
  for (const r of s.rows) by.set(ROW_ACCOUNT[r.kind]!, (by.get(ROW_ACCOUNT[r.kind]!) ?? 0) + r.amount);
  return { postings: [...[...by.entries()].filter(([, v]) => v !== 0), ["accounts_payable", -net]], net };
}

/** What paid an advance out: the fuel card owes for one given on the card; every other way is cash. */
export const advanceCreditKey = (method: string) => (method === "fuel_card" ? "fuel_card_payable" : "cash");
export type JFuel = { id: string; postedAt: Date; amount: number; location: string | null };

export type JSource = "invoice" | "credit_memo" | "payment" | "write_off" | "factoring_funded" | "factoring_fee" | "factoring_release" | "factoring_chargeback" | "settlement" | "settlement_paid" | "advance" | "fuel";
export type JLine = { key: string; debit: number; credit: number };
export type JEntry = { id: string; day: string; source: JSource; ref: string; memo: string; lines: JLine[] };

export type JournalOut = {
  entries: JEntry[];
  /** Records that cannot be booked as they stand: the journal is not given out until they are put right. */
  problems: string[];
  /** What was left out on purpose, said. */
  notes: string[];
  /** Every account key the entries use. */
  keys: string[];
  /** Cross-checks, in cents: what the records say, to compare with the journal's own sums. */
  check: { invoiced: number; credited: number; arFromInvoices: number; received: number; cashFromPayments: number };
};

/** The day a moment falls on in the fleet's own zone, as YYYY-MM-DD. */
export const dayIn = (zone: string) => {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
  return (d: Date) => f.format(d);
};

/**
 * While the factor owns an invoice: from the day it funded it until a chargeback (if any) gives it back. A payment or a write-off inside that window is the factor's, not the fleet's.
 * The journal and the QuickBooks sync both ask this, so they never disagree on whose a payment was.
 */
export function factoringWindow(f: JInvoice["factoring"]): { chargedAt: Date | null; owns: (at: Date) => boolean } {
  const chargedAt = f.chargeback != null ? f.updatedAt : null;
  return { chargedAt, owns: (at: Date) => f.fundedAt != null && at.getTime() >= f.fundedAt.getTime() && !(chargedAt && at.getTime() >= chargedAt.getTime()) };
}

/** One entry from signed amounts by key (positive = debit), netted per key; empty keys dropped. Null when it does not balance. */
function entry(id: string, day: string, source: JSource, ref: string, memo: string, signed: Array<[string, number]>): JEntry | null {
  const net = new Map<string, number>();
  for (const [k, v] of signed) net.set(k, (net.get(k) ?? 0) + v);
  const lines: JLine[] = [];
  for (const [key, v] of net) if (v !== 0) lines.push({ key, debit: v > 0 ? v : 0, credit: v < 0 ? -v : 0 });
  const dr = lines.reduce((s, l) => s + l.debit, 0);
  const cr = lines.reduce((s, l) => s + l.credit, 0);
  if (dr !== cr) return null;
  return lines.length === 0 ? null : { id, day, source, ref, memo, lines };
}

export function buildJournal(input: { invoices: JInvoice[]; settlements: JSettlement[]; fuel: JFuel[]; advances?: JAdvance[] }, opts: { zone: string; from?: string | null; to?: string | null }): JournalOut {
  const day = dayIn(opts.zone);
  const inRange = (d: string) => (!opts.from || d >= opts.from) && (!opts.to || d <= opts.to);
  const all: JEntry[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const check = { invoiced: 0, credited: 0, arFromInvoices: 0, received: 0, cashFromPayments: 0 };
  const push = (e: JEntry | null, why?: string) => {
    if (e) all.push(e);
    else if (why) problems.push(why);
  };

  for (const inv of input.invoices) {
    const memo = inv.kind === "credit_memo" ? "credit_memo" : "invoice";
    const d0 = day(inv.issuedAt);
    const sum = inv.lines.reduce((s, l) => s + l.amount, 0);
    if (sum !== inv.total) {
      problems.push(`${inv.number}: its lines come to ${(sum / 100).toFixed(2)}, not the ${(inv.total / 100).toFixed(2)} on the invoice.`);
      continue;
    }
    const issued = entry(`${memo}:${inv.id}`, d0, memo, inv.number, `${memo === "credit_memo" ? "Credit memo" : "Invoice"} ${inv.number}${inv.billTo ? `, ${inv.billTo}` : ""}`, [["accounts_receivable", inv.total], ...inv.lines.map((l): [string, number] => [l.kind, -l.amount])]);
    if (issued && inRange(d0)) {
      if (inv.kind === "credit_memo") check.credited += inv.total;
      else check.invoiced += inv.total;
      check.arFromInvoices += inv.total;
    }
    push(issued);
    if (inv.kind === "credit_memo") continue;

    const f = inv.factoring;
    const { chargedAt, owns: factorOwns } = factoringWindow(f);
    let factoringOk = true;

    if (f.fundedAt) {
      const advance = f.chargeback ?? f.advance;
      if (advance == null) {
        problems.push(`${inv.number}: the factor funded it but no advance is recorded. Record what the factor advanced, or take the funding back, then export again.`);
        factoringOk = false;
      } else {
        const reserve = inv.total - advance;
        const fd = day(f.fundedAt);
        push(entry(`factoring_funded:${inv.id}`, fd, "factoring_funded", inv.number, `Factored ${inv.number}: advance and reserve`, [["cash", advance], ["factor_reserve", reserve], ["accounts_receivable", -inv.total]]));
        const fee = f.chargeback != null ? 0 : (f.fee ?? 0);
        if (fee > 0) push(entry(`factoring_fee:${inv.id}`, fd, "factoring_fee", inv.number, `Factoring fee on ${inv.number}`, [["factoring_fee", fee], ["factor_reserve", -fee]]));
        if (f.chargeback == null && f.reserveReleased != null && f.reserveReleased > 0) {
          const at = inv.paidAt ?? f.updatedAt ?? f.fundedAt;
          push(entry(`factoring_release:${inv.id}`, day(at), "factoring_release", inv.number, `Reserve released on ${inv.number}`, [["cash", f.reserveReleased], ["factor_reserve", -f.reserveReleased]]));
        }
        if (chargedAt) push(entry(`factoring_chargeback:${inv.id}`, day(chargedAt), "factoring_chargeback", inv.number, `Charged back on ${inv.number}`, [["accounts_receivable", inv.total], ["cash", -advance], ["factor_reserve", -reserve]]));
      }
    }

    for (const p of inv.payments) {
      if (p.source === "credit") continue;
      const pd = day(p.paidAt);
      if (inRange(pd)) check.received += p.amount;
      if (factoringOk && factorOwns(p.paidAt)) continue;
      const e = entry(`payment:${p.id}`, pd, "payment", inv.number, `Payment on ${inv.number}`, [["cash", p.amount], ["accounts_receivable", -p.amount]]);
      if (e && inRange(pd)) check.cashFromPayments += p.amount;
      push(e);
    }
    if (inv.writeOff != null && inv.writeOff > 0) {
      const at = inv.paidAt ?? inv.issuedAt;
      if (!(factoringOk && factorOwns(at))) push(entry(`write_off:${inv.id}`, day(at), "write_off", inv.number, `Short pay written off on ${inv.number}`, [["write_off", inv.writeOff], ["accounts_receivable", -inv.writeOff]]));
    }
  }

  const w2: string[] = [];
  const unset: string[] = [];
  for (const s of input.settlements) {
    if (s.workerType === "employee") {
      w2.push(s.number);
      continue;
    }
    if (s.workerType !== "contractor") {
      unset.push(s.number);
      continue;
    }
    const p = statementPostings(s);
    if ("problem" in p) {
      problems.push(p.problem);
      continue;
    }
    push(entry(`settlement:${s.id}`, day(s.finalizedAt), "settlement", s.number, `Statement ${s.number}, ${s.driver}`, p.postings), `${s.number}: its entry does not balance.`);
    if (s.paidAt) push(entry(`settlement_paid:${s.id}`, day(s.paidAt), "settlement_paid", s.number, `Paid statement ${s.number}, ${s.driver}`, [["accounts_payable", p.net], ["cash", -p.net]]));
  }
  for (const a of input.advances ?? []) {
    // Rule E again: a W-2 driver's advance is payroll's (the desk refuses one anyway).
    if (a.workerType !== "contractor") continue;
    push(entry(`advance:${a.id}`, a.givenOn, "advance", a.label, `${a.label}, ${a.driver}`, [["driver_advances", a.amount], [advanceCreditKey(a.method), -a.amount]]), `${a.label}: its entry does not balance.`);
  }
  if (w2.length > 0) notes.push(`${w2.length} ${w2.length === 1 ? "statement is" : "statements are"} for company drivers (W-2): their pay is booked by payroll, not here.`);
  if (unset.length > 0) notes.push(`${unset.length} ${unset.length === 1 ? "statement was" : "statements were"} left out because the driver is not marked as a contractor or an employee (${unset.slice(0, 5).join(", ")}${unset.length > 5 ? ", ..." : ""}). Mark the driver on their page.`);

  for (const t of input.fuel) push(entry(`fuel:${t.id}`, day(t.postedAt), "fuel", t.location ?? "Fuel card", `Fuel card${t.location ? `, ${t.location}` : ""}`, [["fuel", t.amount], ["fuel_card_payable", -t.amount]]));

  const entries = all.filter((e) => inRange(e.day)).sort((a, b) => (a.day === b.day ? a.id.localeCompare(b.id) : a.day < b.day ? -1 : 1));
  const keys = [...new Set(entries.flatMap((e) => e.lines.map((l) => l.key)))];
  return { entries, problems, notes, keys, check };
}

/** The journal as a CSV: one row per line, the entry's id on every row so a system that imports it groups them. */
export function journalCsv(entries: JEntry[], map: AccountMap): string {
  const money = (c: number) => (c === 0 ? "" : (c / 100).toFixed(2));
  const rows = entries.flatMap((e) => e.lines.map((l) => [e.day, e.id, map[l.key]?.account ?? "", map[l.key]?.number ?? "", money(l.debit), money(l.credit), e.memo, e.source, e.ref]));
  return toCsv(["Date", "Journal entry", "Account", "Account number", "Debit", "Credit", "Memo", "Source", "Reference"], rows);
}
