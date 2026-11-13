import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { encodeCursor, type Cursor } from "@/lib/api-keys";

/**
 * What the partner read API answers (docs/MONEY_PLAN.md, Wave 7 step 2). Every function takes the workspace as a required parameter, with no default, and reads only that workspace's rows.
 *
 * The shape, for every list: oldest first by creation time, ties by id (the cursor is where the last page ended, so paging is stable while rows are added); times as ISO 8601 in UTC (the
 * workspace's own zone is named beside the list); money as decimal text with two places (never a float); ids as the desk's own. No person's details: a load or a statement names its driver by
 * id only (no name, phone, email, tax id or pay setup), an invoice names the customer as a business (name and MC), and loads deleted from the desk are not listed. Draft statements are not
 * statements yet (a discarded one simply goes away), so only finalized and voided ones are listed.
 */
export type Page = { after: Cursor | null; limit: number };
export type ListOut = { data: Array<Record<string, unknown>>; next: string | null };

type Dec = { toFixed(places: number): string } | null | undefined;
const money = (d: Dec): string | null => (d == null ? null : d.toFixed(2));
const miles = (d: Dec): string | null => (d == null ? null : d.toFixed(1));
const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const day = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Rows after the cursor, in (createdAt, id) order. */
const afterCursor = (c: Cursor | null) => (c ? { OR: [{ createdAt: { gt: c.t } }, { createdAt: c.t, id: { gt: c.id } }] } : {});
const ORDER = [{ createdAt: "asc" as const }, { id: "asc" as const }];

function paged<T extends { id: string; createdAt: Date }>(rows: T[], limit: number, shape: (r: T) => Record<string, unknown>): ListOut {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { data: page.map(shape), next: more && last ? encodeCursor({ t: last.createdAt, id: last.id }) : null };
}

/** The invoice and credit memo shape, shared by the read API and the outbound webhooks (src/server/webhooks/emit.ts), so a receiver sees one shape everywhere. */
export const INVOICE_INCLUDE = { loads: { select: { loadId: true }, orderBy: { loadId: "asc" as const } } };
export const shapeInvoice = (r: Prisma.InvoiceGetPayload<{ include: typeof INVOICE_INCLUDE }>): Record<string, unknown> => ({
    id: r.id,
    object: r.kind === "credit_memo" ? "credit_memo" : "invoice",
    number: r.number,
    kind: r.kind,
    status: r.status,
    bill_to: { name: r.billToName, mc: r.billToMc },
    issued_at: iso(r.issuedAt),
    terms_days: r.termsDays,
    total: money(r.total),
    paid_total: money(r.paidTotal),
    paid_at: iso(r.paidAt),
    write_off_amount: money(r.writeOffAmount),
    credit_of: r.creditOfId,
    voided_at: iso(r.voidedAt),
    factoring: {
      status: r.factoringStatus,
      reference: r.factoringReferenceId,
      advance: money(r.factoringAdvance),
      fee: money(r.factoringFee),
      reserve: money(r.factoringReserve),
      reserve_released: money(r.factoringReserveReleased),
      chargeback: money(r.factoringChargeback),
      funded_at: iso(r.factoringFundedAt)
    },
    load_ids: r.loads.map((l) => l.loadId),
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt)
});

export const shapePayment = (r: Prisma.InvoicePaymentGetPayload<object>): Record<string, unknown> => ({
    id: r.id,
    object: "payment",
    invoice_id: r.invoiceId,
    amount: money(r.amount),
    paid_at: iso(r.paidAt),
    method: r.method,
    reference: r.reference,
    payer: r.payer,
    source: r.source,
    created_at: iso(r.createdAt)
});

export const SETTLEMENT_SELECT = { id: true, number: true, driverId: true, status: true, periodStart: true, periodEnd: true, total: true, finalizedAt: true, voidedAt: true, paidAt: true, paidMethod: true, payrollSentAt: true, payrollReference: true, createdAt: true, updatedAt: true } as const;
export const shapeSettlement = (r: Prisma.SettlementGetPayload<{ select: typeof SETTLEMENT_SELECT }>): Record<string, unknown> => ({
    id: r.id,
    object: "settlement",
    number: r.number,
    driver_id: r.driverId,
    status: r.status,
    period_start: day(r.periodStart),
    period_end: day(r.periodEnd),
    total: money(r.total),
    finalized_at: iso(r.finalizedAt),
    voided_at: iso(r.voidedAt),
    paid_at: iso(r.paidAt),
    paid_method: r.paidMethod,
    // A claim the desk holds while it is sending (pending:...) is not a payroll run yet.
    payroll_reference: r.payrollReference && !r.payrollReference.startsWith("pending:") ? r.payrollReference : null,
    payroll_sent_at: r.payrollReference && !r.payrollReference.startsWith("pending:") ? iso(r.payrollSentAt) : null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt)
});

export async function listInvoices(workspaceId: string, page: Page): Promise<ListOut> {
  const where: Prisma.InvoiceWhereInput = { workspaceId, ...afterCursor(page.after) };
  const rows = await prisma.invoice.findMany({ where, orderBy: ORDER, take: page.limit + 1, include: INVOICE_INCLUDE });
  return paged(rows, page.limit, shapeInvoice);
}

export async function listPayments(workspaceId: string, page: Page): Promise<ListOut> {
  const rows = await prisma.invoicePayment.findMany({ where: { workspaceId, ...afterCursor(page.after) }, orderBy: ORDER, take: page.limit + 1 });
  return paged(rows, page.limit, shapePayment);
}

export async function listSettlements(workspaceId: string, page: Page): Promise<ListOut> {
  const rows = await prisma.settlement.findMany({
    where: { workspaceId, status: { in: ["final", "void"] }, ...afterCursor(page.after) },
    orderBy: ORDER,
    take: page.limit + 1,
    select: SETTLEMENT_SELECT
  });
  return paged(rows, page.limit, shapeSettlement);
}

export async function listLoads(workspaceId: string, page: Page): Promise<ListOut> {
  const rows = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null, ...afterCursor(page.after) },
    orderBy: ORDER,
    take: page.limit + 1,
    select: {
      id: true,
      loadNumber: true,
      status: true,
      brokerName: true,
      brokerMcNumber: true,
      originAddress: true,
      destinationAddress: true,
      scheduledDate: true,
      completedAt: true,
      loadedMiles: true,
      pickupDeadheadMiles: true,
      quotedRevenue: true,
      fuelSurcharge: true,
      tonuRevenue: true,
      invoiceNumber: true,
      invoicedAmount: true,
      invoicedAt: true,
      paymentStatus: true,
      paidAmount: true,
      paidAt: true,
      vehicleId: true,
      trailerId: true,
      createdAt: true,
      updatedAt: true,
      assignment: { select: { driverId: true } }
    }
  });
  return paged(rows, page.limit, (r) => ({
    id: r.id,
    object: "load",
    load_number: r.loadNumber,
    status: r.status,
    customer: { name: r.brokerName, mc: r.brokerMcNumber },
    origin: r.originAddress,
    destination: r.destinationAddress,
    scheduled_at: iso(r.scheduledDate),
    completed_at: iso(r.completedAt),
    loaded_miles: miles(r.loadedMiles),
    deadhead_miles: miles(r.pickupDeadheadMiles),
    rate: money(r.quotedRevenue),
    fuel_surcharge: money(r.fuelSurcharge),
    tonu_fee: money(r.tonuRevenue),
    invoice_number: r.invoiceNumber,
    invoiced_amount: money(r.invoicedAmount),
    invoiced_at: iso(r.invoicedAt),
    payment_status: r.paymentStatus,
    paid_amount: money(r.paidAmount),
    paid_at: iso(r.paidAt),
    vehicle_id: r.vehicleId,
    trailer_id: r.trailerId,
    driver_id: r.assignment?.driverId ?? null,
    created_at: iso(r.createdAt),
    updated_at: iso(r.updatedAt)
  }));
}

export const READERS = { invoices: listInvoices, payments: listPayments, settlements: listSettlements, loads: listLoads } as const;
