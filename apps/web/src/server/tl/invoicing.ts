import type { Terminals } from "@/lib/scope";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { billedOf } from "@/lib/billed";
import { termsLabel, canInvoiceStatus, defaultInvoiceNumber, invoiceBasis, invoiceReadiness, revisedInvoiceNumber, validateInvoice, validateSupplementalLines, type InvoiceForm, type SupplementalLineInput } from "@/lib/invoicing";
import { isPaidMethod, paidMethodLabel } from "@/lib/pay-method";
import { parseCentralLocal, toCentralLocal } from "@/lib/zoned";
import { customerTermsMap } from "./customers";
import { recordAudit } from "./audit";
import { toCompany } from "./company";
import { num, numOrNull } from "./convert";
import { dueAt } from "@/lib/overdue";
import { podStopsMissing } from "./documents";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { allowedFor } from "./scope";
import { inTerminal } from "./terminal-sql";
import { balanceOf, isShortCode } from "@/lib/invoice-records";
import { detentionOfLoad, supplementalDetentionByLoad } from "./detention";
import { customerKey, MAX_LOADS_PER_INVOICE } from "@/lib/customer-key";
import { addInvoicePayment, closeInvoiceRecord, createInvoiceRecord, openInvoiceOf, projectionOf, removeLastInvoicePayment, voidInvoiceRecord } from "./invoice-records";
import { emitInvoice, emitPayment } from "@/server/webhooks/emit";
import { workspaceTimezone } from "./zone";

/**
 * Invoice a delivered load, mark an invoice paid (in full or short), and take a payment back. Each writes its audit event with the change.
 * The amount is TrueLane's "total due": the agreed rate plus the billable fuel surcharge plus the extra charges chosen (detention, lumper,
 * layover, one other), and the invoice keeps its lines so it can be printed as it was billed. A load with nobody to bill, or no number to
 * bill under, is refused: that invoice could not be paid.
 */
/** The invoice numbers a load has already had taken back, from its history. */
export async function voidedInvoiceNumbers(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (loadIds.length === 0) return out;
  const events = await prisma.auditEvent.findMany({ where: { workspaceId, action: "invoice_voided", loadId: { in: loadIds } }, select: { loadId: true, before: true } });
  for (const e of events) {
    const n = e.before && typeof e.before === "object" && !Array.isArray(e.before) ? (e.before as Record<string, unknown>).Invoice : null;
    if (e.loadId && typeof n === "string") out.set(e.loadId, (out.get(e.loadId) ?? new Set()).add(n));
  }
  return out;
}

/** The number to offer on the invoice for this load: its own, or the next revision when that one has been sent and taken back, or is on another load of the desk. */
export async function suggestedInvoiceNumber(load: { id: string; loadNumber: string | null }, workspaceId = currentWorkspaceId()): Promise<string> {
  const base = defaultInvoiceNumber(load.loadNumber, load.id);
  // A number is used for good once an invoice record has it (void, or of a load since removed), not only while a load carries it.
  const [voided, taken, records] = await Promise.all([
    voidedInvoiceNumbers([load.id], workspaceId),
    prisma.load.findMany({ where: { workspaceId, deletedAt: null, id: { not: load.id }, invoiceNumber: { startsWith: base } }, select: { invoiceNumber: true } }),
    prisma.invoice.findMany({ where: { workspaceId, number: { startsWith: base } }, select: { number: true } })
  ]);
  const used = new Set<string>([...(voided.get(load.id) ?? []), ...taken.map((t) => t.invoiceNumber!).filter(Boolean), ...records.map((r) => r.number)]);
  return revisedInvoiceNumber(base, used);
}

/**
 * Record that a late invoice was chased (an email opened to the customer's accounts team, or a call made), so the next person sees when and by whom. The desk sends nothing itself; this is
 * only the memory of it. Audited as a muted event on the load.
 */
async function invoiceInScope(invoiceId: string, workspaceId: string, scope: Terminals): Promise<boolean> {
  if (scope == null) return true;
  const rec = await prisma.invoice.findFirst({ where: { id: invoiceId, workspaceId }, select: { creditOfId: true, supplementOfId: true, loads: { select: { loadId: true } } } });
  if (!rec) return false;
  let loadIds = rec.loads.map((l) => l.loadId);
  const parentId = rec.creditOfId ?? rec.supplementOfId;
  if (loadIds.length === 0 && parentId) {
    const parent = await prisma.invoice.findFirst({ where: { id: parentId, workspaceId }, select: { loads: { select: { loadId: true } } } });
    loadIds = parent?.loads.map((l) => l.loadId) ?? [];
  }
  if (loadIds.length === 0) return true;
  const count = await prisma.load.count({ where: { id: { in: loadIds }, workspaceId, ...inTerminal(scope) } });
  return count === loadIds.length;
}

export async function recordChase(loadId: string, how: "email" | "phone", now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<{ ok: boolean; error?: string }> {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: "invoiced", ...inTerminal(scope) }, select: { loadNumber: true, invoiceNumber: true, brokerName: true } });
  if (!load) return { ok: false, error: "That invoice is not out any more." };
  await recordAudit({ entity: "invoice", action: "invoice_chased", loadId, loadNumber: load.loadNumber, summary: `${load.invoiceNumber ?? "Invoice"} chased by ${how === "email" ? "email" : "phone"}${load.brokerName ? ` (${load.brokerName})` : ""}`, before: null, after: { Invoice: load.invoiceNumber, How: how === "email" ? "Email" : "Phone" }, at: now, workspaceId });
  return { ok: true };
}

export type InvoiceOut = { ok: boolean; detention: number; total?: number; error?: string; errors?: Record<string, string> };

export async function invoiceLoad(loadId: string, opts: { includeDetention?: boolean; form?: InvoiceForm } = {}, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<InvoiceOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
  if (!load) return { ok: false, detention: 0, error: "That load does not exist." };
  if (load.paymentStatus) return { ok: false, detention: 0, error: `${load.invoiceNumber ?? "This load"} is already invoiced. Reload the page.` };
  if (!canInvoiceStatus(load.status, numOrNull(load.tonuRevenue))) return { ok: false, detention: 0, error: "Only a delivered load, or a TONU with a fee, can be invoiced." };
  const basis = invoiceBasis({ status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: num(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const ready = invoiceReadiness({ ...load, quotedRevenue: basis.rate, paidLinehaul: numOrNull(load.actualRevenue), podStopsMissing: (await podStopsMissing([load.id], workspaceId)).get(load.id) ?? null });
  if (ready.blockers.length > 0) return { ok: false, detention: 0, error: ready.blockers[0] };

  const thresholds = await getThresholds(workspaceId);
  // A TONU hauled nothing, so there is no detention to bill on it.
  const billable = basis.tonu ? 0 : detentionOfLoad(load, thresholds.detentionGraceMinutes).billable;
  const form: InvoiceForm = opts.form ?? { number: await suggestedInvoiceNumber(load, workspaceId), terms: "", detention: !!opts.includeDetention, lumper: "", layover: "", otherLabel: "", other: "" };
  const check = validateInvoice(form, { rate: basis.rate, surcharge: basis.surcharge, detention: billable, rateLabel: basis.label, defaultTerms: load.payTermsDays ?? (await customerTermsMap(load.workspaceId)).get((load.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays });
  if (!check.ok) return { ok: false, detention: 0, errors: check.errors };
  const { number, terms, lines, total } = check.value;
  const detention = lines.find((l) => l.label === "Detention")?.amount ?? 0;
  const extra = lines.filter((l) => l.label !== basis.label && l.label !== "Fuel surcharge");
  const takenMessage = (on: string | null) => ({ ok: false as const, detention: 0, errors: { number: `${number} is already on ${on ?? "another load"}. Use another number.` } });
  try {
    await prisma.$transaction(async (tx) => {
      // Checked inside the transaction that writes it, and backed by a unique index, so two invoices saved at once cannot share a number.
      const taken = await tx.load.findFirst({ where: { workspaceId: load.workspaceId, invoiceNumber: number, deletedAt: null, id: { not: loadId } }, select: { loadNumber: true } });
      if (taken) throw new NumberTaken(taken.loadNumber);
      // Only a load that is not invoiced yet is invoiced: two clicks, or two tabs, make one invoice and leave its date and its audit entry alone.
      const claimed = await tx.load.updateMany({ where: { id: loadId, workspaceId, deletedAt: null, status: { in: ["completed", "tonu"] }, paymentStatus: null, ...inTerminal(scope) }, data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: total, invoiceNumber: number, payTermsDays: terms, invoiceLines: lines } });
      if (claimed.count !== 1) throw new AlreadyInvoiced();
      // The invoice as its own record, in the same transaction as the load's projection of it (docs/MONEY_PLAN.md, Wave 1).
      await createInvoiceRecord(tx, {
        workspaceId,
        number,
        issuedAt: now,
        termsDays: terms,
        billTo: { name: load.brokerName, mc: load.brokerMcNumber, email: load.brokerEmail, phone: load.brokerPhone },
        lines: lines.map((l) => ({ loadId, label: l.label, amount: l.amount })),
        loadIds: [loadId]
      });
      await recordAudit(
        {
          entity: "invoice",
          action: "invoiced",
          loadId,
          loadNumber: load.loadNumber,
          summary: `${number} created for $${total.toFixed(2)}${extra.length > 0 ? `, with ${extra.map((l) => `$${l.amount.toFixed(2)} of ${l.label.toLowerCase()}`).join(" and ")}` : ""}`,
          before: { Invoice: null, Amount: null, "Terms before": load.payTermsDays == null ? null : String(load.payTermsDays) },
          after: { Invoice: number, Amount: `$${total.toFixed(2)}`, ...Object.fromEntries(extra.map((l) => [l.label, `$${l.amount.toFixed(2)}`])), Terms: termsLabel(terms) },
          at: now, workspaceId
        },
        tx
      );
    });
  } catch (e) {
    if (e instanceof AlreadyInvoiced) return { ok: false, detention: 0, error: "This load was just invoiced, or is no longer ready to invoice. Reload the page." };
    if (e instanceof NumberTaken) return takenMessage(e.on);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return takenMessage(null);
    throw e;
  }
  return { ok: true, detention, total };
}

class AlreadyInvoiced extends Error {
  constructor() {
    super("already invoiced");
  }
}

class NumberTaken extends Error {
  constructor(readonly on: string | null) {
    super("invoice number taken");
  }
}

export type PaidOut = {
  ok: boolean;
  error?: string;
  /** Negative when the invoice was closed for less than it was billed (the rest written off); positive when more came in than was owed. */
  difference?: number;
  /** The payment was part of what is owed: the invoice stays out, and this is what is still owed. */
  balance?: number;
  /** A write-off was asked for and no reason was given. */
  needsShortReason?: boolean;
};

/** What to do with the part of the invoice a payment does not cover: keep it open as a balance (the default), or close the invoice and write it off. */
export type ShortAction = "balance" | "writeoff";

/** Factoring states of an invoice the factor has not yet been paid on: a customer paying it in full closes them all. */
const FACTORED_OPEN = ["requested", "submitted", "funded"];
const dayOf = (d: Date, tz: string) => toCentralLocal(d.getTime(), tz).slice(0, 10);
const dec = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2);

/**
 * Record a payment against an invoice. The amount defaults to what is still owed. Paying all of it (or more) closes the invoice. Paying LESS keeps the invoice out with the balance
 * still owed, and ageing, the KPI and the lists all count the balance, not the invoice; or, with `shortAction: "writeoff"` and a reason, closes it and writes the rest off (the reason
 * is kept in the audit entry). Each payment is a row of its own (what came in, on which day, how), and the load's paid amount is their sum.
 */
export async function markLoadPaid(
  loadId: string,
  now = new Date(),
  opts: {
    amount?: number;
    /** The day it came in, "2026-10-29" on the Dallas calendar; today when blank. */ paidOn?: string;
    method?: string;
    shortAction?: ShortAction;
    /** Why the rest is written off (needed with "writeoff"). */ shortReason?: string;
    /** The same, as a code a report can count (src/lib/invoice-records.ts SHORT_CODES). */ shortCode?: string;
    /** The check number, ACH trace or remittance id. */ reference?: string;
    /** Who paid, when not the customer billed (a factor, a quick-pay service). */ payer?: string;
    /** Where the payment was learned from: the desk (typed), a factor's status file, or the accounting system (a payment a bookkeeper entered there, pulled by the sync). */ source?: "desk" | "factor" | "accounting";
    /** The outside system's own id for this payment: with the source it is unique, so the same payment pulled twice is recorded once. */ externalId?: string;
  } = {},
  workspaceId = currentWorkspaceId(),
  allowed?: Terminals
): Promise<PaidOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const shared = await sharedInvoiceOf(loadId, workspaceId);
  if (shared) return payInvoiceRecord(shared, now, opts, workspaceId, scope);
  if (load.paymentStatus !== "invoiced") return { ok: false, error: load.paymentStatus === "paid" ? `${load.invoiceNumber ?? "This invoice"} is already paid. Reload the page.` : "This load has no invoice that is waiting for payment." };
  const billed = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const before = numOrNull(load.paidAmount) ?? 0;
  const owing = dec(billed).minus(dec(before)).toNumber();
  const amount = opts.amount ?? owing;
  if (!Number.isFinite(amount) || !(amount > 0) || amount > 1_000_000) return { ok: false, error: "Type the amount that came in, above zero." };
  if (dec(amount).toNumber() !== amount) return { ok: false, error: "Dollars and cents, like 1,250.50." };
  const method = (opts.method ?? "").trim();
  if (method !== "" && !isPaidMethod(method)) return { ok: false, error: "Pick how it was paid from the list." };
  // A payment can be entered late: the day it actually came in, never before the invoice and never in the future. Days-to-pay counts from it.
  const tz = await workspaceTimezone(workspaceId);
  const today = dayOf(now, tz);
  const paidOn = (opts.paidOn ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || parseCentralLocal(`${paidOn}T12:00`, tz) == null) return { ok: false, error: "Type the day it was paid, like 2026-10-29." };
  if (paidOn > today) return { ok: false, error: "A payment cannot come in on a day that has not happened." };
  if (load.invoicedAt && paidOn < dayOf(load.invoicedAt, tz)) return { ok: false, error: `The invoice went out on ${dayOf(load.invoicedAt, tz)}, so it cannot be paid before that.` };
  const paidAt = paidOn === today ? now : new Date(parseCentralLocal(`${paidOn}T12:00`, tz)!);

  const after = dec(before).plus(dec(amount));
  const diff = after.minus(dec(billed)).toNumber(); // < 0 short, > 0 over
  const short = diff < 0;
  const shortBy = dec(diff).abs().toNumber();
  const writeoff = short && opts.shortAction === "writeoff";
  const shortWhy = (opts.shortReason ?? "").trim();
  if (writeoff && shortWhy.length < 3) {
    return { ok: false, needsShortReason: true, error: `Closing the invoice $${shortBy.toFixed(2)} short writes the $${shortBy.toFixed(2)} off, so say why (the customer's deduction, a damage claim, a negotiated discount).` };
  }
  const partial = short && !writeoff;
  const gap = shortBy.toFixed(2);
  const what = `${load.invoiceNumber ?? "Invoice"}`;
  const how = method ? ` by ${paidMethodLabel(method).toLowerCase()}` : "";
  const onDay = paidOn !== today ? ` on ${paidOn}` : "";

  const done = await prisma.$transaction(async (tx) => {
    // Only the invoice as it was read is changed: a second click, or a payment entered in another tab a moment ago, finds the amount received has moved and records nothing twice.
    const claimed = await tx.load.updateMany({
      where: { id: loadId, paymentStatus: "invoiced", paidAmount: load.paidAmount },
      data: partial ? { paidAmount: after, paidMethod: method || null } : { paymentStatus: "paid", paidAt, paidAmount: after, paidMethod: method || null, ...(FACTORED_OPEN.includes(load.factoringStatus) ? { factoringStatus: "paid", factoringUpdatedAt: now } : {}), ...(writeoff ? { writeOffAmount: dec(shortBy), writeOffReason: shortWhy } : {}) }
    });
    if (claimed.count !== 1) return false;
    await tx.loadPayment.create({ data: { workspaceId, loadId, amount: dec(amount), paidAt, method: method || null } });
    const record = await openInvoiceOf(tx, workspaceId, loadId);
    if (record) {
      await addInvoicePayment(tx, { workspaceId, invoiceId: record.id, amount, paidAt, method: method || null, reference: opts.reference, payer: opts.payer, source: opts.source ?? "desk", externalId: opts.externalId });
      if (!partial) {
        await closeInvoiceRecord(tx, record.id, {
          paidAt,
          writeOff: writeoff ? { amount: shortBy, reason: shortWhy, code: isShortCode(opts.shortCode) ? opts.shortCode : null } : null,
          factoringPaid: FACTORED_OPEN.includes(load.factoringStatus),
          now
        });
      }
    }
    await recordAudit(
      partial
        ? {
            entity: "invoice",
            action: "payment_part",
            loadId,
            loadNumber: load.loadNumber,
            summary: `${what}: $${amount.toFixed(2)} received${how}${onDay}; $${gap} still owed of $${billed.toFixed(2)}`,
            before: { Status: "Invoiced", Received: `$${before.toFixed(2)}`, Owed: `$${owing.toFixed(2)}` },
            after: { Status: "Invoiced, part paid", Received: `$${after.toNumber().toFixed(2)}`, Owed: `$${gap}` },
            at: now, workspaceId
          }
        : {
            entity: "invoice",
            action: "paid",
            loadId,
            loadNumber: load.loadNumber,
            summary: `${what} paid${how}${onDay}, $${after.toNumber().toFixed(2)} in all${before > 0 ? ` ($${amount.toFixed(2)} this time)` : ""}${short ? `, $${gap} short of $${billed.toFixed(2)}, written off` : diff > 0 ? `, $${diff.toFixed(2)} over $${billed.toFixed(2)}` : ""}`,
            reason: short ? shortWhy : null,
            before: { Status: before > 0 ? "Invoiced, part paid" : "Invoiced", Billed: `$${billed.toFixed(2)}` },
            after: { Status: "Paid", Amount: `$${after.toNumber().toFixed(2)}`, ...(method ? { Method: paidMethodLabel(method) } : {}), ...(paidOn !== today ? { "Paid on": paidOn } : {}), ...(diff !== 0 ? { Difference: `${diff < 0 ? "-" : "+"}$${gap}` } : {}) },
            at: now, workspaceId
          },
      tx
    );
    return true;
  });
  if (!done) return { ok: false, error: "That invoice changed while you were looking at it. Reload and try again." };
  if (partial) return { ok: true, balance: shortBy };
  return diff === 0 ? { ok: true } : { ok: true, difference: diff };
}

/**
 * Take an invoice back: it was made for the wrong amount, the wrong customer, or on a load that should not have been billed. The invoice goes away (its number, date, lines and
 * amount are cleared) and the load is ready to invoice again, with the reason kept in the audit entry. A paid invoice is taken back first ("Undo payment"); one that has gone to a
 * factoring company is not the desk's to take back.
 */
export async function voidInvoice(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<PaidOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the invoice is being taken back." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const shared = await sharedInvoiceOf(loadId, workspaceId);
  if (shared) {
    if (!(await invoiceInScope(shared, workspaceId, scope))) return { ok: false, error: "That invoice does not exist." };
    return voidSharedInvoice(shared, why, now, workspaceId);
  }
  if (load.paymentStatus === "paid") return { ok: false, error: "This invoice is marked paid. Take the payment back first." };
  if (load.paymentStatus !== "invoiced") return { ok: false, error: "This load has no invoice." };
  if ((numOrNull(load.paidAmount) ?? 0) > 0) return { ok: false, error: "Payments have been recorded on this invoice. Take them back first." };
  // A request the factor turned down is as if it was never made; anything else has gone to them and is not the desk's to take back.
  if (load.factoringStatus !== "none" && load.factoringStatus !== "rejected") return { ok: false, error: "This invoice has gone to a factoring company. It cannot be taken back here." };
  const was = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  // The terms the load had before this invoice set its own (the invoice dialog writes them onto the load), so a taken-back invoice does not leave its terms behind.
  const issued = await prisma.auditEvent.findFirst({ where: { workspaceId, loadId, action: "invoiced" }, orderBy: { createdAt: "desc" }, select: { before: true } });
  const beforeSnap = issued?.before && typeof issued.before === "object" && !Array.isArray(issued.before) ? (issued.before as Record<string, unknown>) : null;
  const hadTerms = beforeSnap && "Terms before" in beforeSnap ? (beforeSnap["Terms before"] == null ? null : num(beforeSnap["Terms before"] as never)) : undefined;
  const voided = await prisma.$transaction(async (tx) => {
    // Only the invoice as it was read: no payment may have landed since (a row of its own, or the amount received), and the load must still be there.
    const claimed = await tx.load.updateMany({
      where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: "invoiced", paidAmount: null, payments: { none: {} }, factoringStatus: { in: ["none", "rejected"] } },
      data: { paymentStatus: null, invoicedAt: null, invoicedAmount: null, invoiceNumber: null, invoiceLines: Prisma.JsonNull, ...(hadTerms !== undefined ? { payTermsDays: hadTerms } : {}), ...(load.factoringStatus === "rejected" ? { factoringStatus: "none", factoringReferenceId: null } : {}) }
    });
    if (claimed.count !== 1) return false;
    const record = await openInvoiceOf(tx, workspaceId, loadId);
    if (record) await voidInvoiceRecord(tx, record.id, why, now);
    await recordAudit(
      {
        entity: "invoice",
        action: "invoice_voided",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${load.invoiceNumber ?? "Invoice"} for $${was.toFixed(2)} taken back`,
        reason: why,
        before: { Status: "Invoiced", Invoice: load.invoiceNumber, Amount: `$${was.toFixed(2)}` },
        after: { Status: "Ready to invoice", Invoice: null, Amount: null },
        at: now, workspaceId
      },
      tx
    );
    return true;
  });
  return voided ? { ok: true } : { ok: false, error: "That invoice changed while you were looking at it (a payment may have just been recorded). Reload the load." };
}

/**
 * Take the latest payment back: one entered against the wrong invoice, or one that bounced. Its row is removed and the amount received is what the others add up to; if the invoice
 * was closed it is out again, with whatever is then owed. The reason is kept. (An invoice marked paid before payments were kept one by one has no rows: taking it back clears it.)
 */
export async function undoPaid(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<PaidOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the payment is being taken back." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) } });
  if (!load) return { ok: false, error: "That load does not exist." };
  type LoadRead = NonNullable<typeof load>;
  const sharedId = await sharedInvoiceOf(loadId, workspaceId);
  if (sharedId) {
    if (!(await invoiceInScope(sharedId, workspaceId, scope))) return { ok: false, error: "That invoice does not exist." };
    return undoSharedPayment(sharedId, why, now, workspaceId);
  }
  const received = numOrNull(load.paidAmount) ?? 0;
  const hasPayment = load.paymentStatus === "paid" || (load.paymentStatus === "invoiced" && received > 0);
  if (!hasPayment) return { ok: false, error: "No payment has been recorded on this invoice." };
  const billed = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  let out: boolean;
  try {
    out = await undoPaidTx(load);
  } catch (e) {
    if (e instanceof CreditNotPayment) return { ok: false, error: "The last amount on this invoice is a credit memo. Void the credit memo instead." };
    throw e;
  }
  return out ? { ok: true } : { ok: false, error: "That payment was already taken back, or the invoice changed. Reload the load." };

  function undoPaidTx(load: LoadRead) {
  return prisma.$transaction(async (tx) => {
    // Taken back once: the invoice has to still be in the state (status and amount received) it was read in, or this is a second press, or another person's undo, and it does nothing.
    const claimed = await tx.load.updateMany({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: load.paymentStatus, paidAmount: load.paidAmount }, data: { updatedAt: now } });
    if (claimed.count !== 1) return false;
    const last = await tx.loadPayment.findFirst({ where: { loadId, workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    // A credit memo's amount is not a payment to take back: the memo is voided instead (docs/MONEY_PLAN.md, rule F).
    if (last?.method === "credit") throw new CreditNotPayment();
    if (last) await tx.loadPayment.delete({ where: { id: last.id } });
    const rest = last ? await tx.loadPayment.aggregate({ _sum: { amount: true }, where: { loadId, workspaceId } }) : null;
    const left = last ? dec(rest?._sum.amount ? rest._sum.amount.toNumber() : 0) : dec(0);
    const lastTaken = last ? last.amount.toNumber() : received;
    const lastPaid = last ? await tx.loadPayment.findFirst({ where: { loadId, workspaceId }, orderBy: [{ paidAt: "desc" }, { id: "desc" }] }) : null;
    const record = await openInvoiceOf(tx, workspaceId, loadId);
    if (record) await removeLastInvoicePayment(tx, record.id, { factoringBackToFunded: load.factoringStatus === "paid", now });
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", paidAt: null, paidAmount: left.toNumber() > 0 ? left : null, paidMethod: lastPaid?.method ?? null, writeOffAmount: null, writeOffReason: null, ...(load.factoringStatus === "paid" ? { factoringStatus: "funded", factoringUpdatedAt: now } : {}) } });
    await recordAudit(
      {
        entity: "invoice",
        action: "payment_undone",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${load.invoiceNumber ?? "Invoice"} payment of $${lastTaken.toFixed(2)} taken back${left.toNumber() > 0 ? `; $${left.toNumber().toFixed(2)} still counted as received` : ""}`,
        reason: why,
        before: { Status: load.paymentStatus === "paid" ? "Paid" : "Invoiced, part paid", Amount: `$${received.toFixed(2)}` },
        after: { Status: left.toNumber() > 0 ? "Invoiced, part paid" : "Invoiced", Amount: left.toNumber() > 0 ? `$${left.toNumber().toFixed(2)}` : null, Owed: `$${dec(billed).minus(left).toNumber().toFixed(2)}` },
        at: now, workspaceId
      },
      tx
    );
    return true;
  });
  }
}

class CreditNotPayment extends Error {
  constructor() {
    super("credit, not a payment");
  }
}

export type CreditOut = { ok: boolean; error?: string; number?: string; closed?: boolean };

/**
 * Credit part or all of what is still owed on an open invoice (docs/MONEY_PLAN.md, rule F): a credit memo of its own (negative, naming the invoice), applied to the invoice as a
 * credit so the balance, the aging and the load's amount received all fall by it. The original stays invoiced at its full amount. A credit that covers the rest closes the invoice.
 */
export async function issueCreditMemo(loadId: string, input: { amount: number; reason: string; label?: string }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<CreditOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = (input.reason ?? "").trim();
  if (why.length < 3) return { ok: false, error: "Say why the customer is credited." };
  const amount = input.amount;
  if (!Number.isFinite(amount) || !(amount > 0)) return { ok: false, error: "Type the amount to credit, above zero." };
  if (dec(amount).toNumber() !== amount) return { ok: false, error: "Dollars and cents, like 125.50." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, ...inTerminal(scope) } });
  if (!load) return { ok: false, error: "That load does not exist." };
  if (load.paymentStatus !== "invoiced") return { ok: false, error: load.paymentStatus === "paid" ? "This invoice is paid. A credit after payment is a refund, which the desk does not record." : "This load has no open invoice." };
  // A credit on an invoice a factor has (or is being asked to take) is the factor's to settle: it would cut what the factor collects and so its reserve. Refused, not guessed at.
  if (FACTORED_OPEN.includes(load.factoringStatus)) return { ok: false, error: "This invoice is with a factoring company, so a credit changes what the factor collects and is settled with the factor, not here. Record what the factor reports instead." };
  const sharedId = await sharedInvoiceOf(loadId, workspaceId);
  if (sharedId) {
    if (!(await invoiceInScope(sharedId, workspaceId, scope))) return { ok: false, error: "That invoice does not exist." };
    return creditSharedInvoice(sharedId, { amount, label: input.label }, why, now, workspaceId);
  }
  const billed = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const before = numOrNull(load.paidAmount) ?? 0;
  const owing = dec(billed).minus(dec(before));
  if (dec(amount).gt(owing)) return { ok: false, error: `Only $${owing.toNumber().toFixed(2)} is still owed, so the credit can be at most that.` };
  const label = (input.label ?? "").trim() || "Credit";
  const after = dec(before).plus(dec(amount));
  const closes = after.gte(dec(billed));
  try {
    return await prisma.$transaction(async (tx) => {
      const record = await openInvoiceOf(tx, workspaceId, loadId);
      if (!record) return { ok: false, error: "This invoice has no record to credit (an imported invoice with no number)." };
      const claimed = await tx.load.updateMany({
        where: { id: loadId, workspaceId, paymentStatus: "invoiced", paidAmount: load.paidAmount },
        data: closes ? { paymentStatus: "paid", paidAt: now, paidAmount: after } : { paidAmount: after }
      });
      if (claimed.count !== 1) return { ok: false, error: "That invoice changed while you were looking at it. Reload and try again." };
      const credits = await tx.invoice.count({ where: { workspaceId, creditOfId: record.id } });
      const number = `${record.number}-CR${credits + 1}`;
      const memo = await tx.invoice.create({
        data: {
          workspaceId,
          number,
          kind: "credit_memo",
          status: "paid",
          creditOfId: record.id,
          billToName: record.billToName,
          billToMc: record.billToMc,
          billToEmail: record.billToEmail,
          billToPhone: record.billToPhone,
          issuedAt: now,
          termsDays: 0,
          total: dec(amount).negated(),
          paidTotal: dec(amount).negated(),
          paidAt: now,
          lines: { create: [{ loadId, kind: "credit", label, amount: dec(amount).negated(), sort: 1 }] }
        },
        select: { id: true }
      });
      await emitInvoice(tx, workspaceId, memo.id, "created", now);
      await tx.loadPayment.create({ data: { workspaceId, loadId, amount: dec(amount), paidAt: now, method: "credit" } });
      await addInvoicePayment(tx, { workspaceId, invoiceId: record.id, amount, paidAt: now, method: "credit", source: "credit", externalId: memo.id, note: why });
      // Never with a factor here (refused above), so closing it releases no factor reserve.
      if (closes) await closeInvoiceRecord(tx, record.id, { paidAt: now, writeOff: null, factoringPaid: false, now });
      await recordAudit(
        {
          entity: "invoice",
          action: "credit_memo_issued",
          loadId,
          loadNumber: load.loadNumber,
          summary: `${number}: $${amount.toFixed(2)} credited on ${record.number}${closes ? ", which closes it" : `; $${dec(billed).minus(after).toNumber().toFixed(2)} still owed`}`,
          reason: why,
          before: { Owed: `$${owing.toNumber().toFixed(2)}` },
          after: { "Credit memo": number, Credited: `$${amount.toFixed(2)}`, Owed: `$${dec(billed).minus(after).toNumber().toFixed(2)}` },
          at: now,
          workspaceId
        },
        tx
      );
      return { ok: true, number, closed: closes };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Another credit was just made on this invoice. Reload and try again." };
    throw e;
  }
}

/** Take a credit memo back: the memo is void (its number stays used), its amount comes off what the invoice counts as received, and a closed invoice opens again. */
export async function voidCreditMemo(memoId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<CreditOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the credit is taken back." };
  const memo = await prisma.invoice.findFirst({ where: { id: memoId, workspaceId, kind: "credit_memo" }, include: { lines: true } });
  if (!memo || !memo.creditOfId || !(await invoiceInScope(memo.creditOfId, workspaceId, scope))) return { ok: false, error: "That credit memo does not exist." };
  if (memo.status === "void") return { ok: false, error: "That credit memo is already void." };
  const amount = memo.total.negated().toNumber();
  const loadId = memo.lines[0]?.loadId ?? null;
  const originalId = memo.creditOfId;
  return prisma.$transaction(async (tx) => {
    const v = await tx.invoice.updateMany({ where: { id: memoId, status: { not: "void" } }, data: { status: "void", voidedAt: now, voidReason: why } });
    if (v.count !== 1) return { ok: false, error: "That credit memo was just changed. Reload." };
    await emitInvoice(tx, workspaceId, memoId, "voided", now);
    // The credit's payment on the original invoice goes with it: each one is told as reversed, as it was, before it is removed.
    const creditPays = await tx.invoicePayment.findMany({ where: { invoiceId: originalId, source: "credit", externalId: memoId } });
    await tx.invoicePayment.deleteMany({ where: { invoiceId: originalId, source: "credit", externalId: memoId } });
    for (const cp of creditPays) await emitPayment(tx, workspaceId, cp, "reversed", now);
    const sum = await tx.invoicePayment.aggregate({ where: { invoiceId: originalId }, _sum: { amount: true } });
    const paid = sum._sum.amount ?? new Prisma.Decimal(0);
    await tx.invoice.update({ where: { id: originalId }, data: { paidTotal: paid, status: "open", paidAt: null, writeOffAmount: null, writeOffReason: null, writeOffCode: null } });
    const original = await tx.invoice.findUnique({ where: { id: originalId }, select: { loads: { select: { loadId: true } } } });
    if (original && original.loads.length > 1) {
      // A credit on an invoice of several loads: every load shows its share again (rule A).
      await reproject(tx, originalId, () => ({ paidMethod: null }));
      await recordAudit({ entity: "invoice", action: "credit_memo_voided", loadId: original.loads[0]?.loadId ?? null, loadNumber: null, summary: `${memo.number} for $${amount.toFixed(2)} taken back`, reason: why, before: { "Credit memo": memo.number }, after: { "Credit memo": "Void" }, at: now, workspaceId }, tx);
      return { ok: true, number: memo.number };
    }
    if (loadId) {
      const lp = await tx.loadPayment.findFirst({ where: { loadId, workspaceId, method: "credit", amount: dec(amount) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (lp) await tx.loadPayment.delete({ where: { id: lp.id } });
      await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", paidAt: null, paidAmount: paid.gt(0) ? paid : null, writeOffAmount: null, writeOffReason: null } });
    }
    await recordAudit({ entity: "invoice", action: "credit_memo_voided", loadId, loadNumber: null, summary: `${memo.number} for $${amount.toFixed(2)} taken back`, reason: why, before: { "Credit memo": memo.number }, after: { "Credit memo": "Void" }, at: now, workspaceId }, tx);
    return { ok: true, number: memo.number };
  });
}

/** The invoice as billed, for printing: its lines, who it is for, and the load it came from. Accepts either a load id or a supplemental invoice record id. */
export async function getInvoice(loadId: string, workspaceId = currentWorkspaceId(), terminal: Terminals = null) {
  const scope = await allowedFor(workspaceId, terminal);
  const [l, lastChase] = await Promise.all([
    prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: { not: null }, ...inTerminal(scope) }, include: { stops: { orderBy: { stopSequence: "asc" } }, workspace: true, payments: { orderBy: [{ paidAt: "asc" }, { id: "asc" }] } } }),
    prisma.auditEvent.findFirst({ where: { workspaceId, loadId, action: "invoice_chased" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, actor: true } })
  ]);
  if (!l || !l.invoicedAt) return getSupplementalInvoiceView(loadId, workspaceId, scope);
  // The invoice as its own record, when the load has one (rule I): its lines, loads, payments and credits. An imported invoice with no record keeps reading the load (gap 16).
  const rec = await prisma.invoice.findFirst({
    where: { workspaceId, kind: "invoice", supplementOfId: null, status: { not: "void" }, loads: { some: { loadId } } },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    include: { lines: { orderBy: { sort: "asc" } }, loads: true, payments: { orderBy: [{ paidAt: "asc" }, { id: "asc" }] } }
  });
  const recordView = rec ? await recordViewOf(rec, workspaceId) : null;
  const lines = Array.isArray(l.invoiceLines) ? (l.invoiceLines as Array<{ label: string; amount: number }>) : null;
  const total = billedOf({ invoicedAmount: numOrNull(l.invoicedAmount), status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: numOrNull(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
  const terms = l.payTermsDays ?? 0;
  const fromLoad = {
    id: l.id,
    issuer: l.workspace.name,
    company: toCompany(l.workspace),
    invoiceNumber: l.invoiceNumber,
    sent: l.invoicedAt,
    due: dueAt(l.invoicedAt, terms) ?? l.invoicedAt,
    terms,
    billTo: { name: l.brokerName, mc: l.brokerMcNumber, email: l.brokerEmail, phone: l.brokerPhone },
    load: { number: l.loadNumber, po: l.poNumber, origin: l.originAddress, destination: l.destinationAddress, miles: num(l.loadedMiles), delivered: l.completedAt, podNote: l.podNote, closedWithoutPod: l.closedWithoutPod },
    stops: l.stops.map((s) => ({ sequence: s.stopSequence, role: s.stopRole ?? s.stopType, name: s.facilityName, address: s.addressString, arrived: s.arrivedAt, refs: Array.isArray(s.referenceNumbers) ? (s.referenceNumbers as unknown[]).map(String) : [] })),
    // An invoice sent before lines were kept shows its total as one line.
    lines: lines ?? [{ label: "Line haul and fuel surcharge", amount: total }],
    total,
    status: l.paymentStatus as "invoiced" | "paid" | "void",
    voidReason: null as string | null,
    paidAt: l.paidAt,
    paidAmount: numOrNull(l.paidAmount),
    writeOffAmount: numOrNull(l.writeOffAmount),
    writeOffReason: l.writeOffReason,
    /** What is still owed on an invoice that is out (the total less what has come in so far); 0 when it is paid. */
    balance: l.paymentStatus === "paid" ? 0 : dec(total).minus(dec(numOrNull(l.paidAmount) ?? 0)).toNumber(),
    payments: l.payments.map((p) => ({ amount: p.amount.toNumber(), paidAt: p.paidAt, method: p.method, reference: null as string | null, payer: null as string | null, source: "legacy" as string, note: null as string | null })),
    paidMethod: l.paidMethod,
    poNumber: l.poNumber,
    lastChasedAt: lastChase?.createdAt ?? null,
    lastChasedBy: lastChase?.actor ?? null,
    recordId: null as string | null,
    shared: false,
    credits: [] as CreditView[],
    supplementOf: null as { id: string; number: string; loadId: string | null } | null,
    supplementals: [] as SupplementalSummary[],
    loads: [{ id: l.id, number: l.loadNumber, po: l.poNumber, origin: l.originAddress, destination: l.destinationAddress, miles: num(l.loadedMiles), delivered: l.completedAt, stops: l.stops.map((s) => ({ sequence: s.stopSequence, role: s.stopRole ?? s.stopType, name: s.facilityName, address: s.addressString, arrived: s.arrivedAt, refs: Array.isArray(s.referenceNumbers) ? (s.referenceNumbers as unknown[]).map(String) : [] })) }] as InvoiceLoadView[]
  };
  if (!recordView) return fromLoad;
  return { ...fromLoad, ...recordView.over, loads: recordView.loads.length > 0 ? recordView.loads : fromLoad.loads };
}

export type CreditView = { id: string; number: string; amount: number; label: string; reason: string | null; issuedAt: Date; status: "paid" | "void"; voidReason: string | null };
export type InvoiceLoadView = { id: string; number: string | null; po: string | null; origin: string | null; destination: string | null; miles: number; delivered: Date | null; stops: Array<{ sequence: number; role: string; name: string | null; address: string; arrived: Date | null; refs: string[] }> };
export type SupplementalLineSummary = { id: string; kind: string; label: string; amount: number; loadId: string | null };
export type SupplementalSummary = {
  id: string;
  parentId: string;
  parentNumber: string;
  tag: string;
  number: string;
  status: "open" | "paid" | "void";
  total: number;
  paidTotal: number;
  balance: number;
  issuedAt: Date;
  dueAt: Date;
  termsDays: number;
  factoringStatus: string;
  voidReason: string | null;
  lines: SupplementalLineSummary[];
};

const tagOfSupplemental = (number: string, parentNumber: string) => (number.startsWith(`${parentNumber}-`) ? number.slice(parentNumber.length + 1) : number);

function toSupplementalSummary(
  s: { id: string; number: string; status: string; total: Prisma.Decimal; paidTotal: Prisma.Decimal; issuedAt: Date; termsDays: number; factoringStatus: string; voidReason: string | null; lines: Array<{ id: string; kind: string; label: string; amount: Prisma.Decimal; loadId: string | null }> },
  parentId: string,
  parentNumber: string
): SupplementalSummary {
  const status = (s.status === "void" ? "void" : s.status === "paid" ? "paid" : "open") as "open" | "paid" | "void";
  return {
    id: s.id,
    parentId,
    parentNumber,
    tag: tagOfSupplemental(s.number, parentNumber),
    number: s.number,
    status,
    total: s.total.toNumber(),
    paidTotal: s.paidTotal.toNumber(),
    balance: balanceOf({ total: s.total, paidTotal: s.paidTotal, status }),
    issuedAt: s.issuedAt,
    dueAt: dueAt(s.issuedAt, s.termsDays) ?? s.issuedAt,
    termsDays: s.termsDays,
    factoringStatus: s.factoringStatus,
    voidReason: s.voidReason,
    lines: s.lines.map((l) => ({ id: l.id, kind: l.kind, label: l.label, amount: l.amount.toNumber(), loadId: l.loadId }))
  };
}

/** View for `/invoices/[id]` when `id` is a supplemental invoice record id rather than a load id. */
async function getSupplementalInvoiceView(invoiceId: string, workspaceId: string, scope: Terminals) {
  const supp = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, kind: "invoice", supplementOfId: { not: null } },
    include: {
      lines: { orderBy: { sort: "asc" } },
      payments: { orderBy: [{ paidAt: "asc" }, { id: "asc" }] },
      supplementOf: { select: { id: true, number: true, loads: { select: { loadId: true } }, lines: { orderBy: { sort: "asc" }, select: { loadId: true } } } }
    }
  });
  if (!supp || !supp.supplementOf) return null;
  if (!(await invoiceInScope(supp.id, workspaceId, scope))) return null;
  const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) return null;
  const order: string[] = [];
  for (const x of supp.lines) if (x.loadId && !order.includes(x.loadId)) order.push(x.loadId);
  for (const x of supp.supplementOf.lines) if (x.loadId && !order.includes(x.loadId)) order.push(x.loadId);
  for (const x of supp.supplementOf.loads) if (!order.includes(x.loadId)) order.push(x.loadId);
  const [loadRows, memos] = await Promise.all([
    order.length > 0 ? prisma.load.findMany({ where: { id: { in: order }, workspaceId }, include: { stops: { orderBy: { stopSequence: "asc" } } } }) : Promise.resolve([]),
    prisma.invoice.findMany({ where: { workspaceId, kind: "credit_memo", creditOfId: supp.id }, include: { lines: true }, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] })
  ]);
  const byId = new Map(loadRows.map((x) => [x.id, x]));
  const loads: InvoiceLoadView[] = order
    .map((id) => byId.get(id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({
      id: x.id,
      number: x.loadNumber,
      po: x.poNumber,
      origin: x.originAddress,
      destination: x.destinationAddress,
      miles: num(x.loadedMiles),
      delivered: x.completedAt,
      stops: x.stops.map((st) => ({ sequence: st.stopSequence, role: st.stopRole ?? st.stopType, name: st.facilityName, address: st.addressString, arrived: st.arrivedAt, refs: Array.isArray(st.referenceNumbers) ? (st.referenceNumbers as unknown[]).map(String) : [] }))
    }));
  const first = loadRows[0] ?? null;
  const status = supp.status as "open" | "paid" | "void";
  const paidTotal = supp.paidTotal.toNumber();
  const total = supp.total.toNumber();
  const paidMethod = [...supp.payments].reverse().find((p) => p.method)?.method ?? null;
  return {
    id: supp.id,
    issuer: ws.name,
    company: toCompany(ws),
    invoiceNumber: supp.number,
    sent: supp.issuedAt,
    due: dueAt(supp.issuedAt, supp.termsDays) ?? supp.issuedAt,
    terms: supp.termsDays,
    billTo: { name: supp.billToName, mc: supp.billToMc, email: supp.billToEmail, phone: supp.billToPhone },
    load: {
      number: first?.loadNumber ?? null,
      po: first?.poNumber ?? null,
      origin: first?.originAddress ?? null,
      destination: first?.destinationAddress ?? null,
      miles: first ? num(first.loadedMiles) : 0,
      delivered: first?.completedAt ?? null,
      podNote: first?.podNote ?? null,
      closedWithoutPod: first?.closedWithoutPod ?? null
    },
    stops: loads[0]?.stops ?? [],
    lines: supp.lines.map((x) => ({ label: x.label, amount: x.amount.toNumber() })),
    total,
    status: (status === "void" ? "void" : status === "paid" ? "paid" : "invoiced") as "invoiced" | "paid" | "void",
    voidReason: supp.voidReason,
    paidAt: supp.paidAt,
    paidAmount: paidTotal > 0 ? paidTotal : null,
    writeOffAmount: supp.writeOffAmount ? supp.writeOffAmount.toNumber() : null,
    writeOffReason: supp.writeOffReason,
    balance: balanceOf({ total: supp.total, paidTotal: supp.paidTotal, status }),
    payments: supp.payments.map((p) => ({ amount: p.amount.toNumber(), paidAt: p.paidAt, method: p.method, reference: p.reference, payer: p.payer, source: p.source as string, note: p.note })),
    paidMethod,
    poNumber: first?.poNumber ?? null,
    lastChasedAt: null as Date | null,
    lastChasedBy: null as string | null,
    recordId: supp.id,
    shared: loads.length > 1,
    credits: memos.map((m) => ({
      id: m.id,
      number: m.number,
      amount: m.total.negated().toNumber(),
      label: m.lines[0]?.label ?? "Credit",
      reason: supp.payments.find((p) => p.source === "credit" && p.externalId === m.id)?.note ?? null,
      issuedAt: m.issuedAt,
      status: (m.status === "void" ? "void" : "paid") as "void" | "paid",
      voidReason: m.voidReason
    })),
    supplementOf: { id: supp.supplementOf.id, number: supp.supplementOf.number, loadId: order[0] ?? null },
    supplementals: [] as SupplementalSummary[],
    loads
  };
}

/** What the sheet takes from the invoice record instead of from one load: the number, the money, every load and line on it, the payments with their references, and the credit memos. */
async function recordViewOf(
  rec: Prisma.InvoiceGetPayload<{ include: { lines: true; loads: true; payments: true } }>,
  workspaceId: string
) {
  const order: string[] = [];
  for (const x of rec.lines) if (x.loadId && !order.includes(x.loadId)) order.push(x.loadId);
  for (const x of rec.loads) if (!order.includes(x.loadId)) order.push(x.loadId);
  const [loadRows, memos, supps] = await Promise.all([
    prisma.load.findMany({ where: { id: { in: order }, workspaceId }, include: { stops: { orderBy: { stopSequence: "asc" } } } }),
    prisma.invoice.findMany({ where: { workspaceId, kind: "credit_memo", creditOfId: rec.id }, include: { lines: true }, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] }),
    prisma.invoice.findMany({ where: { workspaceId, kind: "invoice", supplementOfId: rec.id }, include: { lines: { orderBy: { sort: "asc" } } }, orderBy: [{ issuedAt: "asc" }, { id: "asc" }] })
  ]);
  const byId = new Map(loadRows.map((x) => [x.id, x]));
  const shared = rec.loads.length > 1;
  const loads: InvoiceLoadView[] = order
    .map((id) => byId.get(id))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .map((x) => ({
      id: x.id,
      number: x.loadNumber,
      po: x.poNumber,
      origin: x.originAddress,
      destination: x.destinationAddress,
      miles: num(x.loadedMiles),
      delivered: x.completedAt,
      stops: x.stops.map((st) => ({ sequence: st.stopSequence, role: st.stopRole ?? st.stopType, name: st.facilityName, address: st.addressString, arrived: st.arrivedAt, refs: Array.isArray(st.referenceNumbers) ? (st.referenceNumbers as unknown[]).map(String) : [] }))
    }));
  const numberOf = new Map(loads.map((x) => [x.id, x.number]));
  const total = rec.total.toNumber();
  const status = rec.status as "open" | "paid" | "void";
  const paidTotal = rec.paidTotal.toNumber();
  const credits: CreditView[] = memos.map((m) => ({
    id: m.id,
    number: m.number,
    amount: m.total.negated().toNumber(),
    label: m.lines[0]?.label ?? "Credit",
    reason: rec.payments.find((p) => p.source === "credit" && p.externalId === m.id)?.note ?? null,
    issuedAt: m.issuedAt,
    status: m.status === "void" ? "void" : "paid",
    voidReason: m.voidReason
  }));
  return {
    loads,
    over: {
      invoiceNumber: rec.number,
      sent: rec.issuedAt,
      due: dueAt(rec.issuedAt, rec.termsDays) ?? rec.issuedAt,
      terms: rec.termsDays,
      // Several loads: each line says which load it is for. One load: the lines read as they were billed.
      lines: rec.lines.map((x) => ({ label: shared && x.loadId ? `${numberOf.get(x.loadId) ?? "Load"} · ${x.label}` : x.label, amount: x.amount.toNumber() })),
      total,
      status: (status === "paid" ? "paid" : "invoiced") as "paid" | "invoiced" | "void",
      voidReason: rec.voidReason,
      paidAt: rec.paidAt,
      paidAmount: paidTotal > 0 ? paidTotal : null,
      writeOffAmount: rec.writeOffAmount ? rec.writeOffAmount.toNumber() : null,
      writeOffReason: rec.writeOffReason,
      balance: balanceOf({ total: rec.total, paidTotal: rec.paidTotal, status }),
      payments: rec.payments.map((p) => ({ amount: p.amount.toNumber(), paidAt: p.paidAt, method: p.method, reference: p.reference, payer: p.payer, source: p.source as string, note: p.note })),
      recordId: rec.id,
      shared,
      credits,
      supplementOf: null as { id: string; number: string; loadId: string | null } | null,
      supplementals: supps.map((s) => toSupplementalSummary(s, rec.id, rec.number))
    }
  };
}

// ── Invoices of several loads (docs/MONEY_PLAN.md, rule G) ──────────────────────────────────────────────

/** The record of the invoice this load shares with other loads, or null when its invoice is its own (or it has none). */
async function sharedInvoiceOf(loadId: string, workspaceId: string): Promise<string | null> {
  const r = await prisma.invoice.findFirst({ where: { workspaceId, kind: "invoice", supplementOfId: null, status: { not: "void" }, loads: { some: { loadId } } }, select: { id: true, _count: { select: { loads: true } } }, orderBy: [{ issuedAt: "desc" }, { id: "desc" }] });
  return r && r._count.loads > 1 ? r.id : null;
}

export { MAX_LOADS_PER_INVOICE };

export type MultiInvoiceOut = { ok: boolean; error?: string; errors?: Record<string, string>; number?: string; total?: number };

/**
 * One invoice for several delivered loads of the same customer (rule G). Each load keeps its own lines (its rate, its fuel surcharge), so its projected amount is its own
 * share (rule A); the invoice number is shared. Every load must be ready to invoice on its own, and none may be invoiced already: all are claimed in one transaction or none.
 */
export async function invoiceLoads(loadIds: string[], form: { number?: string; terms?: string }, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<MultiInvoiceOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const ids = [...new Set(loadIds)];
  if (ids.length < 2) return { ok: false, error: "Pick at least two loads to put on one invoice." };
  if (ids.length > MAX_LOADS_PER_INVOICE) return { ok: false, error: `One invoice can carry up to ${MAX_LOADS_PER_INVOICE} loads.` };
  const loads = await prisma.load.findMany({ where: { id: { in: ids }, workspaceId, deletedAt: null, ...inTerminal(scope) } });
  if (loads.length !== ids.length) return { ok: false, error: "One of those loads does not exist any more. Reload the page." };
  const order = new Map(ids.map((id, n) => [id, n]));
  loads.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const key = customerKey(loads[0]!);
  if (loads.some((l) => customerKey(l) !== key)) return { ok: false, error: "Every load on one invoice has to bill the same customer (the same name and MC)." };
  const podMissing = await podStopsMissing(ids, workspaceId);
  for (const l of loads) {
    if (l.paymentStatus) return { ok: false, error: `${l.loadNumber ?? "A load"} is already invoiced.` };
    if (!canInvoiceStatus(l.status, numOrNull(l.tonuRevenue))) return { ok: false, error: `${l.loadNumber ?? "A load"} is not delivered (or is a TONU with no fee).` };
    const basis = invoiceBasis({ status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: num(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
    const ready = invoiceReadiness({ ...l, quotedRevenue: basis.rate, paidLinehaul: numOrNull(l.actualRevenue), podStopsMissing: podMissing.get(l.id) ?? null });
    if (ready.blockers.length > 0) return { ok: false, error: `${l.loadNumber ?? "A load"}: ${ready.blockers[0]}` };
  }
  const thresholds = await getThresholds(workspaceId);
  const termsRaw = (form.terms ?? "").trim();
  const defaultTerms = loads[0]!.payTermsDays ?? (await customerTermsMap(workspaceId)).get((loads[0]!.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays;
  const terms = termsRaw === "" ? defaultTerms : /^\d{1,3}$/.test(termsRaw) ? Number.parseInt(termsRaw, 10) : -1;
  if (!Number.isInteger(terms) || terms < 0 || terms > 120) return { ok: false, errors: { terms: "Whole days, 0 to 120." } };
  const number = ((form.number ?? "").trim() || (await suggestedInvoiceNumber(loads[0]!, workspaceId))).slice(0, 40);
  if (number.length < 3) return { ok: false, errors: { number: "Give the invoice a number." } };

  const linesOf = (l: (typeof loads)[number]) => {
    const basis = invoiceBasis({ status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: num(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
    const out = [{ loadId: l.id, label: basis.label, amount: dec(basis.rate).toNumber() }];
    if (basis.surcharge > 0) out.push({ loadId: l.id, label: "Fuel surcharge", amount: dec(basis.surcharge).toNumber() });
    return out;
  };
  const perLoad = loads.map((l) => ({ load: l, lines: linesOf(l) }));
  const total = perLoad.reduce((s, p) => s.plus(p.lines.reduce((t, x) => t.plus(dec(x.amount)), new Prisma.Decimal(0))), new Prisma.Decimal(0));
  try {
    await prisma.$transaction(async (tx) => {
      const takenRecord = await tx.invoice.findFirst({ where: { workspaceId, number }, select: { id: true } });
      const takenLoad = await tx.load.findFirst({ where: { workspaceId, invoiceNumber: number, deletedAt: null, id: { notIn: ids } }, select: { loadNumber: true } });
      if (takenRecord || takenLoad) throw new NumberTaken(takenLoad?.loadNumber ?? null);
      for (const p of perLoad) {
        const amount = p.lines.reduce((t, x) => t.plus(dec(x.amount)), new Prisma.Decimal(0));
        const claimed = await tx.load.updateMany({
          where: { id: p.load.id, workspaceId, deletedAt: null, status: { in: ["completed", "tonu"] }, paymentStatus: null },
          data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: amount, invoiceNumber: number, payTermsDays: terms, invoiceLines: p.lines.map(({ label, amount: a }) => ({ label, amount: a })) }
        });
        if (claimed.count !== 1) throw new AlreadyInvoiced();
        await recordAudit(
          {
            entity: "invoice",
            action: "invoiced",
            loadId: p.load.id,
            loadNumber: p.load.loadNumber,
            summary: `${number} created for $${total.toNumber().toFixed(2)} across ${loads.length} loads; this load's share $${amount.toNumber().toFixed(2)}`,
            before: { Invoice: null, Amount: null, "Terms before": p.load.payTermsDays == null ? null : String(p.load.payTermsDays) },
            after: { Invoice: number, Amount: `$${amount.toNumber().toFixed(2)}`, "Invoice total": `$${total.toNumber().toFixed(2)}`, Loads: String(loads.length), Terms: termsLabel(terms) },
            at: now,
            workspaceId
          },
          tx
        );
      }
      const first = loads[0]!;
      await createInvoiceRecord(tx, {
        workspaceId,
        number,
        issuedAt: now,
        termsDays: terms,
        billTo: { name: first.brokerName, mc: first.brokerMcNumber, email: first.brokerEmail, phone: first.brokerPhone },
        lines: perLoad.flatMap((p) => p.lines),
        loadIds: ids
      });
    });
  } catch (e) {
    if (e instanceof AlreadyInvoiced) return { ok: false, error: "One of those loads was just invoiced. Reload the page." };
    if (e instanceof NumberTaken || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) return { ok: false, errors: { number: `${number} is already used. Use another number.` } };
    throw e;
  }
  return { ok: true, number, total: total.toNumber() };
}

/** Write what every load on an invoice must show (rule A) after its money changed. */
async function reproject(tx: Prisma.TransactionClient, invoiceId: string, extra: (loadId: string) => Prisma.LoadUpdateManyMutationInput = () => ({})) {
  for (const p of await projectionOf(tx, invoiceId)) {
    await tx.load.update({ where: { id: p.loadId }, data: { invoiceNumber: p.invoiceNumber, invoicedAmount: p.invoicedAmount, invoicedAt: p.invoicedAt, paidAmount: p.paidAmount, paidAt: p.paidAt, paymentStatus: p.paymentStatus, ...extra(p.loadId) } });
  }
}

/** A payment against an invoice of several loads, or a supplemental invoice: it is the invoice that is paid, and for primary invoices what came in is shared across its loads (rule A). */
export async function payInvoiceRecord(
  invoiceId: string,
  now: Date,
  opts: { amount?: number; paidOn?: string; method?: string; shortAction?: ShortAction; shortReason?: string; shortCode?: string; reference?: string; payer?: string; source?: "desk" | "factor" | "accounting"; externalId?: string },
  workspaceId = currentWorkspaceId(),
  allowed?: Terminals
): Promise<PaidOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const rec = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, kind: "invoice" },
    include: {
      loads: true,
      lines: { select: { loadId: true }, orderBy: { sort: "asc" } },
      supplementOf: { select: { loads: { select: { loadId: true } } } }
    }
  });
  if (!rec || !(await invoiceInScope(rec.id, workspaceId, scope))) return { ok: false, error: "That invoice does not exist." };
  if (rec.status !== "open") return { ok: false, error: rec.status === "paid" ? `${rec.number} is already paid. Reload the page.` : `${rec.number} was taken back.` };
  const owing = dec(rec.total.toNumber()).minus(dec(rec.paidTotal.toNumber())).toNumber();
  const amount = opts.amount ?? owing;
  if (!Number.isFinite(amount) || !(amount > 0) || amount > 10_000_000) return { ok: false, error: "Type the amount that came in, above zero." };
  if (dec(amount).toNumber() !== amount) return { ok: false, error: "Dollars and cents, like 1,250.50." };
  const method = (opts.method ?? "").trim();
  if (method !== "" && !isPaidMethod(method)) return { ok: false, error: "Pick how it was paid from the list." };
  const tz = await workspaceTimezone(workspaceId);
  const today = dayOf(now, tz);
  const paidOn = (opts.paidOn ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || parseCentralLocal(`${paidOn}T12:00`, tz) == null) return { ok: false, error: "Type the day it was paid, like 2026-10-29." };
  if (paidOn > today) return { ok: false, error: "A payment cannot come in on a day that has not happened." };
  if (paidOn < dayOf(rec.issuedAt, tz)) return { ok: false, error: `The invoice went out on ${dayOf(rec.issuedAt, tz)}, so it cannot be paid before that.` };
  const paidAt = paidOn === today ? now : new Date(parseCentralLocal(`${paidOn}T12:00`, tz)!);
  const after = dec(rec.paidTotal.toNumber()).plus(dec(amount));
  const diff = after.minus(dec(rec.total.toNumber())).toNumber();
  const short = diff < 0;
  const shortBy = dec(diff).abs().toNumber();
  const writeoff = short && opts.shortAction === "writeoff";
  const shortWhy = (opts.shortReason ?? "").trim();
  if (writeoff && shortWhy.length < 3) return { ok: false, needsShortReason: true, error: `Closing the invoice $${shortBy.toFixed(2)} short writes the $${shortBy.toFixed(2)} off, so say why.` };
  const partial = short && !writeoff;
  const firstLoad = rec.loads[0]?.loadId ?? rec.lines.find((l) => l.loadId != null)?.loadId ?? rec.supplementOf?.loads[0]?.loadId ?? null;
  const touchIds = [...new Set([...rec.loads.map((x) => x.loadId), ...rec.lines.map((x) => x.loadId).filter((x): x is string => !!x), ...(rec.supplementOf?.loads.map((x) => x.loadId) ?? [])])];
  const scopeNote = rec.loads.length > 1 ? ` across ${rec.loads.length} loads` : rec.supplementOfId ? " (supplemental)" : "";
  const done = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, status: "open", paidTotal: rec.paidTotal }, data: { updatedAt: now } });
    if (claimed.count !== 1) return false;
    await addInvoicePayment(tx, { workspaceId, invoiceId, amount, paidAt, method: method || null, reference: opts.reference, payer: opts.payer, source: opts.source ?? "desk", externalId: opts.externalId });
    if (!partial) await closeInvoiceRecord(tx, invoiceId, { paidAt, writeOff: writeoff ? { amount: shortBy, reason: shortWhy, code: isShortCode(opts.shortCode) ? opts.shortCode : null } : null, factoringPaid: FACTORED_OPEN.includes(rec.factoringStatus), now });
    if (rec.supplementOfId == null && rec.loads.length > 0) {
      await reproject(tx, invoiceId, () => ({ paidMethod: method || null }));
    } else if (touchIds.length > 0) {
      await bumpLoads(tx, touchIds, now);
    }
    await recordAudit(
      {
        entity: "invoice",
        action: partial ? "payment_part" : "paid",
        loadId: firstLoad,
        loadNumber: null,
        summary: partial
          ? `${rec.number}: $${amount.toFixed(2)} received${scopeNote}; $${shortBy.toFixed(2)} still owed`
          : `${rec.number} paid, $${after.toNumber().toFixed(2)}${scopeNote}${short ? `, $${shortBy.toFixed(2)} short, written off` : diff > 0 ? `, $${diff.toFixed(2)} over` : ""}`,
        reason: short && writeoff ? shortWhy : null,
        before: { Status: rec.paidTotal.gt(0) ? "Invoiced, part paid" : "Invoiced", Billed: `$${rec.total.toNumber().toFixed(2)}` },
        after: { Status: partial ? "Invoiced, part paid" : "Paid", Received: `$${after.toNumber().toFixed(2)}`, ...(opts.reference ? { Reference: opts.reference } : {}) },
        at: now,
        workspaceId
      },
      tx
    );
    return true;
  });
  if (!done) return { ok: false, error: "That invoice changed while you were looking at it. Reload and try again." };
  if (partial) return { ok: true, balance: shortBy };
  return diff === 0 ? { ok: true } : { ok: true, difference: diff };
}

/** Take back an invoice of several loads: all of its loads are ready to invoice again. Refused once money has come in, or once it has gone to a factor. */
async function voidSharedInvoice(invoiceId: string, why: string, now: Date, workspaceId: string): Promise<PaidOut> {
  const rec = await prisma.invoice.findFirst({ where: { id: invoiceId, workspaceId }, include: { loads: true } });
  if (!rec || rec.status === "void") return { ok: false, error: "That invoice was already taken back." };
  if (rec.status === "paid" || rec.paidTotal.gt(0)) return { ok: false, error: "Money has been recorded on this invoice. Take it back first." };
  if (rec.factoringStatus !== "none" && rec.factoringStatus !== "rejected") return { ok: false, error: "This invoice has gone to a factoring company. It cannot be taken back here." };
  const ok = await prisma.$transaction(async (tx) => {
    const v = await tx.invoice.updateMany({ where: { id: invoiceId, status: "open", paidTotal: 0 }, data: { status: "void", voidedAt: now, voidReason: why } });
    if (v.count !== 1) return false;
    await emitInvoice(tx, workspaceId, invoiceId, "voided", now);
    for (const l of rec.loads) {
      const load = await tx.load.findUnique({ where: { id: l.loadId }, select: { loadNumber: true, invoicedAmount: true } });
      await tx.load.update({ where: { id: l.loadId }, data: { paymentStatus: null, invoicedAt: null, invoicedAmount: null, invoiceNumber: null, invoiceLines: Prisma.JsonNull, paidAmount: null, paidAt: null } });
      await recordAudit({ entity: "invoice", action: "invoice_voided", loadId: l.loadId, loadNumber: load?.loadNumber ?? null, summary: `${rec.number} (${rec.loads.length} loads, $${rec.total.toNumber().toFixed(2)}) taken back`, reason: why, before: { Status: "Invoiced", Invoice: rec.number, Amount: load?.invoicedAmount ? `$${load.invoicedAmount.toNumber().toFixed(2)}` : null }, after: { Status: "Ready to invoice", Invoice: null, Amount: null }, at: now, workspaceId }, tx);
    }
    return true;
  });
  return ok ? { ok: true } : { ok: false, error: "That invoice changed while you were looking at it. Reload the page." };
}


/**
 * A credit memo on an invoice of several loads (rule F). The memo's line names no load, so it stays on the memo and never enters a load's gross (rule A); the credit lands on the
 * invoice as a payment row of its own source, and every load's projected amount received is worked out again from the record.
 */
async function creditSharedInvoice(invoiceId: string, input: { amount: number; label?: string }, why: string, now: Date, workspaceId: string): Promise<CreditOut> {
  const rec = await prisma.invoice.findFirst({ where: { id: invoiceId, workspaceId, kind: "invoice", status: "open" }, include: { loads: true } });
  if (!rec) return { ok: false, error: "That invoice is not open any more. Reload the page." };
  if (FACTORED_OPEN.includes(rec.factoringStatus)) return { ok: false, error: "This invoice is with a factoring company, so a credit changes what the factor collects and is settled with the factor, not here. Record what the factor reports instead." };
  const owing = dec(rec.total.toNumber()).minus(dec(rec.paidTotal.toNumber()));
  if (dec(input.amount).gt(owing)) return { ok: false, error: `Only $${owing.toNumber().toFixed(2)} is still owed, so the credit can be at most that.` };
  const closes = dec(input.amount).gte(owing);
  const label = (input.label ?? "").trim() || "Credit";
  const firstLoad = rec.loads[0]?.loadId ?? null;
  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, status: "open", paidTotal: rec.paidTotal }, data: { updatedAt: now } });
      if (claimed.count !== 1) return { ok: false, error: "That invoice changed while you were looking at it. Reload and try again." };
      const credits = await tx.invoice.count({ where: { workspaceId, creditOfId: rec.id } });
      const number = `${rec.number}-CR${credits + 1}`;
      const memo = await tx.invoice.create({
        data: {
          workspaceId,
          number,
          kind: "credit_memo",
          status: "paid",
          creditOfId: rec.id,
          billToName: rec.billToName,
          billToMc: rec.billToMc,
          billToEmail: rec.billToEmail,
          billToPhone: rec.billToPhone,
          issuedAt: now,
          termsDays: 0,
          total: dec(input.amount).negated(),
          paidTotal: dec(input.amount).negated(),
          paidAt: now,
          lines: { create: [{ loadId: null, kind: "credit", label, amount: dec(input.amount).negated(), sort: 1 }] }
        },
        select: { id: true }
      });
      await emitInvoice(tx, workspaceId, memo.id, "created", now);
      await addInvoicePayment(tx, { workspaceId, invoiceId, amount: input.amount, paidAt: now, method: "credit", source: "credit", externalId: memo.id, note: why });
      // Never with a factor here (refused above), so closing it releases no factor reserve.
      if (closes) await closeInvoiceRecord(tx, invoiceId, { paidAt: now, writeOff: null, factoringPaid: false, now });
      await reproject(tx, invoiceId, () => ({ paidMethod: "credit" }));
      const left = owing.minus(dec(input.amount)).toNumber();
      await recordAudit(
        {
          entity: "invoice",
          action: "credit_memo_issued",
          loadId: firstLoad,
          loadNumber: null,
          summary: `${number}: $${input.amount.toFixed(2)} credited on ${rec.number} (${rec.loads.length} loads)${closes ? ", which closes it" : `; $${left.toFixed(2)} still owed`}`,
          reason: why,
          before: { Owed: `$${owing.toNumber().toFixed(2)}` },
          after: { "Credit memo": number, Credited: `$${input.amount.toFixed(2)}`, Owed: `$${left.toFixed(2)}` },
          at: now,
          workspaceId
        },
        tx
      );
      return { ok: true, number, closed: closes };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Another credit was just made on this invoice. Reload and try again." };
    throw e;
  }
}

/** Take the newest payment back on an invoice of several loads: the invoice is open again with what the others add up to, and every load shows its share again. A credit is voided, not undone. */
async function undoSharedPayment(invoiceId: string, why: string, now: Date, workspaceId: string): Promise<PaidOut> {
  const rec = await prisma.invoice.findFirst({ where: { id: invoiceId, workspaceId, kind: "invoice", status: { not: "void" } }, include: { loads: true } });
  if (!rec) return { ok: false, error: "That invoice does not exist any more." };
  const last = await prisma.invoicePayment.findFirst({ where: { invoiceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last) return { ok: false, error: "No payment has been recorded on this invoice." };
  if (last.source === "credit") return { ok: false, error: "The last amount on this invoice is a credit memo. Void the credit memo instead." };
  const taken = last.amount.toNumber();
  const ok = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, status: rec.status, paidTotal: rec.paidTotal }, data: { updatedAt: now } });
    if (claimed.count !== 1) return false;
    await removeLastInvoicePayment(tx, invoiceId, { factoringBackToFunded: rec.factoringStatus === "paid", now });
    await reproject(tx, invoiceId, () => ({ paidMethod: null }));
    await recordAudit(
      {
        entity: "invoice",
        action: "payment_undone",
        loadId: rec.loads[0]?.loadId ?? null,
        loadNumber: null,
        summary: `${rec.number} payment of $${taken.toFixed(2)} taken back across ${rec.loads.length} loads`,
        reason: why,
        before: { Status: rec.status === "paid" ? "Paid" : "Invoiced, part paid", Amount: `$${rec.paidTotal.toNumber().toFixed(2)}` },
        after: { Status: "Invoiced" },
        at: now,
        workspaceId
      },
      tx
    );
    return true;
  });
  return ok ? { ok: true } : { ok: false, error: "That payment was already taken back, or the invoice changed. Reload the page." };
}

// ── Supplemental invoices (Phase 5) ───────────────────────────────────────────────────────────────

async function bumpLoads(tx: Prisma.TransactionClient, loadIds: string[], now: Date): Promise<void> {
  if (loadIds.length === 0) return;
  const rows = await tx.load.findMany({ where: { id: { in: loadIds } }, select: { id: true, updatedAt: true } });
  const wall = Date.now();
  const base = now.getTime() > wall ? now.getTime() : wall + 1;
  for (const row of rows) {
    const min = row.updatedAt.getTime() + 1;
    await tx.load.update({ where: { id: row.id }, data: { updatedAt: new Date(base >= min ? base : min) } });
  }
}

export type SupplementalOut = { ok: true; id: string; number: string; total: number } | { ok: false; error: string };

/**
 * Issue a supplemental invoice (`<parent>-S1`, `-S2`, ...) for new post-invoice charges such as detention approved late, layover, lumper, a rate correction, or other charges.
 * Keeps `InvoiceLoad` empty so primary invoice lookups never see it and `Load.paymentStatus` stays the parent invoice's state.
 */
export async function issueSupplemental(
  invoiceId: string,
  linesInput: readonly SupplementalLineInput[],
  opts: { termsDays?: number; reason?: string } = {},
  now = new Date(),
  workspaceId = currentWorkspaceId(),
  allowed?: Terminals
): Promise<SupplementalOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const checked = validateSupplementalLines(linesInput);
  if (!checked.ok) return { ok: false, error: checked.error };
  const parent = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, kind: "invoice", supplementOfId: null },
    include: { loads: { select: { loadId: true, load: { select: { id: true, loadNumber: true } } } }, lines: { orderBy: { sort: "asc" }, select: { loadId: true } } }
  });
  if (!parent || !(await invoiceInScope(parent.id, workspaceId, scope))) return { ok: false, error: "That invoice does not exist." };
  if (parent.status === "void") return { ok: false, error: "A void invoice cannot have a supplemental invoice." };
  const termsDays = opts.termsDays ?? parent.termsDays;
  if (!Number.isInteger(termsDays) || termsDays < 0 || termsDays > 120) return { ok: false, error: "Pay terms must be whole days, 0 to 120." };
  const why = (opts.reason ?? "").trim().slice(0, 200);
  const parentLoadIds = parent.loads.map((x) => x.loadId);
  const leadLoadId = parent.lines.find((x) => x.loadId != null)?.loadId ?? parentLoadIds[0] ?? null;
  const defaultLoadId = parentLoadIds.length === 1 ? parentLoadIds[0]! : leadLoadId;
  for (const l of checked.lines) {
    if (l.loadId != null && !parentLoadIds.includes(l.loadId)) return { ok: false, error: "Each line must belong to a load on the parent invoice." };
  }
  const totalDec = checked.lines.reduce((s, l) => s.plus(dec(l.amount)), new Prisma.Decimal(0));
  try {
    return await prisma.$transaction(async (tx) => {
      const existingSupps = await tx.invoice.findMany({ where: { workspaceId, supplementOfId: parent.id }, select: { number: true } });
      const usedRows = await tx.invoice.findMany({ where: { workspaceId, number: { startsWith: `${parent.number}-S` } }, select: { number: true } });
      const used = new Set(usedRows.map((r) => r.number));
      let n = existingSupps.length + 1;
      while (used.has(`${parent.number}-S${n}`)) n += 1;
      const number = `${parent.number}-S${n}`;
      const created = await tx.invoice.create({
        data: {
          workspaceId,
          number,
          kind: "invoice",
          status: "open",
          supplementOfId: parent.id,
          billToName: parent.billToName,
          billToMc: parent.billToMc,
          billToEmail: parent.billToEmail,
          billToPhone: parent.billToPhone,
          issuedAt: now,
          termsDays,
          total: totalDec,
          paidTotal: new Prisma.Decimal(0),
          lines: {
            create: checked.lines.map((l, idx) => ({
              loadId: l.loadId ?? defaultLoadId,
              kind: l.kind,
              label: l.label,
              amount: dec(l.amount),
              sort: idx + 1
            }))
          }
        },
        select: { id: true }
      });
      await emitInvoice(tx, workspaceId, created.id, "created", now);
      await bumpLoads(tx, parentLoadIds, now);
      await recordAudit(
        {
          entity: "invoice",
          action: "supplemental_issued",
          loadId: leadLoadId,
          loadNumber: parent.loads.find((x) => x.loadId === leadLoadId)?.load.loadNumber ?? null,
          summary: `${number}: $${totalDec.toNumber().toFixed(2)} supplemental to ${parent.number}`,
          reason: why || null,
          before: { Invoice: parent.number },
          after: { Supplemental: number, Amount: `$${totalDec.toNumber().toFixed(2)}` },
          at: now,
          workspaceId
        },
        tx
      );
      return { ok: true, id: created.id, number, total: totalDec.toNumber() };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, error: "Another supplemental invoice was just issued for this invoice. Reload and try again." };
    throw e;
  }
}

/** Take the newest payment back on a supplemental invoice so it is open again with whatever remains owed. */
export async function undoSupplementalPayment(invoiceId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<PaidOut> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the payment is being taken back." };
  const rec = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, kind: "invoice", supplementOfId: { not: null } },
    include: { lines: { select: { loadId: true } }, supplementOf: { select: { loads: { select: { loadId: true, load: { select: { loadNumber: true } } } } } } }
  });
  if (!rec || !(await invoiceInScope(rec.id, workspaceId, scope))) return { ok: false, error: "That supplemental invoice does not exist." };
  if (rec.status === "void") return { ok: false, error: "That supplemental invoice was voided." };
  const last = await prisma.invoicePayment.findFirst({ where: { invoiceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (!last) return { ok: false, error: "No payment has been recorded on this supplemental invoice." };
  if (last.source === "credit") return { ok: false, error: "The last amount on this invoice is a credit memo. Void the credit memo instead." };
  const taken = last.amount.toNumber();
  const touchIds = [...new Set([...rec.lines.map((x) => x.loadId).filter((x): x is string => !!x), ...(rec.supplementOf?.loads.map((x) => x.loadId) ?? [])])];
  const firstLoad = rec.supplementOf?.loads[0];
  const ok = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, status: rec.status, paidTotal: rec.paidTotal }, data: { updatedAt: now } });
    if (claimed.count !== 1) return false;
    await removeLastInvoicePayment(tx, invoiceId, { factoringBackToFunded: rec.factoringStatus === "paid", now });
    await bumpLoads(tx, touchIds, now);
    await recordAudit(
      {
        entity: "invoice",
        action: "payment_undone",
        loadId: firstLoad?.loadId ?? touchIds[0] ?? null,
        loadNumber: firstLoad?.load.loadNumber ?? null,
        summary: `${rec.number} payment of $${taken.toFixed(2)} taken back`,
        reason: why,
        before: { Status: rec.status === "paid" ? "Paid" : "Invoiced, part paid", Amount: `$${rec.paidTotal.toNumber().toFixed(2)}` },
        after: { Status: "Open" },
        at: now,
        workspaceId
      },
      tx
    );
    return true;
  });
  return ok ? { ok: true } : { ok: false, error: "That payment was already taken back, or the supplemental invoice changed. Reload the page." };
}

/** Void an open, unpaid supplemental invoice (its number stays used; detention, aging, cash and balance return to before it was issued). */
export async function voidSupplemental(invoiceId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId(), allowed?: Terminals): Promise<{ ok: boolean; error?: string; number?: string }> {
  const scope = await allowedFor(workspaceId, allowed);
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the supplemental invoice is being voided." };
  const rec = await prisma.invoice.findFirst({
    where: { id: invoiceId, workspaceId, kind: "invoice", supplementOfId: { not: null } },
    include: { lines: { select: { loadId: true } }, supplementOf: { select: { number: true, loads: { select: { loadId: true, load: { select: { loadNumber: true } } } } } } }
  });
  if (!rec || !(await invoiceInScope(rec.id, workspaceId, scope))) return { ok: false, error: "That supplemental invoice does not exist." };
  if (rec.status === "void") return { ok: false, error: "That supplemental invoice was already voided." };
  if (rec.status === "paid" || rec.paidTotal.gt(0)) return { ok: false, error: "Money has been recorded on this supplemental invoice. Take the payment back first." };
  if (rec.factoringStatus !== "none" && rec.factoringStatus !== "rejected") return { ok: false, error: "This invoice has gone to a factoring company. It cannot be voided here." };
  const touchIds = [...new Set([...rec.lines.map((x) => x.loadId).filter((x): x is string => !!x), ...(rec.supplementOf?.loads.map((x) => x.loadId) ?? [])])];
  const firstLoad = rec.supplementOf?.loads[0];
  const ok = await prisma.$transaction(async (tx) => {
    const claimed = await tx.invoice.updateMany({ where: { id: invoiceId, supplementOfId: { not: null }, status: "open", paidTotal: 0 }, data: { status: "void", voidedAt: now, voidReason: why } });
    if (claimed.count !== 1) return false;
    await emitInvoice(tx, workspaceId, invoiceId, "voided", now);
    await bumpLoads(tx, touchIds, now);
    await recordAudit(
      {
        entity: "invoice",
        action: "supplemental_voided",
        loadId: firstLoad?.loadId ?? touchIds[0] ?? null,
        loadNumber: firstLoad?.load.loadNumber ?? null,
        summary: `${rec.number} ($${rec.total.toNumber().toFixed(2)}) voided`,
        reason: why,
        before: { Supplemental: rec.number, Status: "Open", Amount: `$${rec.total.toNumber().toFixed(2)}` },
        after: { Supplemental: rec.number, Status: "Void" },
        at: now,
        workspaceId
      },
      tx
    );
    return true;
  });
  return ok ? { ok: true, number: rec.number } : { ok: false, error: "That supplemental invoice changed while you were looking at it. Reload the page." };
}

/** The active primary invoice record (never a supplemental) for one load, or null for uninvoiced / legacy imported invoices. */
export async function primaryInvoiceOfLoad(loadId: string, workspaceId = currentWorkspaceId()): Promise<{ id: string; number: string; factoringStatus: string } | null> {
  return prisma.invoice.findFirst({
    where: { workspaceId, kind: "invoice", supplementOfId: null, status: { not: "void" }, loads: { some: { loadId } } },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    select: { id: true, number: true, factoringStatus: true }
  });
}

async function fetchSupplementalsForLoads(loadIds: string[], workspaceId: string) {
  if (loadIds.length === 0) return [];
  return prisma.invoice.findMany({
    where: {
      workspaceId,
      kind: "invoice",
      supplementOfId: { not: null },
      OR: [{ lines: { some: { loadId: { in: loadIds } } } }, { supplementOf: { loads: { some: { loadId: { in: loadIds } } } } }]
    },
    include: {
      lines: { orderBy: { sort: "asc" } },
      supplementOf: { select: { id: true, number: true, loads: { select: { loadId: true } }, lines: { orderBy: { sort: "asc" }, select: { loadId: true } } } }
    },
    orderBy: [{ issuedAt: "asc" }, { id: "asc" }]
  });
}

function attributableLoads(s: Awaited<ReturnType<typeof fetchSupplementalsForLoads>>[number], allowedSet: Set<string>): string[] {
  const leadParentLoadId = s.supplementOf?.lines.find((l) => l.loadId != null)?.loadId ?? s.supplementOf?.loads[0]?.loadId ?? null;
  const targets = new Set<string>();
  for (const line of s.lines) {
    const id = line.loadId ?? leadParentLoadId;
    if (id && allowedSet.has(id)) targets.add(id);
  }
  if (s.lines.length === 0 && leadParentLoadId && allowedSet.has(leadParentLoadId)) targets.add(leadParentLoadId);
  return [...targets];
}

/** All supplemental invoices (including voided ones for drawer auditability) grouped by load id. */
export async function supplementalsByLoad(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, SupplementalSummary[]>> {
  const out = new Map<string, SupplementalSummary[]>();
  if (loadIds.length === 0) return out;
  const rows = await fetchSupplementalsForLoads(loadIds, workspaceId);
  const allowedSet = new Set(loadIds);
  for (const s of rows) {
    if (!s.supplementOf) continue;
    const summary = toSupplementalSummary(s, s.supplementOf.id, s.supplementOf.number);
    for (const lid of attributableLoads(s, allowedSet)) {
      const list = out.get(lid) ?? [];
      if (!list.some((x) => x.id === summary.id)) out.set(lid, [...list, summary]);
    }
  }
  return out;
}

/** Sum of unpaid balances across open supplemental invoices, grouped by load id. */
export async function openSupplementalBalanceByLoad(loadIds: string[], workspaceId = currentWorkspaceId()): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (loadIds.length === 0) return out;
  const byLoad = await supplementalsByLoad(loadIds, workspaceId);
  for (const [lid, list] of byLoad) {
    let sum = new Prisma.Decimal(0);
    for (const s of list) if (s.status === "open" && s.balance > 0) sum = sum.plus(new Prisma.Decimal(s.balance));
    if (sum.gt(0)) out.set(lid, sum.toDecimalPlaces(2).toNumber());
  }
  return out;
}

/** Sum of detention charges billed on non-void supplemental invoices, grouped by load id. */
export { supplementalDetentionByLoad };
