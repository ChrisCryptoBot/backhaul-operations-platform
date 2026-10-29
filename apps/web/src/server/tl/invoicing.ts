import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { defaultInvoiceNumber, invoiceReadiness, validateInvoice, type InvoiceForm } from "@/lib/invoicing";
import { isPaidMethod, paidMethodLabel } from "@/lib/pay-method";
import { parseCentralLocal, toCentralLocal } from "@/lib/zoned";
import { customerTermsMap } from "./customers";
import { recordAudit } from "./audit";
import { toCompany } from "./company";
import { num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { getThresholds } from "./thresholds";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Invoice a delivered load, mark an invoice paid (in full or short), and take a payment back. Each writes its audit event with the change.
 * The amount is TrueLane's "total due": the agreed rate plus the billable fuel surcharge plus the extra charges chosen (detention, lumper,
 * layover, one other), and the invoice keeps its lines so it can be printed as it was billed. A load with nobody to bill, or no number to
 * bill under, is refused: that invoice could not be paid.
 */
export type InvoiceOut = { ok: boolean; detention: number; total?: number; error?: string; errors?: Record<string, string> };

export async function invoiceLoad(loadId: string, opts: { includeDetention?: boolean; form?: InvoiceForm } = {}, now = new Date()): Promise<InvoiceOut> {
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId }, include: { stops: true, vehicle: { include: { costProfile: true } } } });
  if (load.status !== "completed" || load.paymentStatus) return { ok: false, detention: 0 };
  const ready = invoiceReadiness({ ...load, quotedRevenue: num(load.quotedRevenue) });
  if (ready.blockers.length > 0) return { ok: false, detention: 0, error: ready.blockers[0] };

  const thresholds = await getThresholds();
  const billable = detentionOfLoad(load, thresholds.detentionGraceMinutes).billable;
  const form: InvoiceForm = opts.form ?? { number: defaultInvoiceNumber(load.loadNumber, loadId), terms: "", detention: !!opts.includeDetention, lumper: "", layover: "", otherLabel: "", other: "" };
  const check = validateInvoice(form, { rate: num(load.quotedRevenue), surcharge: num(load.fuelSurcharge), detention: billable, defaultTerms: load.payTermsDays ?? (await customerTermsMap(load.workspaceId)).get((load.brokerName ?? "").trim().toLowerCase()) ?? thresholds.defaultPayTermsDays });
  if (!check.ok) return { ok: false, detention: 0, errors: check.errors };
  const { number, terms, lines, total } = check.value;
  const detention = lines.find((l) => l.label === "Detention")?.amount ?? 0;
  const extra = lines.filter((l) => l.label !== "Line haul" && l.label !== "Fuel surcharge");
  const takenMessage = (on: string | null) => ({ ok: false as const, detention: 0, errors: { number: `${number} is already on ${on ?? "another load"}. Use another number.` } });
  try {
    await prisma.$transaction(async (tx) => {
      // Checked inside the transaction that writes it, and backed by a unique index, so two invoices saved at once cannot share a number.
      const taken = await tx.load.findFirst({ where: { workspaceId: load.workspaceId, invoiceNumber: number, deletedAt: null, id: { not: loadId } }, select: { loadNumber: true } });
      if (taken) throw new NumberTaken(taken.loadNumber);
      await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", invoicedAt: now, invoicedAmount: total, invoiceNumber: number, payTermsDays: terms, invoiceLines: lines } });
      await recordAudit(
        {
          entity: "invoice",
          action: "invoiced",
          loadId,
          loadNumber: load.loadNumber,
          summary: `${number} created for $${total.toFixed(2)}${extra.length > 0 ? `, with ${extra.map((l) => `$${l.amount.toFixed(2)} of ${l.label.toLowerCase()}`).join(" and ")}` : ""}`,
          before: { Invoice: null, Amount: null },
          after: { Invoice: number, Amount: `$${total.toFixed(2)}`, ...Object.fromEntries(extra.map((l) => [l.label, `$${l.amount.toFixed(2)}`])), Terms: `Net ${terms}` },
          at: now
        },
        tx
      );
    });
  } catch (e) {
    if (e instanceof NumberTaken) return takenMessage(e.on);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return takenMessage(null);
    throw e;
  }
  return { ok: true, detention, total };
}

class NumberTaken extends Error {
  constructor(readonly on: string | null) {
    super("invoice number taken");
  }
}

export type PaidOut = { ok: boolean; error?: string; difference?: number };

/** Mark an invoice paid. With an amount, a payment that is not the invoice total is recorded as it came, and the audit entry says by how much. */
export async function markLoadPaid(loadId: string, now = new Date(), opts: { amount?: number; /** The day it came in, "2026-10-29" on the Dallas calendar; today when blank. */ paidOn?: string; method?: string } = {}): Promise<PaidOut> {
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
  if (load.paymentStatus !== "invoiced") return { ok: false };
  const billed = num(load.invoicedAmount ?? load.quotedRevenue);
  const amount = opts.amount ?? billed;
  if (!Number.isFinite(amount) || !(amount > 0) || amount > 1_000_000) return { ok: false, error: "Type the amount that came in, above zero." };
  const method = (opts.method ?? "").trim();
  if (method !== "" && !isPaidMethod(method)) return { ok: false, error: "Pick how it was paid from the list." };
  // A payment can be entered late: the day it actually came in, never before the invoice and never in the future. Days-to-pay counts from it.
  const day = (d: Date) => toCentralLocal(d.getTime()).slice(0, 10);
  const today = day(now);
  const paidOn = (opts.paidOn ?? "").trim() || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || parseCentralLocal(`${paidOn}T12:00`) == null) return { ok: false, error: "Type the day it was paid, like 2026-10-29." };
  if (paidOn > today) return { ok: false, error: "A payment cannot come in on a day that has not happened." };
  if (load.invoicedAt && paidOn < day(load.invoicedAt)) return { ok: false, error: `The invoice went out on ${day(load.invoicedAt)}, so it cannot be paid before that.` };
  const paidAt = paidOn === today ? now : new Date(parseCentralLocal(`${paidOn}T12:00`)!);
  const diff = new Prisma.Decimal(amount).minus(billed).toDecimalPlaces(2).toNumber();
  const gap = new Prisma.Decimal(diff).abs().toFixed(2);
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "paid", paidAt, paidAmount: amount, paidMethod: method || null } });
    await recordAudit(
      {
        entity: "invoice",
        action: "paid",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${load.invoiceNumber ?? "Invoice"} paid${method ? ` by ${paidMethodLabel(method).toLowerCase()}` : ""}${paidOn !== today ? ` on ${paidOn}` : ""}, $${amount.toFixed(2)}${diff < 0 ? `, $${gap} short of $${billed.toFixed(2)}` : diff > 0 ? `, $${diff.toFixed(2)} over $${billed.toFixed(2)}` : ""}`,
        before: { Status: "Invoiced", Billed: `$${billed.toFixed(2)}` },
        after: { Status: "Paid", Amount: `$${amount.toFixed(2)}`, ...(method ? { Method: paidMethodLabel(method) } : {}), ...(paidOn !== today ? { "Paid on": paidOn } : {}), ...(diff !== 0 ? { Difference: `${diff < 0 ? "-" : "+"}$${gap}` } : {}) },
        at: now
      },
      tx
    );
  });
  return diff === 0 ? { ok: true } : { ok: true, difference: diff };
}

/** Take a payment back: a payment entered against the wrong invoice, or one that bounced. The invoice is out again, and the reason is kept. */
export async function undoPaid(loadId: string, reason: string, now = new Date()): Promise<PaidOut> {
  const why = reason.trim();
  if (why.length < 3) return { ok: false, error: "Say why the payment is being taken back." };
  const load = await prisma.load.findUniqueOrThrow({ where: { id: loadId } });
  if (load.paymentStatus !== "paid") return { ok: false, error: "This invoice is not marked paid." };
  const was = numOrNull(load.paidAmount) ?? 0;
  await prisma.$transaction(async (tx) => {
    await tx.load.update({ where: { id: loadId }, data: { paymentStatus: "invoiced", paidAt: null, paidAmount: null, paidMethod: null } });
    await recordAudit(
      {
        entity: "invoice",
        action: "payment_undone",
        loadId,
        loadNumber: load.loadNumber,
        summary: `${load.invoiceNumber ?? "Invoice"} payment of $${was.toFixed(2)} taken back`,
        reason: why,
        before: { Status: "Paid", Amount: `$${was.toFixed(2)}` },
        after: { Status: "Invoiced", Amount: null },
        at: now
      },
      tx
    );
  });
  return { ok: true };
}

/** The invoice as billed, for printing: its lines, who it is for, and the load it came from. */
export async function getInvoice(loadId: string, workspaceId = DEMO_WORKSPACE_ID) {
  const l = await prisma.load.findFirst({ where: { id: loadId, workspaceId, deletedAt: null, paymentStatus: { not: null } }, include: { stops: { orderBy: { stopSequence: "asc" } }, workspace: true } });
  if (!l || !l.invoicedAt) return null;
  const lines = Array.isArray(l.invoiceLines) ? (l.invoiceLines as Array<{ label: string; amount: number }>) : null;
  const total = num(l.invoicedAmount ?? l.quotedRevenue);
  const terms = l.payTermsDays ?? 0;
  return {
    id: l.id,
    issuer: l.workspace.name,
    company: toCompany(l.workspace),
    invoiceNumber: l.invoiceNumber,
    sent: l.invoicedAt,
    due: new Date(l.invoicedAt.getTime() + terms * 86_400_000),
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
    paidMethod: l.paidMethod,
    poNumber: l.poNumber
  };
}
