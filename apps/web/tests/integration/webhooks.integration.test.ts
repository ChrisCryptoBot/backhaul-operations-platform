import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { HEADER_EVENT_ID, HEADER_SIGNATURE, HEADER_TIMESTAMP, verifySignatureHeader } from "@/lib/webhook-sign";
import { resealCredentials } from "@/server/partners/credentials";
import { addInvoicePayment, createInvoiceRecord } from "@/server/tl/invoice-records";
import { invoiceLoad, issueCreditMemo, markLoadPaid, undoPaid, voidCreditMemo, voidInvoice } from "@/server/tl/invoicing";
import { finalizeSettlement, startSettlement, voidSettlement } from "@/server/tl/settlement";
import { deliverDue } from "@/server/webhooks/deliver";
import { createEndpoint, rotateEndpointSecret, sendTestEvent, setEndpointActive } from "@/server/webhooks/endpoints";
import type { Resolver, SendRequest, Transport } from "@/server/webhooks/transport";

/**
 * Money plan Wave 7 step 3 on the demo database: outbound signed webhooks end to end, in workspaces of their own. Every money write queues exactly one row per endpoint that takes the event,
 * in its own transaction (a rolled-back write queues none); the schedule claims each due row once even when two runs overlap; a delivery is signed so the documented recipe verifies it,
 * and a retry carries the same event id and body with a new timestamp; the eighth failure is dead and three dead in a row switch the endpoint off; private addresses are refused at
 * creation and again at send time (a name that changes its answer); Starter has no webhooks. No network: the resolver and the transport are stand-ins.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "w7-hooks";
const ST = "w7-hooks-starter";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_CREDENTIAL_KEY_PREVIOUS", "DESK_AUTH"] as const;
const saved: Record<string, string | undefined> = {};
const NOW = new Date("2026-11-13T18:00:00.000Z");
const later = (mins: number) => new Date(NOW.getTime() + mins * 60_000);
const FORM = { terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" };

const PUBLIC = "93.184.216.34";
let answers: Record<string, string[]> = {};
const resolver: Resolver = async (host) => (answers[host] ?? [PUBLIC]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
let sent: SendRequest[] = [];
let answer = 200;
let delayMs = 0;
const transport: Transport = async (r) => {
  if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
  sent.push(r);
  return { ok: true, status: answer };
};
const deps = { resolver, transport, production: true };
const ids: Record<string, string> = {};
const secrets: Record<string, string> = {};

// In the order they were written (ids are made in order; some paths stamp the event with the real clock, others with the test's).
const rows = (where: object = {}) => prisma.webhookDelivery.findMany({ where: { workspaceId: W, ...where }, orderBy: { id: "asc" } });

async function wipe() {
  for (const id of [W, ST]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.driverLedgerEntry.deleteMany({ where: { workspaceId: id } });
    await prisma.settlement.deleteMany({ where: { workspaceId: id } });
    await prisma.assignment.deleteMany({ where: { load: { workspaceId: id } } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
}

describe.skipIf(!run)("Wave 7 step 3: outbound signed webhooks", () => {
  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    await wipe();
    await prisma.workspace.create({ data: { id: W, name: "W7 hooks", plan: "pro" } });
    await prisma.workspace.create({ data: { id: ST, name: "W7 hooks starter" } });
    const all = await createEndpoint({ url: "https://books.example.com/hooks/truelane", label: "Books", events: ["invoice.created", "invoice.voided", "credit_memo.created", "credit_memo.voided", "payment.applied", "payment.reversed", "statement.finalized", "statement.voided"] }, "Chris", NOW, W, deps);
    const pay = await createEndpoint({ url: "https://factor.example.com/in", label: "Payments only", events: ["payment.applied"] }, "Chris", NOW, W, deps);
    if (!all.ok || !pay.ok) throw new Error("endpoints");
    ids.all = all.id;
    ids.pay = pay.id;
    secrets.all = all.secret;
    secrets.pay = pay.secret;
  });
  beforeEach(() => {
    sent = [];
    answer = 200;
    delayMs = 0;
    answers = {};
  });
  afterAll(async () => {
    await wipe();
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("making an address: Pro only, https only, never a private address, and the secret is shown once and kept sealed", async () => {
    expect(secrets.all).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.all } });
    expect(row.sealedSecret).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain(secrets.all!.slice(6));
    expect(row.secretLast4).toBe(secrets.all!.slice(-4));
    expect(await createEndpoint({ url: "https://x.example.com/", label: "", events: ["invoice.created"] }, "Chris", NOW, ST, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Pro plan") });
    expect(await createEndpoint({ url: "http://x.example.com/", label: "", events: ["invoice.created"] }, "Chris", NOW, W, deps)).toMatchObject({ ok: false, error: expect.stringContaining("https") });
    expect(await createEndpoint({ url: "https://169.254.169.254/latest", label: "", events: ["invoice.created"] }, "Chris", NOW, W, deps)).toMatchObject({ ok: false, error: expect.stringContaining("private") });
    answers["sneaky.example.com"] = [PUBLIC, "10.0.0.5"];
    expect(await createEndpoint({ url: "https://sneaky.example.com/", label: "", events: ["invoice.created"] }, "Chris", NOW, W, deps)).toMatchObject({ ok: false, error: expect.stringContaining("private") });
    answers["mapped.example.com"] = ["::ffff:127.0.0.1"];
    expect(await createEndpoint({ url: "https://mapped.example.com/", label: "", events: ["invoice.created"] }, "Chris", NOW, W, deps)).toMatchObject({ ok: false });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "webhook_endpoint_created" } })).toBe(2);
  });

  test("a money write queues one row per endpoint that takes the event, in its transaction; a rolled-back write queues none", async () => {
    const before = (await rows()).length;
    const invoiceId = await prisma.$transaction((tx) => createInvoiceRecord(tx, { workspaceId: W, number: "WH-1", issuedAt: NOW, termsDays: 30, billTo: { name: "Broker Co", mc: "MC9", email: "ap@broker.example", phone: "555-0199" }, lines: [{ loadId: null, label: "Line haul", amount: 1500.5 }], loadIds: [] }));
    const made = await rows({ type: "invoice.created" });
    expect(made).toHaveLength(1);
    expect(made[0]!.endpointId).toBe(ids.all);
    const data = (made[0]!.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ object: "invoice", id: invoiceId, number: "WH-1", total: "1500.50", paid_total: "0.00", bill_to: { name: "Broker Co", mc: "MC9" }, issued_at: NOW.toISOString() });
    expect(JSON.stringify(made[0]!.payload)).not.toMatch(/ap@broker|555-0199/);

    await prisma.$transaction((tx) => addInvoicePayment(tx, { workspaceId: W, invoiceId, amount: 500, paidAt: NOW, method: "ach", note: "private note" }));
    const paid = await rows({ type: "payment.applied" });
    expect(paid.map((r) => r.endpointId).sort()).toEqual([ids.all, ids.pay].sort());
    expect(new Set(paid.map((r) => r.eventId)).size).toBe(1); // one event, told to both
    expect((paid[0]!.payload as { data: Record<string, unknown> }).data).toMatchObject({ object: "payment", amount: "500.00", method: "ach", source: "desk" });
    expect(JSON.stringify(paid[0]!.payload)).not.toContain("private note");

    const count = (await rows()).length;
    await expect(
      prisma.$transaction(async (tx) => {
        await createInvoiceRecord(tx, { workspaceId: W, number: "WH-ROLLBACK", issuedAt: NOW, termsDays: 30, billTo: { name: null, mc: null, email: null, phone: null }, lines: [{ loadId: null, label: "x", amount: 1 }], loadIds: [] });
        throw new Error("the money write failed");
      })
    ).rejects.toThrow();
    expect((await rows()).length).toBe(count);
    expect(await prisma.invoice.count({ where: { workspaceId: W, number: "WH-ROLLBACK" } })).toBe(0);
    expect(count).toBe(before + 3);
  });

  test("the real paths: invoice, payment, undo, credit memo and its void, invoice void, statement finalized and voided, each queue their event", async () => {
    await prisma.webhookDelivery.deleteMany({ where: { workspaceId: W } });
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "WH-L1", brokerName: "Acme", status: "completed", completedAt: NOW, quotedRevenue: 2000, podNote: "Signed" } });
    expect(await invoiceLoad(l.id, { form: { ...FORM, number: "WHINV-1" } }, NOW, W)).toMatchObject({ ok: true });
    expect(await markLoadPaid(l.id, NOW, { amount: 500, source: "desk", shortAction: "balance" } as never, W)).toMatchObject({ ok: true });
    expect(await undoPaid(l.id, "Entered twice", NOW, W)).toMatchObject({ ok: true });
    expect(await issueCreditMemo(l.id, { amount: 200, reason: "Late delivery" }, NOW, W)).toMatchObject({ ok: true });
    const memo = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, kind: "credit_memo" } });
    expect(await voidCreditMemo(memo.id, "Credited in error", NOW, W)).toMatchObject({ ok: true });
    expect(await voidInvoice(l.id, "Billed the wrong broker", NOW, W)).toMatchObject({ ok: true });

    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Private Driver", phone: "555-0111", payrollWorkerType: "contractor" } });
    await prisma.load.create({ data: { workspaceId: W, loadNumber: "WH-L2", status: "completed", completedAt: new Date("2026-10-07T17:00:00Z"), quotedRevenue: 1000, loadedMiles: 400, assignment: { create: { driverId: driver.id, payKind: "cpm", payRate: 0.5, status: "completed" } } } });
    const s = await startSettlement({ driverId: driver.id, start: "2026-10-05", end: "2026-10-11" }, NOW, W);
    if (!s.ok) throw new Error("no statement");
    expect(await finalizeSettlement(s.id, { hours: {}, adjustments: [] }, NOW, W)).toMatchObject({ ok: true });
    expect(await voidSettlement(s.id, "Wrong week", NOW, W)).toMatchObject({ ok: true });

    const toAll = (await rows({ endpointId: ids.all })).map((r) => r.type);
    expect(toAll).toEqual(["invoice.created", "payment.applied", "payment.reversed", "credit_memo.created", "payment.applied", "credit_memo.voided", "payment.reversed", "invoice.voided", "statement.finalized", "statement.voided"]);
    expect((await rows({ endpointId: ids.pay })).map((r) => r.type)).toEqual(["payment.applied", "payment.applied"]);
    const stmt = (await rows({ type: "statement.finalized" }))[0]!;
    expect((stmt.payload as { data: Record<string, unknown> }).data).toMatchObject({ object: "settlement", driver_id: driver.id, status: "final", total: "200.00" });
    const everything = JSON.stringify((await rows()).map((r) => r.payload));
    for (const secret of ["Private Driver", "555-0111"]) expect(everything, secret).not.toContain(secret);
    const memoEvt = (await rows({ type: "credit_memo.created" }))[0]!;
    expect((memoEvt.payload as { data: Record<string, unknown> }).data).toMatchObject({ object: "credit_memo", total: "-200.00", credit_of: expect.any(String) });
  });

  test("delivery: signed so the documented recipe verifies it, sent to the one checked address, the body the same as queued", async () => {
    const due = await rows({ status: "pending" });
    // later than every row's first try (some were stamped with the real clock)
    const AT = new Date(Math.max(Date.now(), NOW.getTime()) + 60_000);
    const sec = (AT.getTime() - (AT.getTime() % 1000)) / 1000;
    const out = await deliverDue({ ...deps, now: AT });
    expect(out).toMatchObject({ claimed: due.length, sent: due.length, failed: 0 });
    expect(sent).toHaveLength(due.length);
    for (const r of sent) {
      expect(r.address).toBe(PUBLIC);
      const row = due.find((d) => d.eventId === r.headers[HEADER_EVENT_ID] && r.url.host === new URL(d.endpointId === ids.all ? "https://books.example.com" : "https://factor.example.com").host)!;
      expect(row).toBeTruthy();
      expect(r.body).toBe(JSON.stringify(row.payload));
      expect(r.headers[HEADER_TIMESTAMP]).toBe(String(sec));
      const secret = row.endpointId === ids.all ? secrets.all! : secrets.pay!;
      expect(verifySignatureHeader(r.headers[HEADER_SIGNATURE]!, secret, r.body, sec)).toBe(true);
      expect(verifySignatureHeader(r.headers[HEADER_SIGNATURE]!, secret === secrets.all ? secrets.pay! : secrets.all!, r.body, sec)).toBe(false);
    }
    expect((await rows({ status: "sent" })).length).toBe(due.length);
    // nothing left to send: a second run claims nothing
    expect(await deliverDue({ ...deps, now: AT })).toMatchObject({ claimed: 0 });
  });

  test("two schedule runs at once deliver each due row exactly once", async () => {
    await prisma.webhookDelivery.deleteMany({ where: { workspaceId: W } });
    await prisma.webhookDelivery.createMany({ data: Array.from({ length: 24 }, (_, i) => ({ workspaceId: W, endpointId: ids.all!, eventId: `evt_race_${String(i).padStart(2, "0")}`, type: "payment.applied", payload: { id: `evt_race_${i}` }, nextAttemptAt: NOW })) });
    delayMs = 15;
    const [a, b] = await Promise.all([deliverDue({ ...deps, now: NOW, limit: 50 }), deliverDue({ ...deps, now: NOW, limit: 50 })]);
    expect(a.claimed + b.claimed).toBe(24);
    const told = sent.map((r) => r.headers[HEADER_EVENT_ID]);
    expect(told).toHaveLength(24);
    expect(new Set(told).size).toBe(24);
    expect((await rows({ status: "sent" })).length).toBe(24);
  });

  test("retries keep the event and its body, sign afresh, wait 5 then 15 minutes; the eighth failure is dead; three dead in a row switch the endpoint off", async () => {
    await prisma.webhookDelivery.deleteMany({ where: { workspaceId: W } });
    answer = 503;
    await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ids.all!, eventId: "evt_retry", type: "invoice.created", payload: { id: "evt_retry", data: { n: 1 } }, nextAttemptAt: NOW } });
    expect(await deliverDue({ ...deps, now: NOW })).toMatchObject({ failed: 1 });
    let r = (await rows())[0]!;
    expect(r).toMatchObject({ status: "failed", attempts: 1, lastStatus: 503, nextAttemptAt: later(5) });
    expect(await deliverDue({ ...deps, now: later(4) })).toMatchObject({ claimed: 0 }); // not yet
    expect(await deliverDue({ ...deps, now: later(5) })).toMatchObject({ failed: 1 });
    r = (await rows())[0]!;
    expect(r).toMatchObject({ attempts: 2, nextAttemptAt: later(20) });
    expect(sent).toHaveLength(2);
    expect(sent[0]!.headers[HEADER_EVENT_ID]).toBe("evt_retry");
    expect(sent[1]!.headers[HEADER_EVENT_ID]).toBe("evt_retry");
    expect(sent[1]!.body).toBe(sent[0]!.body);
    expect(sent[1]!.headers[HEADER_TIMESTAMP]).not.toBe(sent[0]!.headers[HEADER_TIMESTAMP]);
    expect(sent[1]!.headers[HEADER_SIGNATURE]).not.toBe(sent[0]!.headers[HEADER_SIGNATURE]);
    // a redirect is a failure, not followed
    answer = 302;
    await prisma.webhookDelivery.update({ where: { id: r.id }, data: { nextAttemptAt: NOW } });
    await deliverDue({ ...deps, now: NOW });
    expect((await rows())[0]).toMatchObject({ attempts: 3, lastStatus: 302, lastError: expect.stringContaining("redirect") });

    // the eighth failure
    answer = 500;
    await prisma.webhookDelivery.update({ where: { id: r.id }, data: { attempts: 7, nextAttemptAt: NOW } });
    expect(await deliverDue({ ...deps, now: NOW })).toMatchObject({ dead: 1 });
    expect((await rows())[0]).toMatchObject({ status: "dead", attempts: 8 });
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.all } })).deadInARow).toBe(1);
    for (const n of [2, 3]) await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ids.all!, eventId: `evt_dead_${n}`, type: "invoice.created", payload: { id: n }, attempts: 7, status: "failed", nextAttemptAt: NOW } });
    const out = await deliverDue({ ...deps, now: NOW });
    expect(out).toMatchObject({ dead: 1, disabled: 1 });
    const ep = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.all } });
    expect(ep.deadInARow).toBe(3);
    expect(ep.disabledAt).not.toBeNull();
    const auto = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "webhook_endpoint_switched" } });
    expect(auto.actor).toBe("TrueLane");
    // switched off: no new event is queued for it, and nothing pending for it is sent
    await prisma.$transaction((tx) => createInvoiceRecord(tx, { workspaceId: W, number: "WH-OFF", issuedAt: NOW, termsDays: 0, billTo: { name: null, mc: null, email: null, phone: null }, lines: [{ loadId: null, label: "x", amount: 1 }], loadIds: [] }));
    expect(await prisma.webhookDelivery.count({ where: { endpointId: ids.all, type: "invoice.created", status: "pending" } })).toBe(0);
    // an admin switches it back on: a clean count
    expect(await setEndpointActive(ids.all!, true, "Chris", NOW, W)).toEqual({ ok: true, changed: true });
    expect(await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.all } })).toMatchObject({ deadInARow: 0, disabledAt: null, active: true });
  });

  test("an address checked again at every send: a name that now answers privately is refused, and the transport is never called", async () => {
    await prisma.webhookDelivery.deleteMany({ where: { workspaceId: W } });
    await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ids.pay!, eventId: "evt_rebind", type: "payment.applied", payload: { id: "evt_rebind" }, nextAttemptAt: NOW } });
    answers["factor.example.com"] = ["169.254.169.254"];
    expect(await deliverDue({ ...deps, now: NOW })).toMatchObject({ failed: 1 });
    expect(sent).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: "failed", lastStatus: null, lastError: expect.stringContaining("private network") });
  });

  test("a test event: delivered at once, never counted against the endpoint; a new secret works and the old one stops", async () => {
    const t = await sendTestEvent(ids.pay!, "Chris", NOW, W, deps);
    expect(t).toEqual({ ok: true, delivered: true, status: 200, error: null });
    answer = 500;
    const bad = await sendTestEvent(ids.pay!, "Chris", NOW, W, deps);
    expect(bad).toMatchObject({ ok: true, delivered: false, status: 500 });
    expect((await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.pay } })).deadInARow).toBe(0);
    answer = 200;
    const rot = await rotateEndpointSecret(ids.pay!, "Chris", NOW, W);
    if (!rot.ok) throw new Error("rotate");
    sent = [];
    await sendTestEvent(ids.pay!, "Chris", NOW, W, deps);
    const r = sent[0]!;
    expect(verifySignatureHeader(r.headers[HEADER_SIGNATURE]!, rot.secret, r.body, NOW.getTime() / 1000)).toBe(true);
    expect(verifySignatureHeader(r.headers[HEADER_SIGNATURE]!, secrets.pay!, r.body, NOW.getTime() / 1000)).toBe(false);
    secrets.pay = rot.secret;
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "webhook_test_sent" } })).toBe(3);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "webhook_secret_rotated" } })).toBe(1);
  });

  test("Starter: no webhooks. A fleet moved below Pro queues nothing and its waiting rows are put back without counting an attempt", async () => {
    await prisma.webhookDelivery.deleteMany({ where: { workspaceId: W } });
    await prisma.webhookDelivery.create({ data: { workspaceId: W, endpointId: ids.pay!, eventId: "evt_plan", type: "payment.applied", payload: { id: "evt_plan" }, nextAttemptAt: NOW } });
    await prisma.workspace.update({ where: { id: W }, data: { plan: "growth" } });
    const inv = await prisma.invoice.findFirstOrThrow({ where: { workspaceId: W, number: "WH-1" } });
    await prisma.$transaction((tx) => addInvoicePayment(tx, { workspaceId: W, invoiceId: inv.id, amount: 1, paidAt: NOW, method: "ach" }));
    expect(await prisma.webhookDelivery.count({ where: { workspaceId: W } })).toBe(1);
    expect(await deliverDue({ ...deps, now: NOW })).toMatchObject({ skipped: 1 });
    expect(sent).toHaveLength(0);
    expect((await rows())[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(await sendTestEvent(ids.pay!, "Chris", NOW, W, deps)).toMatchObject({ ok: false, error: expect.stringContaining("Pro plan") });
    expect(await setEndpointActive(ids.pay!, false, "Chris", NOW, W)).toEqual({ ok: true, changed: true }); // switching off is always allowed
    expect(await setEndpointActive(ids.pay!, true, "Chris", NOW, W)).toMatchObject({ ok: false });
    await prisma.workspace.update({ where: { id: W }, data: { plan: "pro" } });
    await setEndpointActive(ids.pay!, true, "Chris", NOW, W);
  });

  test("a credential key rotation re-seals the signing secrets, and deliveries still verify", async () => {
    const old = process.env.DESK_CREDENTIAL_KEY!;
    process.env.DESK_CREDENTIAL_KEY_PREVIOUS = old;
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    try {
      const before = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.pay } });
      const r = await resealCredentials();
      expect(r.resealed).toBeGreaterThanOrEqual(2);
      const after = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id: ids.pay } });
      expect(after.sealedSecret).not.toBe(before.sealedSecret);
      delete process.env.DESK_CREDENTIAL_KEY_PREVIOUS;
      sent = [];
      await sendTestEvent(ids.pay!, "Chris", NOW, W, deps);
      expect(verifySignatureHeader(sent[0]!.headers[HEADER_SIGNATURE]!, secrets.pay!, sent[0]!.body, NOW.getTime() / 1000)).toBe(true);
    } finally {
      delete process.env.DESK_CREDENTIAL_KEY_PREVIOUS;
    }
  });
});
