import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { billedOf } from "@/lib/billed";
import { termsLabel, canInvoiceStatus, defaultInvoiceNumber, invoiceBasis, invoiceReadiness, revisedInvoiceNumber, validateInvoice, type InvoiceForm } from "@/lib/invoicing";
import { isPaidMethod, paidMethodLabel } from "@/lib/pay-method";
import { parseCentralLocal, toCentralLocal } from "@/lib/zoned";
import { customerTermsMap } from "./customers";
import { recordAudit } from "./audit";
import { toCompany } from "./company";
import { num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { dueAt } from "@/lib/overdue";
import { podStopsMissing } from "./documents";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";

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
  const [voided, taken] = await Promise.all([voidedInvoiceNumbers([load.id], workspaceId), prisma.load.findMany({ where: { workspaceId, deletedAt: null, id: { not: load.id }, invoiceNumber: { startsWith: base } }, select: { invoiceNumber: true } })]);
  const used = new Set<string>([...(voided.get(load.id) ?? []), ...taken.map((t) => t.invoiceNumber!).filter(Boolean)]);
  return revisedInvoiceNumber(base, used);
}

/**
 * Record that a late invoice was chased (an email opened to the customer's accounts team, or a call made), so the next person sees when and by whom. The desk sends nothing itself; this is
 * only the memory of it. Audited as a muted event on the load.
 */
export async function recordChase(loadId: string, how: "email" | "phone", now = new Date(), workspaceId = currentWorkspaceId()): Promise<{ ok: boolean; error?: string }> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: "invoiced" }, select: { loadNumber: true, invoiceNumber: true, brokerName: true } });
  if (!load) return { ok: false, error: "That invoice is not out any more." };
  await recordAudit({ entity: "invoice", action: "invoice_chased", loadId, loadNumber: load.loadNumber, summary: `${load.invoiceNumber ?? "Invoice"} chased by ${how === "email" ? "email" : "phone"}${load.brokerName ? ` (${load.brokerName})` : ""}`, before: null, after: { Invoice: load.invoiceNumber, How: how === "email" ? "Email" : "Phone" }, at: now, workspaceId });
  return { ok: true };
}

export type InvoiceOut = { ok: boolean; detention: number; total?: number; error?: string; errors?: Record<string, string> };

export async function invoiceLoad(loadId: string, opts: { includeDetention?: boolean; form?: InvoiceForm } = {}, now = new Date(), workspaceId = currentWorkspaceId()): Promise<InvoiceOut> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
  if (!load) return { ok: false, detention: 0, error: "That load does not exist." };
  if (load.paymentStatus) return { ok: false, detention: 0, error: `${load.invoiceNumber ?? "This load"} is already invoiced. Reload the page.` };
  if (!canInvoiceStatus(load.status, numOrNull(load.tonuRevenue))) return { ok: false, detention: 0, error: "Only a delivered load, or a TONU with a fee, can be invoiced." };
  const basis = invoiceBasis({ status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: num(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const ready = invoiceReadiness({ ...load, quotedRevenue: basis.rate, paidLinehaul: numOrNull(load.actualRevenue), podStopsMissing: (await podStopsMissing([load.id], workspaceId)).get(load.id) ?? null });
  if (ready.blockers.length > 0) return { ok: false, detention: 0, error: ready.blockers[0] };

  const thresholds = await getThresholds();
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
      const claimed = await tx.load.updateMany({ where: { id: loadId, workspaceId, deletedAt: null, status: { in: ["completed", "tonu"] }, paymentStatus: null }, data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: total, invoiceNumber: number, payTermsDays: terms, invoiceLines: lines } });
      if (claimed.count !== 1) throw new AlreadyInvoiced();
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
const dayOf = (d: Date) => toCentralLocal(d.getTime()).slice(0, 10);
const dec = (n: number) => new Prisma.Decimal(n).toDecimalPlaces(2);

/**
 * Record a payment against an invoice. The amount defaults to what is still owed. Paying all of it (or more) closes the invoice. Paying LESS keeps the invoice out with the balance
 * still owed, and ageing, the KPI and the lists all count the balance, not the invoice; or, with `shortAction: "writeoff"` and a reason, closes it and writes the rest off (the reason
 * is kept in the audit entry). Each payment is a row of its own (what came in, on which day, how), and the load's paid amount is their sum.
 */
export async function markLoadPaid(
  loadId: string,
  now = new Date(),
  opts: { amount?: number; /** The day it came in, "2026-10-29" on the Dallas calendar; today when blank. */ paidOn?: string; method?: string; shortAction?: ShortAction; /** Why the rest is written off (needed with "writeoff"). */ shortReason?: string } = {},
  workspaceId = currentWorkspaceId()
): Promise<PaidOut> {
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null } });
  if (!load) return { ok: false, error: "That load does not exist." };
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
  const today = dayOf(now);
  const paidOn = (opts.paidOn ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || parseCentralLocal(`${paidOn}T12:00`) == null) return { ok: false, error: "Type the day it was paid, like 2026-10-29." };
  if (paidOn > today) return { ok: false, error: "A payment cannot come in on a day that has not happened." };
  if (load.invoicedAt && paidOn < dayOf(load.invoicedAt)) return { ok: false, error: `The invoice went out on ${dayOf(load.invoicedAt)}, so it cannot be paid before that.` };
  const paidAt = paidOn === today ? now : new Date(parseCentralLocal(`${paidOn}T12:00`)!);

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
export async function voidInvoice(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<PaidOut> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the invoice is being taken back." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null } });
  if (!load) return { ok: false, error: "That load does not exist." };
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
export async function undoPaid(loadId: string, reason: string, now = new Date(), workspaceId = currentWorkspaceId()): Promise<PaidOut> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the payment is being taken back." };
  const load = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null } });
  if (!load) return { ok: false, error: "That load does not exist." };
  const received = numOrNull(load.paidAmount) ?? 0;
  const hasPayment = load.paymentStatus === "paid" || (load.paymentStatus === "invoiced" && received > 0);
  if (!hasPayment) return { ok: false, error: "No payment has been recorded on this invoice." };
  const billed = billedOf({ invoicedAmount: numOrNull(load.invoicedAmount), status: load.status, quotedRevenue: num(load.quotedRevenue), fuelSurcharge: numOrNull(load.fuelSurcharge), tonuRevenue: numOrNull(load.tonuRevenue) });
  const out = await prisma.$transaction(async (tx) => {
    // Taken back once: the invoice has to still be in the state (status and amount received) it was read in, or this is a second press, or another person's undo, and it does nothing.
    const claimed = await tx.load.updateMany({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: load.paymentStatus, paidAmount: load.paidAmount }, data: { updatedAt: now } });
    if (claimed.count !== 1) return false;
    const last = await tx.loadPayment.findFirst({ where: { loadId, workspaceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    if (last) await tx.loadPayment.delete({ where: { id: last.id } });
    const rest = last ? await tx.loadPayment.aggregate({ _sum: { amount: true }, where: { loadId, workspaceId } }) : null;
    const left = last ? dec(rest?._sum.amount ? rest._sum.amount.toNumber() : 0) : dec(0);
    const lastTaken = last ? last.amount.toNumber() : received;
    const lastPaid = last ? await tx.loadPayment.findFirst({ where: { loadId, workspaceId }, orderBy: [{ paidAt: "desc" }, { id: "desc" }] }) : null;
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
  return out ? { ok: true } : { ok: false, error: "That payment was already taken back, or the invoice changed. Reload the load." };
}

/** The invoice as billed, for printing: its lines, who it is for, and the load it came from. */
export async function getInvoice(loadId: string, workspaceId = currentWorkspaceId(), terminal: string | null = null) {
  const [l, lastChase] = await Promise.all([
    prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: { not: null }, ...(terminal ? { OR: [{ vehicle: { terminal } }, { assignment: { driver: { terminal } } }, { vehicleId: null, assignment: null }] } : {}) }, include: { stops: { orderBy: { stopSequence: "asc" } }, workspace: true, payments: { orderBy: [{ paidAt: "asc" }, { id: "asc" }] } } }),
    prisma.auditEvent.findFirst({ where: { workspaceId, loadId, action: "invoice_chased" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { createdAt: true, actor: true } })
  ]);
  if (!l || !l.invoicedAt) return null;
  const lines = Array.isArray(l.invoiceLines) ? (l.invoiceLines as Array<{ label: string; amount: number }>) : null;
  const total = billedOf({ invoicedAmount: numOrNull(l.invoicedAmount), status: l.status, quotedRevenue: num(l.quotedRevenue), fuelSurcharge: numOrNull(l.fuelSurcharge), tonuRevenue: numOrNull(l.tonuRevenue) });
  const terms = l.payTermsDays ?? 0;
  return {
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
    status: l.paymentStatus,
    paidAt: l.paidAt,
    paidAmount: numOrNull(l.paidAmount),
    writeOffAmount: numOrNull(l.writeOffAmount),
    writeOffReason: l.writeOffReason,
    /** What is still owed on an invoice that is out (the total less what has come in so far); 0 when it is paid. */
    balance: l.paymentStatus === "paid" ? 0 : dec(total).minus(dec(numOrNull(l.paidAmount) ?? 0)).toNumber(),
    payments: l.payments.map((p) => ({ amount: p.amount.toNumber(), paidAt: p.paidAt, method: p.method })),
    paidMethod: l.paidMethod,
    poNumber: l.poNumber,
    lastChasedAt: lastChase?.createdAt ?? null,
    lastChasedBy: lastChase?.actor ?? null
  };
}
