import { prisma } from "@/lib/db";
import { TEST_EVENT } from "@/lib/webhook-events";
import { recordAudit } from "@/server/tl/audit";
import { deliverDue, hostOf, type DeliverDeps } from "@/server/webhooks/deliver";
import { CAPABILITY_LABEL, type Capability } from "@/truelane/partners/contract";
import { providerName } from "./call";
import { partnerStatus, retryConnection } from "./connections";
import { FIXABLE_DETAILS, STUCK_MS, runEvent } from "./webhook";
import { readEvent } from "./webhook-core";

/**
 * Partner issues (docs/MONEY_PLAN.md, Wave 7 step 4): one screen for what went wrong between the desk and a company, kept in their own stores (D5):
 *   - inbound: a company's event the desk could not apply (failed: its body kept, so it can be run again here), one stuck part way, or one not used for a reason a person can fix (an
 *     invoice number it does not know: no body is kept (D6), so once it is fixed the company sends it again, which runs it again);
 *   - outbound: a webhook delivery that failed and is waiting, or gave up (dead);
 *   - syncs: a connection in error or overdue on its rhythm, a sync cursor that stopped on an error, a sign-in (OAuth) that has run out or runs out within 14 days.
 * Each can be tried again or settled (resolved, or dismissed with a reason). Trying again is safe by construction: an inbound replay runs under the event's own once-only key through the same
 * guarded functions a person uses (a funded invoice cannot be funded twice, a paid run cannot be paid twice, a payment is never written twice); an outbound retry sends the same row again,
 * the same event id and body, which a receiver dedupes on. Every action is audited. Every function takes the workspace explicitly.
 */
export const SIGN_IN_WARN_DAYS = 14;

const openInbound = (workspaceId: string, now: Date) => ({
  workspaceId,
  resolvedAt: null,
  // The payroll status check records its own outcomes (keys with :poll:); those are never issues.
  NOT: { eventId: { contains: ":poll:" } },
  OR: [{ outcome: "failed" }, { outcome: "ignored", detail: { in: [...FIXABLE_DETAILS] } }, { outcome: "received", attemptedAt: { lt: new Date(now.getTime() - STUCK_MS) } }]
});
const openOutbound = (workspaceId: string) => ({ workspaceId, resolvedAt: null, status: { in: ["failed", "dead"] }, type: { not: TEST_EVENT } });

export type InboundIssue = { id: string; provider: string; company: string; kind: string; outcome: string; detail: string | null; receivedAt: Date; attemptedAt: Date | null; canReplay: boolean };
export type OutboundIssue = { id: string; eventId: string; type: string; status: string; attempts: number; lastStatus: number | null; lastError: string | null; nextAttemptAt: Date; createdAt: Date; endpoint: string; endpointOn: boolean };
export type SyncIssue = { capability: Capability; provider: string; label: string; company: string; why: string; lastSyncedAt: Date | null; canRetry: boolean };
export type SignInIssue = { provider: string; company: string; expired: boolean; runsOutAt: Date | null };

export async function listIssues(workspaceId: string, now: Date = new Date()) {
  const [inbound, outbound, connections, cursors, tokens] = await Promise.all([
    prisma.partnerEvent.findMany({ where: openInbound(workspaceId, now), orderBy: [{ receivedAt: "desc" }, { id: "desc" }], take: 100, select: { id: true, provider: true, kind: true, outcome: true, detail: true, receivedAt: true, attemptedAt: true, payload: true } }),
    prisma.webhookDelivery.findMany({ where: openOutbound(workspaceId), orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 100, include: { endpoint: { select: { url: true, label: true, active: true, disabledAt: true } } } }),
    partnerStatus(workspaceId, now),
    prisma.syncCursor.findMany({ where: { workspaceId, lastError: { not: null } } }),
    prisma.partnerOAuthToken.findMany({ where: { workspaceId, OR: [{ status: "expired" }, { refreshExpiresAt: { lt: new Date(now.getTime() + SIGN_IN_WARN_DAYS * 86_400_000) } }] }, select: { provider: true, status: true, refreshExpiresAt: true } })
  ]);
  const syncs: SyncIssue[] = [];
  for (const c of connections) {
    if (c.status === "error") syncs.push({ capability: c.capability, provider: c.provider, label: c.label, company: c.name, why: c.lastError ?? `${c.failures} calls in a row failed.`, lastSyncedAt: c.lastSyncedAt, canRetry: true });
    else if (c.overdue) syncs.push({ capability: c.capability, provider: c.provider, label: c.label, company: c.name, why: `Overdue: no answer on its rhythm (${c.rhythm})`, lastSyncedAt: c.lastSyncedAt, canRetry: true });
  }
  for (const s of cursors) {
    // A cursor whose last run went fine after its error is not an issue any more.
    if (s.lastOkAt && s.lastRunAt && s.lastOkAt >= s.lastRunAt) continue;
    const cap = connections.find((c) => c.provider === s.provider);
    if (cap && syncs.some((x) => x.provider === s.provider)) continue;
    syncs.push({ capability: (cap?.capability ?? "accounting") as Capability, provider: s.provider, label: cap?.label ?? s.provider, company: providerName(s.provider), why: `${s.stream}: ${s.lastError}`, lastSyncedAt: s.lastOkAt, canRetry: cap?.status === "connected" || cap?.status === "error" });
  }
  return {
    inbound: inbound.map((e): InboundIssue => ({ id: e.id, provider: e.provider, company: providerName(e.provider), kind: e.kind, outcome: e.outcome, detail: e.detail, receivedAt: e.receivedAt, attemptedAt: e.attemptedAt, canReplay: e.payload != null })),
    outbound: outbound.map((d): OutboundIssue => ({ id: d.id, eventId: d.eventId, type: d.type, status: d.status, attempts: d.attempts, lastStatus: d.lastStatus, lastError: d.lastError, nextAttemptAt: d.nextAttemptAt, createdAt: d.createdAt, endpoint: d.endpoint.label || hostOf(d.endpoint.url), endpointOn: d.endpoint.active && !d.endpoint.disabledAt })),
    syncs,
    signIns: tokens.map((t): SignInIssue => ({ provider: t.provider, company: providerName(t.provider), expired: t.status === "expired" || (t.refreshExpiresAt != null && t.refreshExpiresAt <= now), runsOutAt: t.refreshExpiresAt }))
  };
}

/** How many open issues, for the sidebar. Cheap counts only. */
export async function issueCount(workspaceId: string, now: Date = new Date()): Promise<number> {
  const [a, b, c, d] = await Promise.all([
    prisma.partnerEvent.count({ where: openInbound(workspaceId, now) }),
    prisma.webhookDelivery.count({ where: openOutbound(workspaceId) }),
    prisma.partnerConnection.count({ where: { workspaceId, status: "error" } }),
    prisma.partnerOAuthToken.count({ where: { workspaceId, OR: [{ status: "expired" }, { refreshExpiresAt: { lt: new Date(now.getTime() + SIGN_IN_WARN_DAYS * 86_400_000) } }] } })
  ]);
  return a + b + c + d;
}

const nameOf = (who: string) => who.trim().slice(0, 120) || "Admin";
const cleanNote = (raw: unknown) => (typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 300) : "");

export type ReplayResult = { ok: true; outcome: "applied" | "ignored" | "failed"; detail: string | null } | { ok: false; error: string };

/** Run a kept inbound event again, from its verified body, under its own key. Taken over in one step from the state it was read in, so two clicks (or a click and a redelivery) run it once. */
export async function replayInbound(id: string, who: string, now: Date, workspaceId: string): Promise<ReplayResult> {
  const row = await prisma.partnerEvent.findFirst({ where: { id, workspaceId } });
  if (!row) return { ok: false, error: "That event does not exist." };
  if (row.resolvedAt) return { ok: false, error: "That event was settled already." };
  if (row.outcome === "applied") return { ok: false, error: "That event has applied already: there is nothing to run again." };
  if (!row.payload) return { ok: false, error: "The desk keeps a company's event only when applying it failed, so this one cannot be run from here. Fix the cause, then ask the company to send it again." };
  const stuck = row.outcome === "received" && row.attemptedAt != null && row.attemptedAt.getTime() < now.getTime() - STUCK_MS;
  if (row.outcome !== "failed" && !stuck) return { ok: false, error: "That event is being applied right now. Reload in a moment." };
  const conn = await prisma.partnerConnection.findFirst({ where: { workspaceId, provider: row.provider, status: { in: ["connected", "error"] } } });
  if (!conn) return { ok: false, error: `${providerName(row.provider)} is not connected any more. Connect it again first.` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return { ok: false, error: "The kept body cannot be read." };
  }
  const event = readEvent(row.provider, parsed, row.payload);
  if (!event) return { ok: false, error: "The kept body is not an event the desk understands." };
  const claimed = await prisma.partnerEvent.updateMany({ where: { id: row.id, outcome: row.outcome, attemptedAt: row.attemptedAt, resolvedAt: null }, data: { outcome: "received", attemptedAt: now } });
  if (claimed.count !== 1) return { ok: false, error: "That event was just tried again by someone (or by the company). Reload." };
  const out = await runEvent(conn, event, row.eventId, now);
  await recordAudit({ entity: "partner", entityId: row.id, action: "partner_event_replayed", summary: `${providerName(row.provider)} event ${row.kind} run again by ${nameOf(who)}: ${out.outcome}${out.detail ? ` (${out.detail})` : ""}`, before: { Event: row.outcome }, after: { Event: out.outcome }, at: now, workspaceId });
  return { ok: true, ...out };
}

export type RetryResult = { ok: true; delivered: boolean; status: string; error: string | null } | { ok: false; error: string };

/** Send a failed or dead delivery again now: the same row, event id and body, a new signature. Its schedule starts over. */
export async function retryDelivery(id: string, who: string, now: Date, workspaceId: string, deps: DeliverDeps = {}): Promise<RetryResult> {
  const row = await prisma.webhookDelivery.findFirst({ where: { id, workspaceId }, include: { endpoint: true } });
  if (!row) return { ok: false, error: "That delivery does not exist." };
  if (row.resolvedAt) return { ok: false, error: "That delivery was settled already." };
  if (row.status !== "failed" && row.status !== "dead") return { ok: false, error: row.status === "sent" ? "That delivery went through already." : "That delivery is waiting to be sent already." };
  if (!row.endpoint.active || row.endpoint.disabledAt) return { ok: false, error: "Its webhook is switched off. Switch it on in Settings first." };
  const claimed = await prisma.webhookDelivery.updateMany({ where: { id, status: row.status, attempts: row.attempts, resolvedAt: null, OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] }, data: { status: "pending", attempts: 0, nextAttemptAt: now, leaseUntil: null } });
  if (claimed.count !== 1) return { ok: false, error: "That delivery is being sent right now. Reload in a moment." };
  await recordAudit({ entity: "partner", entityId: id, action: "webhook_delivery_retried", summary: `Webhook ${row.type} (${row.eventId}) to ${hostOf(row.endpoint.url)} sent again by ${nameOf(who)}`, before: { Delivery: row.status }, after: { Delivery: "Sent again" }, at: now, workspaceId });
  await deliverDue({ ...deps, now, only: id, limit: 1 });
  const after = await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } });
  return { ok: true, delivered: after.status === "sent", status: after.status, error: after.lastError };
}

/** Try a stalled connection again now: its failures are cleared and the schedule asks at once (the same as Try again in Settings), audited. */
export async function retrySync(capability: string, provider: string, who: string, now: Date, workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const out = await retryConnection(capability, provider, now, workspaceId);
  if (!out.ok) return out;
  await recordAudit({ entity: "partner", action: "partner_sync_retried", summary: `${providerName(provider)} (${(CAPABILITY_LABEL[capability as Capability] ?? capability).toLowerCase()}) asked again by ${nameOf(who)}`, at: now, workspaceId });
  return { ok: true };
}

export type ResolveInput = { kind: "inbound" | "outbound"; id: string; resolution: "resolved" | "dismissed"; note: unknown };

/** Settle an issue: resolved (it was fixed another way) or dismissed (it does not matter), always with a word of why. A settled issue leaves the screen and is kept 90 days. */
export async function resolveIssue(i: ResolveInput, who: string, now: Date, workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const note = cleanNote(i.note);
  if (note.length < 3) return { ok: false, error: "Say in a few words why it is settled: it goes in the audit trail." };
  if (i.resolution !== "resolved" && i.resolution !== "dismissed") return { ok: false, error: "Choose resolved or dismissed." };
  const name = nameOf(who);
  const data = { resolvedAt: now, resolvedBy: name, resolution: i.resolution, resolutionNote: note };
  return prisma.$transaction(async (tx) => {
    let what: string;
    if (i.kind === "inbound") {
      const row = await tx.partnerEvent.findFirst({ where: { id: i.id, workspaceId } });
      if (!row) return { ok: false as const, error: "That event does not exist." };
      const out = await tx.partnerEvent.updateMany({ where: { id: i.id, workspaceId, resolvedAt: null, outcome: { not: "applied" } }, data });
      if (out.count !== 1) return { ok: false as const, error: "That event was settled or applied already." };
      what = `${providerName(row.provider)} event ${row.kind}`;
    } else {
      const row = await tx.webhookDelivery.findFirst({ where: { id: i.id, workspaceId }, include: { endpoint: { select: { url: true } } } });
      if (!row) return { ok: false as const, error: "That delivery does not exist." };
      const out = await tx.webhookDelivery.updateMany({ where: { id: i.id, workspaceId, resolvedAt: null, status: { in: ["failed", "dead"] } }, data: i.resolution === "dismissed" && row.status === "failed" ? { ...data, status: "dead" } : data });
      if (out.count !== 1) return { ok: false as const, error: "That delivery was settled or sent already." };
      what = `Webhook ${row.type} (${row.eventId}) to ${hostOf(row.endpoint.url)}`;
    }
    await recordAudit({ entity: "partner", entityId: i.id, action: "partner_issue_resolved", summary: `${what} ${i.resolution} by ${name}: ${note}`, reason: note, after: { Issue: i.resolution === "resolved" ? "Resolved" : "Dismissed" }, at: now, workspaceId }, tx);
    return { ok: true as const };
  });
}
