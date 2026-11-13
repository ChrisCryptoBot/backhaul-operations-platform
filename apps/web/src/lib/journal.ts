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
 *   1099 statement         rule E: driver pay (what the loads paid, before the fuel card came off) to Driver Pay, the fuel the driver bore back out of Fuel, and the net to Accounts Payable;
 *                          paid, payables down and cash out. A W-2 driver's statement is never booked here (payroll books it), and one whose driver is not marked either way is left out and said.
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
export type JSettlement = { id: string; number: string; driver: string; workerType: string | null; finalizedAt: Date; total: number; fuel: number; paidAt: Date | null };
export type JFuel = { id: string; postedAt: Date; amount: number; location: string | null };

export type JSource = "invoice" | "credit_memo" | "payment" | "write_off" | "factoring_funded" | "factoring_fee" | "factoring_release" | "factoring_chargeback" | "settlement" | "settlement_paid" | "fuel";
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

export function buildJournal(input: { invoices: JInvoice[]; settlements: JSettlement[]; fuel: JFuel[] }, opts: { zone: string; from?: string | null; to?: string | null }): JournalOut {
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
    const chargedAt = f.chargeback != null ? f.updatedAt : null;
    const factorOwns = (at: Date) => f.fundedAt != null && at.getTime() >= f.fundedAt.getTime() && !(chargedAt && at.getTime() >= chargedAt.getTime());
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
    push(entry(`settlement:${s.id}`, day(s.finalizedAt), "settlement", s.number, `Statement ${s.number}, ${s.driver}`, [["driver_pay_1099", s.total + s.fuel], ["fuel", -s.fuel], ["accounts_payable", -s.total]]));
    if (s.paidAt) push(entry(`settlement_paid:${s.id}`, day(s.paidAt), "settlement_paid", s.number, `Paid statement ${s.number}, ${s.driver}`, [["accounts_payable", s.total], ["cash", -s.total]]));
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
