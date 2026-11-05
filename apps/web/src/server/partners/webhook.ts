import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { workspaceReader } from "./credentials";
import { applyFactoringUpdate } from "./factoring";
import { applyPayrollPaid, applyTrackingMilestone } from "./events";
import { recordHealth } from "./health";
import { MAX_WEBHOOK_BYTES, factoringStatusOf, readEvent, signatureHeaderFor, verifySignature } from "./webhook-core";

/**
 * A company tells the desk something (a factor has funded an invoice). The address carries the fleet (an unguessable token on the connection), the signature proves the company sent it,
 * and the company's own event id makes a repeat harmless. The order, and why:
 *   1. the token finds the connection (unknown: 404, nothing said);
 *   2. the signature is checked on the raw bytes BEFORE anything is parsed, under the fleet's own signing secret or the server's (none set: refused, never accepted unverified);
 *   3. the event is recorded once (a repeat answers 200 "duplicate" and does nothing);
 *   4. it is applied through the same function a person uses by hand, so every rule that guards a status (one allowed step, nothing after full payment) guards a webhook too.
 * A valid signature always gets a 200 for an event we understand or not, so a company does not retry a delivery that will never mean anything. No body is kept.
 */
export type WebhookAnswer = { status: 200 | 400 | 401 | 404 | 413; body: { ok: boolean; result?: "applied" | "ignored" | "duplicate"; error?: string } };

const answer = (status: WebhookAnswer["status"], body: WebhookAnswer["body"]): WebhookAnswer => ({ status, body });

export async function handleWebhook(i: { provider: string; token: string; raw: string; signature: string | null; now?: Date }): Promise<WebhookAnswer> {
  const now = i.now ?? new Date();
  if (Buffer.byteLength(i.raw, "utf8") > MAX_WEBHOOK_BYTES) return answer(413, { ok: false, error: "Too large." });
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(i.token)) return answer(404, { ok: false, error: "Not found." });
  const conn = await prisma.partnerConnection.findUnique({ where: { webhookToken: i.token } });
  // The address names the company, or the kind of service it is ("factoring"): either way the token is what finds the connection, and a name that does not fit it is a 404.
  if (!conn || (conn.provider !== i.provider && conn.capability !== i.provider) || (conn.status !== "connected" && conn.status !== "error")) return answer(404, { ok: false, error: "Not found." });

  const secretName = WEBHOOK_SECRET_ENV[conn.provider];
  const secret = secretName ? (await workspaceReader(conn.provider, conn.workspaceId))(secretName) : undefined;
  if (!secret || !verifySignature(i.raw, i.signature, secret)) return answer(401, { ok: false, error: "Not allowed." });

  let parsed: unknown;
  try {
    parsed = JSON.parse(i.raw);
  } catch {
    return answer(400, { ok: false, error: "Not JSON." });
  }
  const event = readEvent(conn.provider, parsed, i.raw);
  const eventKey = event ? `${conn.workspaceId}:${event.id}` : `${conn.workspaceId}:unread:${randomBytes(9).toString("hex")}`;
  // Recorded first: the unique key is what makes a repeat one event, even when two deliveries arrive at the same moment.
  try {
    await prisma.partnerEvent.create({ data: { workspaceId: conn.workspaceId, provider: conn.provider, eventId: eventKey, kind: event?.kind ?? "unread", outcome: "ignored", receivedAt: now } });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return answer(200, { ok: true, result: "duplicate" });
    throw e;
  }
  if (!event) return answer(200, { ok: true, result: "ignored" });

  let applied = false;
  let detail: string | null = null;
  const status = factoringStatusOf(event.kind);
  if (status && conn.capability === "factoring") {
    if (!event.reference) detail = "No invoice reference.";
    else {
      const load = await prisma.load.findFirst({ where: { workspaceId: conn.workspaceId, deletedAt: null, OR: [{ invoiceNumber: event.reference }, { factoringReferenceId: event.reference }] }, select: { id: true } });
      if (!load) detail = "No invoice with that reference.";
      else applied = await applyFactoringUpdate(load.id, status, event.referenceId, now, conn.workspaceId);
      if (load && !applied) detail = "Not an allowed step from where the invoice is.";
    }
  } else if (event.kind === "payroll.paid" && conn.capability === "payroll") {
    applied = await applyPayrollPaid(event.reference, now, conn.workspaceId);
    if (!applied) detail = "No sent statements on that run.";
  } else if ((event.kind === "tracking.arrived" || event.kind === "tracking.departed") && conn.capability === "tracking") {
    applied = await applyTrackingMilestone({ reference: event.reference, stop: event.stop ?? null, kind: event.kind }, now, conn.workspaceId);
    if (!applied) detail = "No open load with that reference.";
  } else if (event.kind === "ping") {
    applied = true;
  }
  await prisma.partnerEvent.update({ where: { provider_eventId: { provider: conn.provider, eventId: eventKey } }, data: { outcome: applied ? "applied" : "ignored", detail } });
  if (applied) {
    await recordHealth(conn.workspaceId, conn.capability, conn.provider, { ok: true, data: null }, now);
    if (event.kind === "ping") await recordAudit({ entity: "partner", action: "partner_event", summary: `${conn.provider} reached the desk (test event)`, at: now, workspaceId: conn.workspaceId });
  }
  return answer(200, { ok: true, result: applied ? "applied" : "ignored" });
}
