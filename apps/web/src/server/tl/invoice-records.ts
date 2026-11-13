import { Prisma } from "@prisma/client";
import { lineKindOf, projectToLoads, type ShortCode } from "@/lib/invoice-records";
import { emitInvoice, emitPayment } from "@/server/webhooks/emit";

/**
 * The write side of invoices as their own records (docs/MONEY_PLAN.md, Wave 1). Every function here runs inside the caller's transaction, beside the write to the load,
 * so the record and the load's projected invoice fields change together or not at all. server/tl/invoicing.ts is the only caller: it stays the one write path.
 */
type Tx = Prisma.TransactionClient;
const cents = (n: Prisma.Decimal.Value) => new Prisma.Decimal(n).toDecimalPlaces(2);

/** The invoice a load is on now (not void), newest first. */
export async function openInvoiceOf(tx: Tx, workspaceId: string, loadId: string) {
  return tx.invoice.findFirst({
    where: { workspaceId, kind: "invoice", status: { not: "void" }, loads: { some: { loadId } } },
    orderBy: [{ issuedAt: "desc" }, { id: "desc" }],
    include: { lines: { orderBy: { sort: "asc" } }, loads: true }
  });
}

export type NewInvoice = {
  workspaceId: string;
  number: string;
  issuedAt: Date;
  termsDays: number;
  billTo: { name: string | null; mc: string | null; email: string | null; phone: string | null };
  /** In billing order. A line with no load is an invoice-level line (rule A): it stays on the invoice and never enters a load's projection. */
  lines: Array<{ loadId: string | null; label: string; amount: number }>;
  loadIds: string[];
};

/** Make the record for an invoice the caller has just claimed on its load(s). Returns its id. */
export async function createInvoiceRecord(tx: Tx, i: NewInvoice): Promise<string> {
  const total = i.lines.reduce((s, l) => s.plus(cents(l.amount)), new Prisma.Decimal(0));
  const inv = await tx.invoice.create({
    data: {
      workspaceId: i.workspaceId,
      number: i.number,
      issuedAt: i.issuedAt,
      termsDays: i.termsDays,
      total,
      billToName: i.billTo.name,
      billToMc: i.billTo.mc,
      billToEmail: i.billTo.email,
      billToPhone: i.billTo.phone,
      lines: { create: i.lines.map((l, n) => ({ loadId: l.loadId, kind: lineKindOf(l.label), label: l.label, amount: cents(l.amount), sort: n + 1 })) },
      loads: { create: i.loadIds.map((loadId) => ({ loadId })) }
    },
    select: { id: true }
  });
  // Outbound webhook (Wave 7): queued in this same transaction, so it exists exactly when the invoice does.
  await emitInvoice(tx, i.workspaceId, inv.id, "created");
  return inv.id;
}

export type PaymentIn = {
  workspaceId: string;
  invoiceId: string;
  amount: number;
  paidAt: Date;
  method: string | null;
  reference?: string | null;
  payer?: string | null;
  note?: string | null;
  source?: "desk" | "factor" | "accounting" | "import" | "credit";
  externalId?: string | null;
};

/** Record money received and bring the invoice's total received up to date. Closing is the caller's choice (closeInvoiceRecord). */
export async function addInvoicePayment(tx: Tx, p: PaymentIn): Promise<void> {
  const row = await tx.invoicePayment.create({
    data: {
      workspaceId: p.workspaceId,
      invoiceId: p.invoiceId,
      amount: cents(p.amount),
      paidAt: p.paidAt,
      method: p.method,
      reference: p.reference?.trim() || null,
      payer: p.payer?.trim() || null,
      note: p.note?.trim() || null,
      source: p.source ?? "desk",
      externalId: p.externalId ?? null
    }
  });
  await refreshPaidTotal(tx, p.invoiceId);
  // Every payment, from any path (the desk, a factor's status file, QuickBooks, a credit memo), passes here: payment.applied is queued with it.
  await emitPayment(tx, p.workspaceId, row, "applied");
}

/** Close an invoice as paid, with what was written off when it closed short and why. */
export async function closeInvoiceRecord(tx: Tx, invoiceId: string, c: { paidAt: Date; writeOff?: { amount: number; reason: string; code: ShortCode | null } | null; factoringPaid?: boolean; now: Date }): Promise<void> {
  // A funded invoice the customer has now paid: the factor releases the reserve less its fee (docs/MONEY_PLAN.md, Wave 2).
  let released: Prisma.Decimal | null = null;
  if (c.factoringPaid) {
    const f = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { factoringReserve: true, factoringFee: true } });
    if (f?.factoringReserve) {
      const left = f.factoringReserve.minus(f.factoringFee ?? 0);
      released = left.isNegative() ? new Prisma.Decimal(0) : left;
    }
  }
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: "paid",
      paidAt: c.paidAt,
      writeOffAmount: c.writeOff ? cents(c.writeOff.amount) : null,
      writeOffReason: c.writeOff ? c.writeOff.reason : null,
      writeOffCode: c.writeOff ? c.writeOff.code : null,
      // The release is dated by the payment that closed it (the day the journal has always booked it on).
      ...(c.factoringPaid ? { factoringStatus: "paid", factoringUpdatedAt: c.now, ...(released ? { factoringReserveReleased: released, factoringReserveReleasedAt: c.paidAt } : {}) } : {})
    }
  });
}

/** Take the newest payment back: the invoice is open again with what the others add up to, and no write-off. */
export async function removeLastInvoicePayment(tx: Tx, invoiceId: string, opts: { factoringBackToFunded: boolean; now: Date }): Promise<void> {
  const last = await tx.invoicePayment.findFirst({ where: { invoiceId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  if (last) {
    await tx.invoicePayment.delete({ where: { id: last.id } });
    await emitPayment(tx, last.workspaceId, last, "reversed", opts.now);
  }
  await refreshPaidTotal(tx, invoiceId);
  await tx.invoice.update({
    where: { id: invoiceId },
    data: { status: "open", paidAt: null, writeOffAmount: null, writeOffReason: null, writeOffCode: null, ...(opts.factoringBackToFunded ? { factoringStatus: "funded", factoringUpdatedAt: opts.now, factoringReserveReleased: null, factoringReserveReleasedAt: null } : {}) }
  });
}

/** An invoice taken back keeps its record (its number stays used); it is void, with the reason. */
export async function voidInvoiceRecord(tx: Tx, invoiceId: string, reason: string, now: Date): Promise<void> {
  const inv = await tx.invoice.update({ where: { id: invoiceId }, data: { status: "void", voidedAt: now, voidReason: reason }, select: { workspaceId: true } });
  await emitInvoice(tx, inv.workspaceId, invoiceId, "voided", now);
}

/** The factoring words on the record follow the load's (the load stays the one the screens read during the move). */
export async function setInvoiceFactoring(tx: Tx, invoiceId: string, f: { status: string; referenceId?: string | null; now: Date }): Promise<void> {
  await tx.invoice.update({ where: { id: invoiceId }, data: { factoringStatus: f.status, ...(f.referenceId !== undefined ? { factoringReferenceId: f.referenceId } : {}), factoringUpdatedAt: f.now } });
}

/**
 * Make the record for every load in a workspace that carries invoice fields but is on no invoice that is not void: loads written in bulk by the importer and the demo seeds,
 * which do not go through invoiceLoad. Idempotent (a load that already has its record is skipped; ids are derived from the load and its invoice number). Returns how many it made.
 */
export async function ensureInvoiceRecords(db: Tx | Prisma.DefaultPrismaClient, workspaceId: string): Promise<number> {
  const rows = await db.$queryRaw<Array<{ made: number }>>`
    WITH todo AS (
      SELECT l.* FROM "loads" l
      WHERE l."workspace_id" = ${workspaceId} AND l."invoice_number" IS NOT NULL AND l."invoiced_at" IS NOT NULL AND l."payment_status" IN ('invoiced', 'paid')
        AND NOT EXISTS (SELECT 1 FROM "invoice_loads" il JOIN "invoices" i ON i."id" = il."invoice_id" WHERE il."load_id" = l."id" AND i."status" <> 'void')
        AND NOT EXISTS (SELECT 1 FROM "invoices" i WHERE i."workspace_id" = l."workspace_id" AND i."number" = l."invoice_number")
    ), inv AS (
      INSERT INTO "invoices" ("id", "workspace_id", "number", "kind", "status", "bill_to_name", "bill_to_mc", "bill_to_email", "bill_to_phone", "issued_at", "terms_days", "total", "paid_total", "paid_at", "write_off_amount", "write_off_reason", "factoring_status", "factoring_reference_id", "factoring_updated_at", "created_at", "updated_at")
      SELECT 'ini_' || t."id", t."workspace_id", t."invoice_number", 'invoice', CASE WHEN t."payment_status" = 'paid' THEN 'paid' ELSE 'open' END,
        t."broker_name", t."broker_mc_number", t."broker_email", t."broker_phone", t."invoiced_at", COALESCE(t."pay_terms_days", 0),
        ROUND(COALESCE(t."invoiced_amount", CASE WHEN t."status" = 'tonu' THEN COALESCE(t."tonu_revenue", 0) ELSE t."quoted_revenue" + COALESCE(t."fuel_surcharge", 0) END), 2),
        ROUND(COALESCE(t."paid_amount", 0), 2), t."paid_at", t."write_off_amount", t."write_off_reason", t."factoring_status", t."factoring_reference_id", t."factoring_updated_at", t."invoiced_at", CURRENT_TIMESTAMP
      FROM todo t
      ON CONFLICT DO NOTHING
      RETURNING "id", "total", "paid_total", "paid_at", "issued_at", "workspace_id"
    ), links AS (
      INSERT INTO "invoice_loads" ("invoice_id", "load_id") SELECT inv."id", substr(inv."id", 5) FROM inv ON CONFLICT DO NOTHING RETURNING 1
    ), lines AS (
      INSERT INTO "invoice_lines" ("id", "invoice_id", "load_id", "kind", "label", "amount", "sort")
      SELECT 'ilx_' || substr(inv."id", 5), inv."id", substr(inv."id", 5), CASE WHEN t."status" = 'tonu' THEN 'tonu' ELSE 'linehaul' END,
        CASE WHEN t."status" = 'tonu' THEN 'TONU fee' ELSE 'Line haul and fuel surcharge' END, inv."total", 1
      FROM inv JOIN todo t ON t."id" = substr(inv."id", 5)
      ON CONFLICT DO NOTHING RETURNING 1
    ), pays AS (
      INSERT INTO "invoice_payments" ("id", "workspace_id", "invoice_id", "amount", "paid_at", "source", "created_at")
      SELECT 'ipx_' || substr(inv."id", 5), inv."workspace_id", inv."id", inv."paid_total", COALESCE(inv."paid_at", inv."issued_at"), 'import', CURRENT_TIMESTAMP
      FROM inv WHERE inv."paid_total" > 0
      ON CONFLICT DO NOTHING RETURNING 1
    )
    SELECT (SELECT count(*) FROM inv)::int AS made, ((SELECT count(*) FROM links) + (SELECT count(*) FROM lines) + (SELECT count(*) FROM pays))::int AS rest`;
  return rows[0]?.made ?? 0;
}

async function refreshPaidTotal(tx: Tx, invoiceId: string): Promise<void> {
  const sum = await tx.invoicePayment.aggregate({ where: { invoiceId }, _sum: { amount: true } });
  await tx.invoice.update({ where: { id: invoiceId }, data: { paidTotal: sum._sum.amount ?? new Prisma.Decimal(0) } });
}

/**
 * What every load on an invoice must show, from the record (rule A). Used by the parity check; the write path writes the same values it already computed.
 */
export async function projectionOf(tx: Tx | Prisma.DefaultPrismaClient, invoiceId: string) {
  const inv = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { lines: { orderBy: { sort: "asc" } }, loads: true } });
  if (!inv) return [];
  const order: string[] = [];
  for (const l of inv.lines) if (l.loadId && !order.includes(l.loadId)) order.push(l.loadId);
  for (const l of inv.loads) if (!order.includes(l.loadId)) order.push(l.loadId);
  const amountOf = (loadId: string) => inv.lines.filter((l) => l.loadId === loadId).reduce((s, l) => s.plus(l.amount), new Prisma.Decimal(0));
  return projectToLoads({
    number: inv.number,
    status: inv.status as "open" | "paid" | "void",
    issuedAt: inv.issuedAt,
    termsDays: inv.termsDays,
    paidTotal: inv.paidTotal,
    paidAt: inv.paidAt,
    loads: order.map((loadId) => ({ loadId, amount: amountOf(loadId) }))
  });
}
