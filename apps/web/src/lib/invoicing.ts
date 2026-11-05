import { invoiceTotalDue } from "@/truelane/lib/invoice";
import { deskDaysBetween } from "./overdue";
import { activeTz } from "./tz";

/**
 * Billing a delivered load: what must be true first, the lines that make the total, and the reminder to send when it is late. Pure, so the
 * dialog totals it as you type with the same TrueLane function the server uses to bill.
 */
export type InvoiceLine = { label: string; amount: number };

/**
 * What a load bills on. A delivered load bills its rate, fuel surcharge and extras; a truck-ordered-not-used (TONU) load bills its fee and nothing else: no line haul, no fuel
 * surcharge, no detention (nothing was hauled). Both can be invoiced; a cancelled load, one still on the road, and a saved quote cannot.
 */
export type BasisLoad = { status: string; quotedRevenue: number; fuelSurcharge: number; tonuRevenue: number | null };
export const canInvoiceStatus = (status: string, tonuRevenue: number | null): boolean => status === "completed" || (status === "tonu" && (tonuRevenue ?? 0) > 0);
export function invoiceBasis(l: BasisLoad): { tonu: boolean; rate: number; surcharge: number; label: string } {
  const tonu = l.status === "tonu";
  return tonu ? { tonu, rate: l.tonuRevenue ?? 0, surcharge: 0, label: "TONU fee" } : { tonu, rate: l.quotedRevenue, surcharge: l.fuelSurcharge, label: "Line haul" };
}

export type ReadinessLoad = {
  status: string;
  brokerName: string | null;
  loadNumber: string | null;
  brokerEmail: string | null;
  brokerPhone: string | null;
  closedWithoutPod: boolean | null;
  podNote: string | null;
  /** How many delivery stops have no proof-of-delivery file on the load; absent when not known. */
  podStopsMissing?: number | null;
  quotedRevenue: number;
  /** What the broker actually paid for the linehaul, when that was entered at delivery. The invoice still bills the agreed rate. */
  paidLinehaul?: number | null;
};

/** What stops an invoice, and what only deserves a second look. A blocker would produce an invoice nobody can pay. */
export function invoiceReadiness(l: ReadinessLoad): { blockers: string[]; cautions: string[] } {
  const blockers: string[] = [];
  const cautions: string[] = [];
  const tonu = l.status === "tonu";
  if (l.status !== "completed" && !tonu) blockers.push("The load has to be delivered first.");
  if (!l.brokerName?.trim()) blockers.push("Who is it billed to? Add the customer on the load.");
  if (!l.loadNumber?.trim()) blockers.push("The invoice needs the load number. Add it on the load.");
  if (!(l.quotedRevenue > 0)) blockers.push(tonu ? "The TONU has no fee to bill." : "The load has no rate to bill.");
  // The invoice bills what was agreed; a different amount paid at delivery stays a short pay (or an over pay) against it, where the receivables can see it.
  if (!tonu && l.paidLinehaul != null && l.paidLinehaul > 0 && Math.abs(l.paidLinehaul - l.quotedRevenue) > 1) {
    const f = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    cautions.push(`The linehaul paid at delivery was ${f(l.paidLinehaul)}, not the agreed ${f(l.quotedRevenue)}. The invoice bills the agreed rate, so what comes in shows as ${l.paidLinehaul < l.quotedRevenue ? "short" : "over"} against it.`);
  }
  if (!l.brokerEmail?.trim() && !l.brokerPhone?.trim()) cautions.push("No contact for the customer's accounts team. Add an email or phone on the load so the invoice can be chased.");
  // A TONU delivered nothing, so there is no proof of delivery to ask for.
  if (tonu) return { blockers, cautions };
  if (l.closedWithoutPod) cautions.push("Closed without proof of delivery. Many customers hold payment until they have it.");
  else if ((l.podStopsMissing ?? 0) > 0) cautions.push("No proof of delivery file is kept on the load. Customers usually want it before they pay, and a factoring company will not buy the invoice without it.");
  else if (!l.podNote?.trim() && l.podStopsMissing == null) cautions.push("No note on the proof of delivery. Customers usually want it before they pay.");
  return { blockers, cautions };
}

export type InvoiceForm = { number: string; terms: string; detention: boolean; lumper: string; layover: string; otherLabel: string; other: string };
export type InvoiceContext = { rate: number; surcharge: number; detention: number; defaultTerms: number; /** What the rate is called on the invoice: "Line haul", or "TONU fee". */ rateLabel?: string };
export type InvoiceCheck = { ok: true; value: { number: string; terms: number; lines: InvoiceLine[]; total: number } } | { ok: false; errors: Record<string, string> };

/** Dollars and cents as typed: digits with at most two after the point. Read as text, never by multiplying by 100 (19.99 * 100 is 1998.9999999999998), so 19.99, 8.20 and 1.15 are all fine. */
const dollars = (raw: string): { n: number; bad: boolean } => {
  const s = raw.trim().replace(/,/g, "");
  if (s === "") return { n: 0, bad: false };
  const n = Number(s);
  const bad = !/^\d+(\.\d{1,2})?$/.test(s) || !Number.isFinite(n) || n > 100000;
  return { n: bad ? 0 : n, bad };
};

/** Names an invoice line already has (compared in lower case): an "other" charge may not take one of them. */
export const RESERVED_LABELS = ["line haul", "tonu fee", "fuel surcharge", "detention", "lumper", "layover"];

export function validateInvoice(form: InvoiceForm, ctx: InvoiceContext): InvoiceCheck {
  const errors: Record<string, string> = {};
  const number = form.number.trim();
  if (number === "") errors.number = "Give the invoice a number.";
  else if (number.length > 40) errors.number = "40 characters at most.";
  const termsRaw = form.terms.trim();
  const terms = termsRaw === "" ? ctx.defaultTerms : Number(termsRaw);
  if (!Number.isInteger(terms) || terms < 0 || terms > 120) errors.terms = "Whole days, 0 to 120.";
  const lumper = dollars(form.lumper);
  const layover = dollars(form.layover);
  const other = dollars(form.other);
  if (lumper.bad) errors.lumper = "Dollars and cents, 0 to 100,000.";
  if (layover.bad) errors.layover = "Dollars and cents, 0 to 100,000.";
  if (other.bad) errors.other = "Dollars and cents, 0 to 100,000.";
  if (other.n > 0 && form.otherLabel.trim() === "") errors.otherLabel = "Say what the extra charge is for.";
  if (form.otherLabel.trim().length > 40) errors.otherLabel = "40 characters at most.";
  // A line called "Detention" or "Line haul" would be read as that charge (the detention billed, the rate) and could double a line already on the invoice.
  if (other.n > 0 && RESERVED_LABELS.includes(form.otherLabel.trim().toLowerCase())) errors.otherLabel = "That name is already a line of its own. Use the field for it, or call this something else.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const extras: InvoiceLine[] = [];
  if (form.detention && ctx.detention > 0) extras.push({ label: "Detention", amount: ctx.detention });
  if (lumper.n > 0) extras.push({ label: "Lumper", amount: lumper.n });
  if (layover.n > 0) extras.push({ label: "Layover", amount: layover.n });
  if (other.n > 0) extras.push({ label: form.otherLabel.trim(), amount: other.n });
  const total = invoiceTotalDue({ quotedRevenue: ctx.rate, fuelSurcharge: ctx.surcharge > 0 ? ctx.surcharge : null }, extras);
  const lines: InvoiceLine[] = [{ label: ctx.rateLabel ?? "Line haul", amount: ctx.rate }, ...(ctx.surcharge > 0 ? [{ label: "Fuel surcharge", amount: ctx.surcharge }] : []), ...extras];
  return { ok: true, value: { number, terms, lines, total } };
}

/**
 * What is still owed on an invoice that is out: the invoice less what has come in so far, in whole cents. An invoice with no amount (billed before amounts were kept) has none to
 * subtract from and is returned as it is, for the caller to fall back on the load's rate. Ageing, the KPI and the lists all count this, so a part-paid invoice is owed its balance.
 */
export function owedOf(invoiced: number | null, received: number | null): number | null {
  if (invoiced == null) return null;
  const cents = (n: number) => Number((n * 100).toFixed(0));
  return Math.max(0, cents(invoiced) - cents(received ?? 0)) / 100;
}

/** Terms in words: "Net 30", or "Due on receipt" for 0 days. */
export const termsLabel = (days: number | null | undefined): string => (days === 0 ? "Due on receipt" : `Net ${days ?? 0}`);

/** The default invoice number for a load. */
export const defaultInvoiceNumber = (loadNumber: string | null, loadId: string) => `INV-${loadNumber ?? loadId.slice(-6)}`;

/**
 * The number to offer for an invoice: the load's own, or, when that number has already gone to a customer and been taken back (or is on another load), the next revision: INV-1234-2,
 * INV-1234-3. A customer's payables will not take a second invoice under a number it has seen. `used` is every number to avoid, compared as typed.
 */
export function revisedInvoiceNumber(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  for (let n = 2; n < 200; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${used.size + 1}`;
}

/**
 * A reminder to send a broker whose invoice is past its terms, ready to paste into an email. Plain and polite, with every number the accounts
 * team will ask for. The desk does not send it: that is outward-facing, and goes out from whoever is on the account.
 */
export function reminderText(i: { broker: string | null; invoiceNumber: string | null; loadNumber: string | null; poNumber: string | null; amount: number; sent: Date; due: Date; now: Date; origin: string | null; destination: string | null }): string {
  const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: activeTz() });
  const late = Math.max(0, deskDaysBetween(i.due, i.now));
  return [
    `Hello${i.broker ? ` ${i.broker} accounts team` : ""},`,
    "",
    `A reminder that invoice ${i.invoiceNumber ?? ""} for $${i.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} was due ${day(i.due)}${late > 0 ? `, ${late} ${late === 1 ? "day" : "days"} ago` : ""}.`,
    "",
    `Load: ${i.loadNumber ?? "n/a"}${i.poNumber ? `   PO: ${i.poNumber}` : ""}`,
    `Route: ${i.origin ?? "?"} to ${i.destination ?? "?"}`,
    `Invoice sent: ${day(i.sent)}`,
    "",
    "Please confirm when payment will go out, or tell us what you need from us to release it.",
    "",
    "Thank you."
  ].join("\n");
}
