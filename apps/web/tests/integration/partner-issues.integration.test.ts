import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { HEADER_EVENT_ID } from "@/lib/webhook-sign";
import { connectPartner } from "@/server/partners/connections";
import { credentialKey, seal, unseal } from "@/server/partners/credentials-core";
import { resealCredentials } from "@/server/partners/credentials";
import { issueCount, listIssues, replayInbound, resolveIssue, retryDelivery, retrySync } from "@/server/partners/issues";
import { purgeOldDeliveries, purgeOldEvents } from "@/server/partners/retention";
import { handleWebhook } from "@/server/partners/webhook";
import { createEndpoint } from "@/server/webhooks/endpoints";
import type { Resolver, SendRequest, Transport } from "@/server/webhooks/transport";

/**
 * Money plan Wave 7 step 4 on the demo database: dead letters and Partner issues. An apply that throws is marked failed with its body kept and answered 500; the company's redelivery runs it
 * again (no longer "duplicate"), and so does Run again from the desk, each exactly once, never moving an invoice twice. An event naming an invoice the desk does not know is listed (no body:
 * D6) and runs when the company sends it again. Failed and dead webhook deliveries are sent again as the same event. Connections in error, stopped cursors and sign-ins running out are
 * listed. Everything is settled with a reason and audited, and retention never ages out an open issue. Key rotation now re-seals OAuth tokens too.
 */
const flags = vi.hoisted(() => ({ throwApply: false }));
vi.mock("@/server/partners/factoring", async (original) => {
  const real = await original<typeof import("@/server/partners/factoring")>();
  return {
    ...real,
    applyFactoringUpdate: async (...a: Parameters<typeof real.applyFactoringUpdate>) => {
      if (flags.throwApply) throw new TypeError("simulated failure");
      return real.applyFactoringUpdate(...a);
    }
  };
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "w7-issues";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "TRIUMPHPAY_API_KEY", "TRIUMPHPAY_WEBHOOK_SECRET", "DESK_AUTH"] as const;
const saved: Record<string, string | undefined> = {};
const WH = "whsec-issues-test";
const NOW = new Date("2026-11-13T18:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
let token = "";
let loadId = "";

const sign = (raw: string) => createHmac("sha256", WH).update(raw, "utf8").digest("hex");
const send = (id: string, type: string, extra: Record<string, unknown> = {}) => {
  const raw = JSON.stringify({ id, type, reference: "PI-INV-1", ...extra });
  return handleWebhook({ provider: "triumphpay", token, raw, signature: sign(raw), now: NOW });
};
const ev = (id: string) => prisma.partnerEvent.findFirstOrThrow({ where: { workspaceId: W, eventId: `${W}:${id}` } });
const status = async () => (await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus;

const resolver: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
let sent: SendRequest[] = [];
const transport: Transport = async (r) => {
  sent.push(r);
  return { ok: true, status: 200 };
};

async function wipe() {
  await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
  await prisma.assignment.deleteMany({ where: { load: { workspaceId: W } } });
  await prisma.workspace.deleteMany({ where: { id: W } });
}

describe.skipIf(!run)("Wave 7 step 4: dead letters and Partner issues", () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    process.env.TRIUMPHPAY_API_KEY = "live-factor-key";
    process.env.TRIUMPHPAY_WEBHOOK_SECRET = WH;
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "W7 issues", plan: "pro" } });
    expect(await connectPartner("factoring", "triumphpay", null, NOW, W)).toMatchObject({ ok: true });
    token = (await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "factoring" } })).webhookToken!;
    loadId = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "PI-1", status: "completed", completedAt: ago(3), quotedRevenue: 1000, paymentStatus: "invoiced", invoiceNumber: "PI-INV-1", invoicedAt: ago(2), invoicedAmount: 1000, factoringStatus: "requested" } })).id;
  });
  beforeEach(() => {
    flags.throwApply = false;
    sent = [];
  });
  afterAll(async () => {
    await wipe();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("an apply that throws is failed, its body kept, answered 500; the company's redelivery runs it again, once", async () => {
    flags.throwApply = true;
    const first = await send("e-fail", "factoring.submitted", { reference_id: "TP-1" });
    expect(first).toEqual({ status: 500, body: { ok: false, result: "failed", error: expect.any(String) } });
    const row = await ev("e-fail");
    expect(row).toMatchObject({ outcome: "failed", detail: "The desk could not apply it (TypeError). It can be tried again." });
    expect(row.payload).toContain('"e-fail"');
    expect(row.detail).not.toContain("simulated");
    expect(await status()).toBe("requested");
    const listed = await listIssues(W, NOW);
    expect(listed.inbound.map((e) => [e.kind, e.outcome, e.canReplay])).toEqual([["factoring.submitted", "failed", true]]);
    expect(await issueCount(W, NOW)).toBeGreaterThanOrEqual(1);

    flags.throwApply = false;
    expect((await send("e-fail", "factoring.submitted", { reference_id: "TP-1" })).body).toEqual({ ok: true, result: "applied" });
    expect(await status()).toBe("submitted");
    expect(await ev("e-fail")).toMatchObject({ outcome: "applied", payload: null });
    expect((await send("e-fail", "factoring.submitted")).body).toEqual({ ok: true, result: "duplicate" });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_updated" } })).toBe(1);
  });

  test("Run again from the desk: from the kept body, under the same key, once even when two people click, and never twice", async () => {
    flags.throwApply = true;
    expect((await send("e-replay", "factoring.funded")).status).toBe(500);
    flags.throwApply = false;
    const row = await ev("e-replay");
    const both = await Promise.all([replayInbound(row.id, "Chris", NOW, W), replayInbound(row.id, "Jacob", NOW, W)]);
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => r.ok)).toMatchObject({ ok: true, outcome: "applied" });
    expect(await status()).toBe("funded");
    expect(await replayInbound(row.id, "Chris", NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("applied already") });
    expect((await send("e-replay", "factoring.funded")).body).toEqual({ ok: true, result: "duplicate" });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_updated" } })).toBe(2);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_event_replayed" } })).toBe(1);
    // another fleet cannot replay it
    expect(await replayInbound(row.id, "Mallory", NOW, "someone-else")).toMatchObject({ ok: false });
  });

  test("an invoice the desk does not know: listed with no body kept (D6), runs when the company sends it again; a late step and the payroll poll are not issues", async () => {
    const raw = JSON.stringify({ id: "e-lost", type: "factoring.paid", reference: "PI-INV-2" });
    expect((await handleWebhook({ provider: "triumphpay", token, raw, signature: sign(raw), now: NOW })).body).toEqual({ ok: true, result: "ignored" });
    const lost = await ev("e-lost");
    expect(lost).toMatchObject({ outcome: "ignored", detail: "No invoice with that reference.", payload: null });
    expect(await replayInbound(lost.id, "Chris", NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("send it again") });
    // a late step (funded again after funded) is how events fall, not an issue
    expect((await send("e-late", "factoring.submitted")).body).toEqual({ ok: true, result: "ignored" });
    await prisma.partnerEvent.create({ data: { workspaceId: W, provider: "gusto", eventId: `${W}:poll:payroll.paid:RUN-1`, kind: "payroll.paid", outcome: "ignored", detail: "No invoice reference.", receivedAt: NOW } });
    expect((await listIssues(W, NOW)).inbound.map((e) => e.kind)).toEqual(["factoring.paid"]);
    // the invoice is made; the company sends the event again and it runs
    const l2 = await prisma.load.create({ data: { workspaceId: W, loadNumber: "PI-2", status: "completed", completedAt: ago(3), quotedRevenue: 500, paymentStatus: "invoiced", invoiceNumber: "PI-INV-2", invoicedAt: ago(2), invoicedAmount: 500, factoringStatus: "funded" } });
    expect((await handleWebhook({ provider: "triumphpay", token, raw, signature: sign(raw), now: NOW })).body).toEqual({ ok: true, result: "applied" });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l2.id } })).factoringStatus).toBe("paid");
    expect((await listIssues(W, NOW)).inbound).toEqual([]);
  });

  test("settling: resolved or dismissed with a reason, audited, gone from the list, and only once", async () => {
    flags.throwApply = true;
    await send("e-settle", "factoring.rejected");
    flags.throwApply = false;
    const row = await ev("e-settle");
    expect(await resolveIssue({ kind: "inbound", id: row.id, resolution: "dismissed", note: "no" }, "Chris", NOW, W)).toMatchObject({ ok: false });
    expect(await resolveIssue({ kind: "inbound", id: row.id, resolution: "dismissed", note: "The factor withdrew it by phone" }, "Chris", NOW, W)).toEqual({ ok: true });
    expect(await resolveIssue({ kind: "inbound", id: row.id, resolution: "resolved", note: "Again" }, "Chris", NOW, W)).toMatchObject({ ok: false });
    expect(await ev("e-settle")).toMatchObject({ resolution: "dismissed", resolvedBy: "Chris", resolutionNote: "The factor withdrew it by phone" });
    expect((await listIssues(W, NOW)).inbound).toEqual([]);
    expect(await replayInbound(row.id, "Chris", NOW, W)).toMatchObject({ ok: false, error: expect.stringContaining("settled") });
    // a settled event is not run again by a redelivery either
    expect((await send("e-settle", "factoring.rejected")).body).toEqual({ ok: true, result: "duplicate" });
    const audit = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "partner_issue_resolved" } });
    expect(audit.summary).toContain("dismissed by Chris: The factor withdrew it by phone");
  });

  test("webhooks not delivered: sent again as the same event, settled when they no longer matter, refused when their webhook is off", async () => {
    const ep = await createEndpoint({ url: "https://books.example.com/in", label: "Books", events: ["payment.applied"] }, "Chris", NOW, W, { resolver, production: true });
    if (!ep.ok) throw new Error(ep.error);
    const dead = await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: "evt_dead_1", type: "payment.applied", payload: { id: "evt_dead_1" }, status: "dead", attempts: 8, lastStatus: 500, nextAttemptAt: ago(1) } });
    const failed = await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: "evt_failed_1", type: "payment.applied", payload: { id: "evt_failed_1" }, status: "failed", attempts: 3, nextAttemptAt: NOW } });
    await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: "evt_test", type: "webhook.test", payload: {}, status: "dead", attempts: 1 } });
    expect((await listIssues(W, NOW)).outbound.map((d) => d.eventId).sort()).toEqual(["evt_dead_1", "evt_failed_1"]); // a failed test is not a money issue
    const out = await retryDelivery(dead.id, "Chris", NOW, W, { resolver, transport, production: true });
    expect(out).toEqual({ ok: true, delivered: true, status: "sent", error: null });
    expect(sent.map((r) => r.headers[HEADER_EVENT_ID])).toEqual(["evt_dead_1"]);
    expect(await retryDelivery(dead.id, "Chris", NOW, W, { resolver, transport })).toMatchObject({ ok: false, error: expect.stringContaining("went through") });
    expect(await resolveIssue({ kind: "outbound", id: failed.id, resolution: "dismissed", note: "Entered by hand in the books" }, "Chris", NOW, W)).toEqual({ ok: true });
    expect(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject({ status: "dead", resolution: "dismissed" });
    const another = await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: "evt_off", type: "payment.applied", payload: {}, status: "dead", attempts: 8 } });
    await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { active: false } });
    expect(await retryDelivery(another.id, "Chris", NOW, W, { resolver, transport })).toMatchObject({ ok: false, error: expect.stringContaining("switched off") });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "webhook_delivery_retried" } })).toBe(1);
  });

  test("connections in error, a stopped cursor, and sign-ins running out are listed; Try again now clears a connection, audited", async () => {
    await prisma.partnerConnection.updateMany({ where: { workspaceId: W, capability: "factoring" }, data: { status: "error", lastError: "TriumphPay did not answer.", failures: 3 } });
    await prisma.syncCursor.create({ data: { workspaceId: W, provider: "quickbooks", stream: "changes", lastRunAt: NOW, lastOkAt: ago(2), lastError: "QuickBooks refused the query." } });
    await prisma.partnerOAuthToken.create({ data: { workspaceId: W, provider: "quickbooks", accountId: "123", sealed: "v1.x.y.z", accessExpiresAt: NOW, refreshExpiresAt: new Date(NOW.getTime() + 5 * 86_400_000) } });
    const l = await listIssues(W, NOW);
    expect(l.syncs.map((s) => [s.provider, s.why])).toEqual([["triumphpay", "TriumphPay did not answer."], ["quickbooks", "changes: QuickBooks refused the query."]]);
    expect(l.signIns).toEqual([{ provider: "quickbooks", company: expect.any(String), expired: false, runsOutAt: expect.any(Date) }]);
    expect(await retrySync("factoring", "triumphpay", "Chris", NOW, W)).toEqual({ ok: true });
    expect((await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "factoring" } })).status).toBe("connected");
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_sync_retried" } })).toBe(1);
    await prisma.partnerOAuthToken.updateMany({ where: { workspaceId: W }, data: { status: "expired" } });
    expect((await listIssues(W, NOW)).signIns[0]).toMatchObject({ expired: true });
  });

  test("retention never ages out an open issue: failed and fixable events and dead deliveries stay until settled, then 90 days", async () => {
    const mk = (id: string, outcome: string, extra: Record<string, unknown> = {}) => prisma.partnerEvent.create({ data: { workspaceId: W, provider: "triumphpay", eventId: `${W}:old-${id}`, kind: "factoring.funded", outcome, receivedAt: ago(200), ...extra } });
    await mk("applied", "applied");
    await mk("late", "ignored", { detail: "Not an allowed step from where the invoice is." });
    await mk("failed", "failed", { payload: "{}" });
    await mk("fixable", "ignored", { detail: "No invoice with that reference." });
    await mk("settled-long", "failed", { resolvedAt: ago(120) });
    await mk("settled-recent", "failed", { resolvedAt: ago(10) });
    await purgeOldEvents(NOW);
    const left = (await prisma.partnerEvent.findMany({ where: { workspaceId: W, eventId: { startsWith: `${W}:old-` } } })).map((e) => e.eventId.replace(`${W}:old-`, "")).sort();
    expect(left).toEqual(["failed", "fixable", "settled-recent"]);

    const ep = await prisma.webhookEndpoint.findFirstOrThrow({ where: { workspaceId: W } });
    const dl = (id: string, extra: Record<string, unknown>) => prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ep.id, eventId: `old_${id}`, type: "payment.applied", payload: {}, createdAt: ago(200), ...extra } });
    await dl("sent", { status: "sent", sentAt: ago(150) });
    await dl("dead", { status: "dead", attempts: 8 });
    await dl("settled", { status: "dead", resolvedAt: ago(100) });
    await purgeOldDeliveries(NOW);
    expect((await prisma.webhookDelivery.findMany({ where: { workspaceId: W, eventId: { startsWith: "old_" } } })).map((d) => d.eventId)).toEqual(["old_dead"]);
  });

  test("a credential key rotation now re-seals OAuth sign-ins too", async () => {
    const oldKey = credentialKey(process.env)!;
    await prisma.partnerOAuthToken.updateMany({ where: { workspaceId: W }, data: { sealed: seal({ access_token: "a-tok", refresh_token: "r-tok" }, oldKey) } });
    process.env.DESK_CREDENTIAL_KEY_PREVIOUS = process.env.DESK_CREDENTIAL_KEY;
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    try {
      await resealCredentials();
      const row = await prisma.partnerOAuthToken.findFirstOrThrow({ where: { workspaceId: W } });
      expect(unseal(row.sealed, credentialKey(process.env)!)).toEqual({ access_token: "a-tok", refresh_token: "r-tok" });
      expect(unseal(row.sealed, oldKey)).toBeNull();
    } finally {
      delete process.env.DESK_CREDENTIAL_KEY_PREVIOUS;
    }
  });
});
