import { parseCsv } from "./import-csv";

/**
 * A factor's status file, read (docs/MONEY_PLAN.md, Wave 2): what most factors send back instead of a webhook, a CSV with a line per invoice that says where it stands with them. Factors
 * name their columns differently, so a column is found by any of the names below, and the words a factor uses for a state are read as the desk's own. Pure: text in, rows out, each row
 * with what is wrong with it in words. What a row then does to an invoice is server/partners/factor-status-import.ts.
 */
export const FACTOR_STATUSES = ["submitted", "funded", "rejected", "paid", "chargeback"] as const;
export type FactorStatus = (typeof FACTOR_STATUSES)[number];
export const FACTOR_STATUS_LABEL: Record<FactorStatus, string> = { submitted: "With the factor", funded: "Funded", rejected: "Rejected", paid: "Paid by the customer", chargeback: "Charged back" };

export const STATUS_FILE_MAX_ROWS = 5_000;

const COLUMN: Record<"invoice" | "reference" | "status" | "amount" | "reason" | "date", string[]> = {
  invoice: ["invoice", "invoicenumber", "invoiceno", "invoicenum", "inv", "invno", "invoiceid"],
  reference: ["reference", "ref", "referenceid", "factorreference", "schedule", "schedulenumber", "scheduleno", "batch", "batchnumber", "verification"],
  status: ["status", "state", "event", "invoicestatus"],
  amount: ["amount", "advance", "advanceamount", "fundedamount", "paidamount", "chargebackamount", "amt"],
  reason: ["reason", "note", "notes", "comment", "comments", "memo"],
  date: ["date", "asof", "statusdate", "fundeddate", "paiddate", "eventdate"]
};

const WORDS: Array<[FactorStatus, string[]]> = [
  ["chargeback", ["chargeback", "chargedback", "chargeback", "recourse", "repurchase", "repurchased", "charge back"]],
  ["funded", ["funded", "advanced", "purchased", "purchase", "approved and funded"]],
  ["rejected", ["rejected", "declined", "nonfactorable", "not purchased", "notpurchased", "refused"]],
  ["paid", ["paid", "collected", "closed", "paidbydebtor", "debtorpaid", "paymentreceived", "customerpaid", "paid in full", "paidinfull"]],
  ["submitted", ["submitted", "received", "underreview", "pending", "inreview", "verifying"]]
];

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The factor's word for a state, as the desk's own, or null when it is not one the desk knows. */
export function statusOf(text: string): FactorStatus | null {
  const k = key(text);
  if (k === "") return null;
  for (const [status, words] of WORDS) if (words.some((w) => key(w) === k)) return status;
  return null;
}

/** Dollars as written in a factor's file: "$1,250.00", "1250", "(300.00)". Null when blank; "bad" when it is not an amount. Read as text, so a figure never passes through floating point twice. */
export function amountOf(text: string): number | null | "bad" {
  const t = text.trim().replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "$1").replace(/^-/, "");
  if (t === "") return null;
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return "bad";
  const [whole, cents = ""] = t.split(".");
  return Number.parseInt(whole!, 10) + Number.parseInt(cents.padEnd(2, "0"), 10) / 100;
}

export type StatusRow = {
  /** The line in the file (the header is line 1). */
  line: number;
  invoice: string | null;
  reference: string | null;
  status: FactorStatus | null;
  /** The factor's own word, as written. */
  statusText: string;
  amount: number | null;
  reason: string | null;
  date: string | null;
  errors: string[];
};

export type StatusFile = { ok: true; rows: StatusRow[]; columns: string[] } | { ok: false; error: string };

export function readFactorStatus(text: string): StatusFile {
  const table = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (table.length < 2) return { ok: false, error: "The file has no lines under its header." };
  if (table.length - 1 > STATUS_FILE_MAX_ROWS) return { ok: false, error: `A status file can have up to ${STATUS_FILE_MAX_ROWS.toLocaleString("en-US")} lines; this one has ${(table.length - 1).toLocaleString("en-US")}. Split it.` };
  const header = table[0]!.map(key);
  const at = (name: keyof typeof COLUMN) => header.findIndex((h) => COLUMN[name].includes(h));
  const col = { invoice: at("invoice"), reference: at("reference"), status: at("status"), amount: at("amount"), reason: at("reason"), date: at("date") };
  if (col.status < 0) return { ok: false, error: "The file needs a Status column (funded, rejected, paid or chargeback)." };
  if (col.invoice < 0 && col.reference < 0) return { ok: false, error: "The file needs an Invoice column (the invoice number), or a Reference column." };
  const cell = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const rows = table.slice(1).map((r, n): StatusRow => {
    const errors: string[] = [];
    const invoice = cell(r, col.invoice).slice(0, 60) || null;
    const reference = cell(r, col.reference).slice(0, 80) || null;
    const statusText = cell(r, col.status).slice(0, 40);
    const status = statusOf(statusText);
    const amount = amountOf(cell(r, col.amount));
    if (!invoice && !reference) errors.push("No invoice number or reference.");
    if (!status) errors.push(statusText ? `"${statusText}" is not a status the desk knows (funded, rejected, paid, chargeback).` : "No status.");
    if (amount === "bad") errors.push(`"${cell(r, col.amount)}" is not an amount.`);
    return { line: n + 2, invoice, reference, status, statusText, amount: amount === "bad" ? null : amount, reason: cell(r, col.reason).slice(0, 200) || null, date: cell(r, col.date).slice(0, 20) || null, errors };
  });
  const found = (Object.keys(col) as Array<keyof typeof col>).filter((k) => col[k] >= 0);
  return { ok: true, rows, columns: found };
}
