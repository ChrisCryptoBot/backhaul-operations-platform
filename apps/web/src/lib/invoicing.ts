import { invoiceTotalDue } from "@/truelane/lib/invoice";

/**
 * Billing a delivered load: what must be true first, the lines that make the total, and the reminder to send when it is late. Pure, so the
 * dialog totals it as you type with the same TrueLane function the server uses to bill.
 */
export type InvoiceLine = { label: string; amount: number };

export type ReadinessLoad = {
  status: string;
  brokerName: string | null;
  loadNumber: string | null;
  brokerEmail: string | null;
  brokerPhone: string | null;
  closedWithoutPod: boolean | null;
  podNote: string | null;
  quotedRevenue: number;
};

/** What stops an invoice, and what only deserves a second look. A blocker would produce an invoice nobody can pay. */
export function invoiceReadiness(l: ReadinessLoad): { blockers: string[]; cautions: string[] } {
  const blockers: string[] = [];
  const cautions: string[] = [];
  if (l.status !== "completed") blockers.push("The load has to be delivered first.");
  if (!l.brokerName?.trim()) blockers.push("Who is it billed to? Add the customer on the load.");
  if (!l.loadNumber?.trim()) blockers.push("The invoice needs the load number. Add it on the load.");
  if (!(l.quotedRevenue > 0)) blockers.push("The load has no rate to bill.");
  if (!l.brokerEmail?.trim() && !l.brokerPhone?.trim()) cautions.push("No contact for the customer's accounts team. Add an email or phone on the load so the invoice can be chased.");
  if (l.closedWithoutPod) cautions.push("Closed without proof of delivery. Many customers hold payment until they have it.");
  else if (!l.podNote?.trim()) cautions.push("No note on the proof of delivery. Customers usually want it before they pay.");
  return { blockers, cautions };
}

export type InvoiceForm = { number: string; terms: string; detention: boolean; lumper: string; layover: string; otherLabel: string; other: string };
export type InvoiceContext = { rate: number; surcharge: number; detention: number; defaultTerms: number };
export type InvoiceCheck = { ok: true; value: { number: string; terms: number; lines: InvoiceLine[]; total: number } } | { ok: false; errors: Record<string, string> };

const dollars = (raw: string): { n: number; bad: boolean } => {
  const s = raw.trim().replace(/,/g, "");
  if (s === "") return { n: 0, bad: false };
  const n = Number(s);
  const bad = !Number.isFinite(n) || n < 0 || n > 100000 || Math.abs(n * 100 - Math.trunc(n * 100)) > 1e-6;
  return { n: bad ? 0 : n, bad };
};

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
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const extras: InvoiceLine[] = [];
  if (form.detention && ctx.detention > 0) extras.push({ label: "Detention", amount: ctx.detention });
  if (lumper.n > 0) extras.push({ label: "Lumper", amount: lumper.n });
  if (layover.n > 0) extras.push({ label: "Layover", amount: layover.n });
  if (other.n > 0) extras.push({ label: form.otherLabel.trim(), amount: other.n });
  const total = invoiceTotalDue({ quotedRevenue: ctx.rate, fuelSurcharge: ctx.surcharge > 0 ? ctx.surcharge : null }, extras);
  const lines: InvoiceLine[] = [{ label: "Line haul", amount: ctx.rate }, ...(ctx.surcharge > 0 ? [{ label: "Fuel surcharge", amount: ctx.surcharge }] : []), ...extras];
  return { ok: true, value: { number, terms, lines, total } };
}

/** The default invoice number for a load. */
export const defaultInvoiceNumber = (loadNumber: string | null, loadId: string) => `INV-${loadNumber ?? loadId.slice(-6)}`;

/**
 * A reminder to send a broker whose invoice is past its terms, ready to paste into an email. Plain and polite, with every number the accounts
 * team will ask for. The desk does not send it: that is outward-facing, and goes out from whoever is on the account.
 */
export function reminderText(i: { broker: string | null; invoiceNumber: string | null; loadNumber: string | null; poNumber: string | null; amount: number; sent: Date; due: Date; now: Date; origin: string | null; destination: string | null }): string {
  const day = (d: Date) => d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  const late = Math.floor((i.now.getTime() - i.due.getTime()) / 86_400_000);
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
