import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as webhookRoute } from "@/app/(public)/partners/webhook/[provider]/[token]/route";
import { prisma } from "@/lib/db";
import { sandboxFactoringEvent } from "@/server/partners/adapters/triumphpay";
import { callPartner } from "@/server/partners/call";
import { partnerStatus, webhookPath } from "@/server/partners/connections";
import { factorInvoice } from "@/server/partners/factoring";
import { saveKeysAndConnect } from "@/server/partners/setup";
import { runPartnerSync } from "@/server/partners/sync";
import { syncEld } from "@/server/partners/eld";
import { sendTestEvent } from "@/server/partners/test-event";

/**
 * The partner pipeline end to end on the built-in simulator, with no company chosen and no network:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/partner-sandbox.integration.test.ts
 * `fetch` is replaced for the whole file by something that fails the test if it is ever called.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "pb-sandbox";
const OTHER = "pb-sandbox-other";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX", "MOTIVE_API_KEY", "MOTIVE_WEBHOOK_SECRET", "TRIUMPHPAY_API_KEY", "TRIUMPHPAY_WEBHOOK_SECRET"];
const saved: Record<string, string | undefined> = {};
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe.skipIf(!run)("the partner pipeline on the sandbox simulator", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("the desk tried to reach the network");
  });
  const realFetch = globalThis.fetch;
  const WH_SECRET = "sandbox_whsec_pipeline_test";
  let truck1 = "";
  let truck2 = "";
  let driver1 = "";
  let driver2 = "";
  let loadId = "";

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const id of [W, OTHER]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    }
    truck1 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 101", type: "dry_van" } })).id;
    truck2 = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 102", type: "dry_van" } })).id;
    driver1 = (await prisma.driver.create({ data: { workspaceId: W, name: "Alex Rivera", assignedVehicleId: truck1 } })).id;
    driver2 = (await prisma.driver.create({ data: { workspaceId: W, name: "Casey Brooks", assignedVehicleId: truck2 } })).id;
    // Another fleet's truck and driver, which no sync of this fleet may touch.
    const otherTruck = await prisma.vehicle.create({ data: { workspaceId: OTHER, name: "Unit 101", type: "dry_van" } });
    await prisma.driver.create({ data: { workspaceId: OTHER, name: "Alex Rivera", assignedVehicleId: otherTruck.id } });
    const stops = { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: days(-5), timeWindowLatest: days(-5) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Atlanta, GA", timeWindowEarliest: days(-4), timeWindowLatest: days(-4) }] };
    loadId = (await prisma.load.create({ data: { workspaceId: W, loadNumber: "SBX-L1", status: "completed", completedAt: days(-3), quotedRevenue: 1500, paymentStatus: "invoiced", invoiceNumber: "SBX-INV-1", invoicedAt: days(-2), invoicedAmount: 1500, factoringStatus: "none", stops } })).id;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
  });

  test("entering a test credential in Settings takes the connection to CONNECTED at once; a real key waits for a person", async () => {
    // A real-looking key is saved and nothing else happens: connecting a company that has not been tried says nothing.
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "mk_live_realkey_00001" }, new Date(), W)).toMatchObject({ ok: true, sandbox: false, connected: false });
    expect((await partnerStatus(W)).find((r) => r.provider === "motive")).toMatchObject({ status: "none", connected: false, sandbox: false });

    // A test key runs the simulator and connects.
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0001" }, new Date(), W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    const row = (await partnerStatus(W)).find((r) => r.provider === "motive")!;
    expect(row).toMatchObject({ status: "connected", connected: true, sandbox: true, failures: 0, lastError: null, overdue: false });
    expect(await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "eld", provider: "motive" } })).toMatchObject({ status: "connected", accountLabel: "Simulator" });
    // Saving it again is harmless.
    expect(await saveKeysAndConnect("motive", { MOTIVE_API_KEY: "sandbox_motive_key_0002" }, new Date(), W)).toMatchObject({ ok: true, sandbox: true, connected: true });
  });

  test("the sync runner pulls simulated ELD telemetry and updates each truck's position and each driver's clocks, for this fleet only", async () => {
    const before = await prisma.vehicle.findUniqueOrThrow({ where: { id: truck1 } });
    expect(before).toMatchObject({ lastLat: null, lastLocatedAt: null, hosAvailableHours: null });

    const now = new Date();
    const out = await runPartnerSync({ now, workspaceId: W });
    expect(out).toMatchObject({ ran: 1, ok: 1, failed: 0 });
    const after = Date.now(); // the simulator stamps a fix a few minutes before the moment it is asked

    for (const id of [truck1, truck2]) {
      const t = await prisma.vehicle.findUniqueOrThrow({ where: { id } });
      expect(t.eldProvider).toBe("motive");
      expect(t.eldVehicleId).toMatch(/^\d+$/);
      expect(Number(t.lastLat)).toBeGreaterThan(24);
      expect(Number(t.lastLat)).toBeLessThan(50);
      expect(Number(t.lastLng)).toBeLessThan(-66);
      expect(t.lastLocatedAt!.getTime()).toBeLessThanOrEqual(after);
      expect(after - t.lastLocatedAt!.getTime()).toBeLessThan(6 * 60_000);
      expect(Number(t.hosAvailableHours)).toBeGreaterThan(0);
      expect(Number(t.hosAvailableHours)).toBeLessThanOrEqual(11);
      expect(t.hosSyncedAt).not.toBeNull();
    }
    for (const id of [driver1, driver2]) {
      const d = await prisma.driver.findUniqueOrThrow({ where: { id } });
      expect(d.eldDriverId).toMatch(/^\d+$/);
      expect(d.hosDriveMinutes!).toBeGreaterThan(0);
      expect(d.hosDriveMinutes!).toBeLessThanOrEqual(660);
      expect(d.hosShiftMinutes!).toBeLessThanOrEqual(840);
      expect(d.hosCycleMinutes!).toBeLessThanOrEqual(4200);
      expect(d.hosSyncedAt).not.toBeNull();
    }
    // The tractor's hours are the lesser of its driver's drive and shift clocks.
    const d1 = await prisma.driver.findUniqueOrThrow({ where: { id: driver1 } });
    const t1 = await prisma.vehicle.findUniqueOrThrow({ where: { id: truck1 } });
    expect(Number(t1.hosAvailableHours)).toBeCloseTo(Math.min(d1.hosDriveMinutes!, d1.hosShiftMinutes!) / 60, 1);

    // The connection answered: its health is stamped and the next read is on its rhythm.
    const conn = await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "eld", provider: "motive" } });
    expect(conn).toMatchObject({ status: "connected", failures: 0 });
    expect(conn.lastSyncedAt).not.toBeNull();
    expect(conn.nextSyncAt!.getTime()).toBeGreaterThan(now.getTime() + 14 * 60_000);
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "hos_synced" } })).toBeGreaterThanOrEqual(1);

    // The other fleet's truck and driver, which share names with this fleet's, were not touched.
    expect(await prisma.vehicle.count({ where: { workspaceId: OTHER, lastLat: { not: null } } })).toBe(0);
    expect(await prisma.driver.count({ where: { workspaceId: OTHER, hosSyncedAt: { not: null } } })).toBe(0);

    // Not due again until its time: a second run does nothing, and one a quarter hour later reads again.
    expect(await runPartnerSync({ now: new Date(now.getTime() + 60_000), workspaceId: W })).toMatchObject({ ran: 0 });
    expect(await runPartnerSync({ now: new Date(now.getTime() + 16 * 60_000), workspaceId: W })).toMatchObject({ ran: 1, ok: 1 });
  });

  test("a sandbox key on a desk that does not allow the simulator is refused with a plain message, and nothing is written", async () => {
    process.env.DESK_AUTH = "on";
    try {
      await prisma.vehicle.update({ where: { id: truck2 }, data: { lastLat: null, lastLng: null, lastLocatedAt: null } });
      const out = await syncEld(new Date(), W);
      expect(out).toMatchObject({ ok: false, code: "not_configured" });
      expect(await prisma.vehicle.findUniqueOrThrow({ where: { id: truck2 } })).toMatchObject({ lastLat: null });
    } finally {
      delete process.env.DESK_AUTH;
    }
  });

  test("a signed test webhook to POST /partners/webhook/factoring/<token> marks the test load funded, once", async () => {
    // Connect factoring on a test key and a test signing secret.
    expect(await saveKeysAndConnect("triumphpay", { TRIUMPHPAY_API_KEY: "sandbox_triumph_key_01", TRIUMPHPAY_WEBHOOK_SECRET: WH_SECRET }, new Date(), W)).toMatchObject({ ok: true, sandbox: true, connected: true });
    const path = (await webhookPath("factoring", "triumphpay", W))!;
    expect(path).toMatch(/^\/partners\/webhook\/triumphpay\/[A-Za-z0-9_-]{32}$/);
    const token = path.split("/").pop()!;

    // The invoice goes to the (simulated) factor: its reference names the invoice and it is with the factor.
    const sent = await factorInvoice(loadId, { sendAnyway: true }, new Date(), W);
    expect(sent).toEqual({ ok: true, referenceId: "TP-SBX-SBX-INV-1", status: "submitted" });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("submitted");

    // The factor's funding confirmation, in the factor's shape and signed, delivered to the real route at the factoring address.
    const post = (raw: string, signature: string | null, kind: string = "factoring") =>
      webhookRoute(new NextRequest(`http://desk.test/partners/webhook/${kind}/${token}`, { method: "POST", body: raw, headers: { "content-type": "application/json", ...(signature ? { "x-signature": signature } : {}) } }), { params: { provider: kind, token } });
    const funded = sandboxFactoringEvent({ kind: "factoring.funded", invoiceNumber: "SBX-INV-1", referenceId: "TP-SBX-SBX-INV-1", id: "evt_sbx_funded_1", secret: WH_SECRET });

    const bad = await post(funded.raw, "0".repeat(64));
    expect(bad.status).toBe(401);
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("submitted");

    const good = await post(funded.raw, funded.signature);
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true, result: "applied" });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("funded");

    // The same delivery again is one event, and the company's own name works in the address as well as the word.
    const again = await post(funded.raw, funded.signature, "triumphpay");
    expect(await again.json()).toEqual({ ok: true, result: "duplicate" });
    expect(await prisma.partnerEvent.count({ where: { workspaceId: W, provider: "triumphpay" } })).toBe(1);

    // The payment confirmation moves it on, one allowed step; the connection's health stays good.
    const paid = sandboxFactoringEvent({ kind: "factoring.paid", invoiceNumber: "SBX-INV-1", referenceId: null, id: "evt_sbx_paid_1", secret: WH_SECRET });
    expect(await (await post(paid.raw, paid.signature)).json()).toEqual({ ok: true, result: "applied" });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: loadId } })).factoringStatus).toBe("paid");
    expect(await prisma.partnerConnection.findFirstOrThrow({ where: { workspaceId: W, capability: "factoring" } })).toMatchObject({ status: "connected", failures: 0 });
  });

  test("Send test event walks an invoice through the real receiver: sent, funded, paid; reads the ELD now; refuses without the simulator", async () => {
    // A second delivered, invoiced load that has not gone to the factor (the first one is already paid).
    const l2 = await prisma.load.create({ data: { workspaceId: W, loadNumber: "SBX-L2", status: "completed", completedAt: days(-1), quotedRevenue: 900, paymentStatus: "invoiced", invoiceNumber: "SBX-INV-2", invoicedAt: days(-1), invoicedAmount: 900, factoringStatus: "none" } });
    const status = async () => (await prisma.load.findUniqueOrThrow({ where: { id: l2.id } })).factoringStatus;

    const first = await sendTestEvent("factoring", "triumphpay", new Date(), W);
    expect(first).toMatchObject({ ok: true, loadId: l2.id });
    expect(await status()).toBe("submitted");
    const second = await sendTestEvent("factoring", "triumphpay", new Date(), W);
    expect(second).toMatchObject({ ok: true, loadId: l2.id, result: "the desk answered: applied" });
    expect(await status()).toBe("funded");
    expect(await sendTestEvent("factoring", "triumphpay", new Date(), W)).toMatchObject({ ok: true, result: "the desk answered: applied" });
    expect(await status()).toBe("paid");
    // Nothing is left with the factor: the next click says what to do, and changes nothing.
    expect(await sendTestEvent("factoring", "triumphpay", new Date(), W)).toMatchObject({ ok: false });
    expect(await status()).toBe("paid");

    // The ELD one reads now.
    expect(await sendTestEvent("eld", "motive", new Date(), W)).toMatchObject({ ok: true, what: expect.stringContaining("ELD") });

    // A connection that is not the simulator, or not connected, is refused.
    expect(await sendTestEvent("factoring", "nobody", new Date(), W)).toMatchObject({ ok: false, error: "Connect it first." });
    process.env.TRIUMPHPAY_API_KEY = "real_key_not_a_sandbox";
    await saveKeysAndConnect("triumphpay", { TRIUMPHPAY_API_KEY: "real_triumph_key_12345" }, new Date(), W);
    delete process.env.TRIUMPHPAY_API_KEY;
    expect(await sendTestEvent("factoring", "triumphpay", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("simulator") });
    // Put the sandbox key back for the tests that follow.
    await saveKeysAndConnect("triumphpay", { TRIUMPHPAY_API_KEY: "sandbox_triumph_key_01" }, new Date(), W);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("a company with no adapter written yet still answers 'not implemented', and nothing in any of this touched the network", async () => {
    await saveKeysAndConnect("samsara", { SAMSARA_API_KEY: "sandbox_samsara_key_1" }, new Date(), W);
    expect((await callPartner("eld", "samsara", { vehicles: [] }, W)).result).toMatchObject({ ok: false });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
