import { toCsv, type CsvCell } from "./csv";

/**
 * The schedule of accounts a factor takes with a batch of invoices (docs/MONEY_PLAN.md, Wave 2): one row per invoice, what the factor needs to verify and fund it, and whether the
 * documents the packet is made of are on file. Most factors take this as a file and not through an API. Pure: rows in, CSV text out.
 */
export type ScheduleRow = {
  number: string;
  /** Every load number on the invoice, joined. */
  loads: string;
  customer: string | null;
  mc: string | null;
  po: string | null;
  issued: string;
  due: string | null;
  termsDays: number;
  /** Dollars. */
  amount: number;
  balance: number;
  rateCon: boolean;
  pod: boolean;
  /** The reference the factor knows it by, when it has one. */
  reference: string | null;
};

export const SCHEDULE_HEADERS = ["Invoice", "Loads", "Customer", "Customer MC", "PO", "Invoice date", "Due date", "Terms (days)", "Amount", "Balance", "Rate confirmation on file", "Proof of delivery on file", "Factor reference"];

export function scheduleCsv(rows: ScheduleRow[]): string {
  return toCsv(
    SCHEDULE_HEADERS,
    rows.map((r): CsvCell[] => [r.number, r.loads, r.customer, r.mc, r.po, r.issued, r.due, r.termsDays, r.amount, r.balance, r.rateCon ? "yes" : "no", r.pod ? "yes" : "no", r.reference])
  );
}

/** The rows a packet can go out with: the rate confirmation and the proof of delivery are both on file. The rest are listed as held, with what each lacks. */
export function splitReady(rows: ScheduleRow[]): { ready: ScheduleRow[]; held: Array<{ row: ScheduleRow; lacks: string[] }> } {
  const ready: ScheduleRow[] = [];
  const held: Array<{ row: ScheduleRow; lacks: string[] }> = [];
  for (const r of rows) {
    const lacks = [...(r.rateCon ? [] : ["rate confirmation"]), ...(r.pod ? [] : ["proof of delivery"])];
    if (lacks.length === 0) ready.push(r);
    else held.push({ row: r, lacks });
  }
  return { ready, held };
}
