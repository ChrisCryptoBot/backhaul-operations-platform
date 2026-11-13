import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { allowed } from "@/lib/partner-gates";
import { effectivePlan } from "@/lib/plans";
import type { WebhookEvent } from "@/lib/webhook-events";
import { INVOICE_INCLUDE, SETTLEMENT_SELECT, shapeInvoice, shapePayment, shapeSettlement } from "@/server/api/reads";

/**
 * Outbound webhook emission (docs/MONEY_PLAN.md, Wave 7 step 3). Called INSIDE the money write's own transaction, from the few places every invoice, payment and statement change passes
 * through (server/tl/invoice-records.ts, the credit memo and shared-invoice paths in server/tl/invoicing.ts, server/tl/settlement.ts), so an event row exists exactly when its change does: a
 * rolled-back write leaves none. Nothing here opens a connection; the partner schedule delivers the rows later (server/webhooks/deliver.ts).
 *
 * The data is the record as it stands at the end of the write, read inside the same transaction and shaped exactly as the read API shapes it (no person's details: drivers by id, customers
 * by business name and MC). A fleet with no endpoint for the event, or a plan without outbound webhooks, writes nothing.
 */
type Tx = Prisma.TransactionClient;

export const newEventId = (): string => `evt_${randomBytes(16).toString("hex")}`;

export function envelope(eventId: string, type: string, data: Record<string, unknown>, now: Date): Record<string, unknown> {
  return { id: eventId, object: "event", type, created_at: now.toISOString(), data };
}

/** Queue one event for every active endpoint of this fleet that takes it. Returns how many rows were written. */
export async function emitPartnerEvent(tx: Tx, workspaceId: string, type: WebhookEvent, data: Record<string, unknown>, now: Date = new Date()): Promise<number> {
  const endpoints = await tx.webhookEndpoint.findMany({ where: { workspaceId, active: true, disabledAt: null, events: { has: type } }, select: { id: true } });
  if (endpoints.length === 0) return 0;
  const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { plan: true } });
  if (!allowed("outbound_webhooks", effectivePlan(ws?.plan))) return 0;
  const eventId = newEventId();
  const payload = envelope(eventId, type, data, now) as Prisma.InputJsonObject;
  const out = await tx.webhookDelivery.createMany({ data: endpoints.map((e) => ({ workspaceId, endpointId: e.id, eventId, type, payload, nextAttemptAt: now, createdAt: now })) });
  return out.count;
}

/** invoice.created / invoice.voided / credit_memo.created / credit_memo.voided, from the invoice as it now stands. */
export async function emitInvoice(tx: Tx, workspaceId: string, invoiceId: string, change: "created" | "voided", now: Date = new Date()): Promise<number> {
  const inv = await tx.invoice.findFirst({ where: { id: invoiceId, workspaceId }, include: INVOICE_INCLUDE });
  if (!inv) return 0;
  const type: WebhookEvent = inv.kind === "credit_memo" ? (change === "created" ? "credit_memo.created" : "credit_memo.voided") : change === "created" ? "invoice.created" : "invoice.voided";
  return emitPartnerEvent(tx, workspaceId, type, shapeInvoice(inv), now);
}

/** payment.applied (the row just written) or payment.reversed (the row as it was, just before it was deleted). */
export async function emitPayment(tx: Tx, workspaceId: string, payment: Prisma.InvoicePaymentGetPayload<object>, change: "applied" | "reversed", now: Date = new Date()): Promise<number> {
  return emitPartnerEvent(tx, workspaceId, change === "applied" ? "payment.applied" : "payment.reversed", shapePayment(payment), now);
}

/** statement.finalized / statement.voided, from the statement as it now stands. */
export async function emitStatement(tx: Tx, workspaceId: string, settlementId: string, change: "finalized" | "voided", now: Date = new Date()): Promise<number> {
  const s = await tx.settlement.findFirst({ where: { id: settlementId, workspaceId }, select: SETTLEMENT_SELECT });
  if (!s) return 0;
  return emitPartnerEvent(tx, workspaceId, change === "finalized" ? "statement.finalized" : "statement.voided", shapeSettlement(s), now);
}
