import { randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PartnerConnection } from "@prisma/client";
import { prisma } from "@/lib/db";
import { WEBHOOK_SECRET_ENV } from "@/truelane/partners/contract";
import { recordAudit } from "@/server/tl/audit";
import { workspaceReader } from "./credentials";
import { applyFactoringUpdate } from "./factoring";
import { applyPayrollPaid, applyPayrollRejected, applyTrackingMilestone } from "./events";
import { recordHealth } from "./health";
import { MAX_WEBHOOK_BYTES, factoringStatusOf, readEvent, verifySignature, type NeutralEvent } from "./webhook-core";

/**
 * A company tells the desk something (a factor has funded an invoice). The address carries the fleet (an unguessable token on the connection), the signature proves the company sent it,
 * and the company's own event id makes a repeat harmless. The order, and why:
 *   1. the token finds the connection (unknown: 404, nothing said);
 *   2. the signature is checked on the raw bytes BEFORE anything is parsed, under the fleet's own signing secret or the server's (none set: refused, never accepted unverified);
 *   3. the event is recorded once, with its verified body (a repeat answers 200 "duplicate" and does nothing, unless the first try FAILED: then the repeat is tried again);
 *   4. it is applied through the same function a person uses by hand, so every rule that guards a status (one allowed step, nothing after full payment) guards a webhook too.
 * An event we understand or not gets a 200, so a company does not retry a delivery that will never mean anything. One the desk could not apply (an error on our side) is marked failed and
 * answered 500, so the company sends it again; Partner issues shows it and can replay it from the kept body (Wave 7 step 4). The body is kept only while it may be needed again (D6): while
 * the event is being applied, and after it failed. It is let go once the event has an outcome. One not used for a reason a person can fix (FIXABLE_DETAILS) is listed too, and a company
 * sending it again runs it again.
 */
export type WebhookAnswer = { status: 200 | 400 | 401 | 404 | 413 | 500; body: { ok: boolean; result?: "applied" | "ignored" | "duplicate" | "failed"; error?: string } };

const answer = (status: WebhookAnswer["status"], body: WebhookAnswer["body"]): WebhookAnswer => ({ status, body });

/** How long an event may sit "received" before a redelivery or a replay may take it over (the try that held it stopped part way). */
export const STUCK_MS = 10 * 60_000;

/**
 * Why an event was not used that a person can fix on the desk (the invoice it names does not exist yet). Such an event is listed on Partner issues, and a company sending it again runs it
 * again. Other reasons (a late or out-of-order step, a run already settled) are how events normally fall and are not issues.
 */
export const FIXABLE_DETAILS = ["No invoice with that reference.", "No invoice reference."] as const;

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
    await prisma.partnerEvent.create({ data: { workspaceId: conn.workspaceId, provider: conn.provider, eventId: eventKey, kind: event?.kind ?? "unread", outcome: "received", payload: i.raw, attemptedAt: now, receivedAt: now } });
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e;
    // A redelivery. Only an event whose first try failed, one not used for a reason a person can fix, or one that stopped part way and has sat for ten minutes is tried again, taken over in
    // one step so two redeliveries cannot both run it.
    const retaken = await prisma.partnerEvent.updateMany({
      where: { provider: conn.provider, eventId: eventKey, resolvedAt: null, OR: [{ outcome: "failed" }, { outcome: "ignored", detail: { in: [...FIXABLE_DETAILS] } }, { outcome: "received", attemptedAt: { lt: new Date(now.getTime() - STUCK_MS) } }] },
      data: { outcome: "received", attemptedAt: now, payload: i.raw }
    });
    if (retaken.count === 0) return answer(200, { ok: true, result: "duplicate" });
  }
  if (!event) {
    await prisma.partnerEvent.update({ where: { provider_eventId: { provider: conn.provider, eventId: eventKey } }, data: { outcome: "ignored", payload: null } });
    return answer(200, { ok: true, result: "ignored" });
  }
  const out = await runEvent(conn, event, eventKey, now);
  if (out.outcome === "failed") return answer(500, { ok: false, result: "failed", error: "The desk could not apply this event. Send it again." });
  return answer(200, { ok: true, result: out.outcome });
}

export type RunOutcome = { outcome: "applied" | "ignored" | "failed"; detail: string | null };

/**
 * Apply an event already recorded under its key (held as "received"), and write how it went. Shared by the webhook and by a replay from Partner issues, so both run the same rules under the
 * same once-only key. A throw is caught: the event is marked failed, its body kept, and nothing about the error that could carry data is stored.
 */
export async function runEvent(conn: PartnerConnection, event: NeutralEvent, eventKey: string, now: Date): Promise<RunOutcome> {
  const where = { provider_eventId: { provider: conn.provider, eventId: eventKey } };
  let applied = false;
  let detail: string | null = null;
  try {
    ({ applied, detail } = await applyEvent(conn, event, now));
  } catch (e) {
    const what = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? ` (${e.name})` : "";
    await prisma.partnerEvent.update({ where, data: { outcome: "failed", detail: `The desk could not apply it${what}. It can be tried again.` } });
    return { outcome: "failed", detail: null };
  }
  // The body is let go once the event has an outcome (D6: bodies are kept for failed events only).
  await prisma.partnerEvent.update({ where, data: { outcome: applied ? "applied" : "ignored", detail, payload: null } });
  if (applied) {
    await recordHealth(conn.workspaceId, conn.capability, conn.provider, { ok: true, data: null }, now);
    if (event.kind === "ping") await recordAudit({ entity: "partner", action: "partner_event", summary: `${conn.provider} reached the desk (test event)`, at: now, workspaceId: conn.workspaceId });
  }
  return { outcome: applied ? "applied" : "ignored", detail };
}

async function applyEvent(conn: PartnerConnection, event: NeutralEvent, now: Date): Promise<{ applied: boolean; detail: string | null }> {
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
    applied = await applyPayrollPaid(event.reference, now, conn.workspaceId, { via: "webhook" });
    if (!applied) detail = "No sent statements on that run.";
  } else if (event.kind === "payroll.rejected" && conn.capability === "payroll") {
    // The statement the refusal is for, when the company names one; otherwise the whole run.
    applied = await applyPayrollRejected(event.reference, now, conn.workspaceId, { statementIds: event.referenceId ? [event.referenceId] : null, reason: event.detail ?? null, via: "webhook" });
    if (!applied) detail = "No sent statements on that run.";
  } else if ((event.kind === "tracking.arrived" || event.kind === "tracking.departed") && conn.capability === "tracking") {
    applied = await applyTrackingMilestone({ reference: event.reference, stop: event.stop ?? null, kind: event.kind }, now, conn.workspaceId);
    if (!applied) detail = "No open load with that reference.";
  } else if (event.kind === "ping") {
    applied = true;
  }
  return { applied, detail };
}

