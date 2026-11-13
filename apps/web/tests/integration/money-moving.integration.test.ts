import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { callPartner, partnerAdapters } from "@/server/partners/call";
import { connectPartner } from "@/server/partners/connections";
import { checkFeature, checkMoneyMoving, moneyMovingState, setMoneyMoving } from "@/server/partners/gates";
import { sendToPayroll } from "@/server/partners/payroll";

/**
 * Money plan Wave 7 step 1 on the demo database, in workspaces of their own: plan gating of partner features, and the money-moving switch (Gap 14). The company's live adapter is stood in by a
 * double that counts its calls, so what is proved is that a live call that would move money never reaches it until counsel signed off the server AND the fleet's admin switched it on; that the
 * simulator and a read (payroll's status check) never need the switch; and that the switch is an admin's, with a reason, audited, and cannot be turned on without the server's sign-off.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "w7-money";
const STARTER = "w7-money-starter";
const KEYS = ["GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "TRIUMPHPAY_API_KEY", "MONEY_MOVING_COUNSEL_APPROVED"] as const;
const saved: Record<string, string | undefined> = {};
const originals = { ...partnerAdapters };
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
let calls: Array<{ cap: string; input: unknown }> = [];
let driverId = "";

const clean = async () => {
  for (const id of [W, STARTER]) {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: id } });
    await prisma.settlement.deleteMany({ where: { workspaceId: id } });
    await prisma.workspace.deleteMany({ where: { id } });
  }
};

describe.skipIf(!run)("Wave 7 step 1: plan gating and the money-moving switch", () => {
  beforeAll(async () => {
    for (const k of KEYS) saved[k] = process.env[k];
    await clean();
    await prisma.workspace.create({ data: { id: W, name: "W7 money", plan: "pro" } });
    await prisma.workspace.create({ data: { id: STARTER, name: "W7 starter" } });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "W7 Driver", cdlExpiry: day(900), medicalCardExpiry: day(900), payrollWorkerType: "employee", payrollEmployeeId: "emp-w7" } })).id;
    for (const cap of ["payroll", "factoring"] as const) {
      (partnerAdapters as Record<string, unknown>)[cap] = async (call: { input: unknown }) => {
        calls.push({ cap, input: call.input });
        return cap === "payroll" ? { ok: true, data: { reference: "PAY-W7", state: "pending" } } : { ok: true, data: { referenceId: "F-W7", status: "submitted" } };
      };
    }
  });
  beforeEach(async () => {
    calls = [];
    for (const k of KEYS) delete process.env[k];
    await prisma.workspace.update({ where: { id: W }, data: { moneyMovingLive: false, moneyMovingBy: null, moneyMovingAt: null, moneyMovingReason: null } });
  });
  afterAll(async () => {
    Object.assign(partnerAdapters, originals);
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await clean();
  });

  test("plans: every company kind is on every plan, the read API and outbound webhooks from Pro; a workspace with no plan is Starter", async () => {
    expect(await checkFeature("factoring", STARTER)).toEqual({ ok: true });
    expect(await checkFeature("payroll", STARTER)).toEqual({ ok: true });
    expect(await checkFeature("read_api", STARTER)).toMatchObject({ ok: false, code: "plan", error: expect.stringContaining("Pro plan and up") });
    expect(await checkFeature("outbound_webhooks", STARTER)).toMatchObject({ ok: false, code: "plan" });
    expect(await checkFeature("read_api", W)).toEqual({ ok: true });
    expect(await checkFeature("read_api", STARTER)).toMatchObject({ ok: false, error: expect.stringContaining("on Starter") });
    // (a word that is not a plan cannot be stored: the database's workspaces_plan_check refuses it; effectivePlan's fallback is unit tested)
    await prisma.workspace.update({ where: { id: STARTER }, data: { plan: null } });
    expect(await checkFeature("outbound_webhooks", STARTER)).toMatchObject({ ok: false });
  });

  test("a live payroll send is refused before the company is called, and before any statement is claimed, until both the server and the fleet say yes", async () => {
    process.env.GUSTO_CLIENT_ID = "live-id";
    process.env.GUSTO_CLIENT_SECRET = "live-secret";
    expect(await connectPartner("payroll", "gusto", null, new Date(), W)).toMatchObject({ ok: true });
    const s = await prisma.settlement.create({ data: { workspaceId: W, number: "W7-ST-1", driverId, status: "final", periodStart: day(-14), periodEnd: day(-7), finalizedAt: day(-6), total: 900, lines: [] } });

    // neither: counsel first
    expect(await sendToPayroll([s.id], new Date(), W)).toMatchObject({ ok: false, code: "money_moving_off", error: expect.stringContaining("counsel") });
    // the server signed off, the fleet did not
    process.env.MONEY_MOVING_COUNSEL_APPROVED = "yes";
    expect(await sendToPayroll([s.id], new Date(), W)).toMatchObject({ ok: false, code: "money_moving_off", error: expect.stringContaining("switched off for this fleet") });
    // the fleet switched on, the server's sign-off taken away
    await prisma.workspace.update({ where: { id: W }, data: { moneyMovingLive: true } });
    delete process.env.MONEY_MOVING_COUNSEL_APPROVED;
    expect(await sendToPayroll([s.id], new Date(), W)).toMatchObject({ ok: false, code: "money_moving_off" });
    expect(calls).toEqual([]);
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ payrollSentAt: null, payrollReference: null });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "payroll_sent" } })).toBe(0);

    // both: it goes, once
    process.env.MONEY_MOVING_COUNSEL_APPROVED = "yes";
    expect(await sendToPayroll([s.id], new Date(), W)).toMatchObject({ ok: true, reference: "PAY-W7" });
    expect(calls.map((c) => c.cap)).toEqual(["payroll"]);
  });

  test("the guard inside callPartner holds even for a caller that forgets to ask, and a read (payroll's status check) never needs the switch", async () => {
    process.env.GUSTO_CLIENT_ID = "live-id";
    process.env.GUSTO_CLIENT_SECRET = "live-secret";
    process.env.TRIUMPHPAY_API_KEY = "live-key";
    await connectPartner("payroll", "gusto", null, new Date(), W);
    await connectPartner("factoring", "triumphpay", null, new Date(), W);
    const send = await callPartner("payroll", null, { statements: [{ id: "x", number: "X", employeeId: "e", workerType: "employee", total: 1, periodStart: "2026-11-01", periodEnd: "2026-11-07" }] }, W);
    expect(send.result).toMatchObject({ ok: false, code: "not_configured", message: expect.stringContaining("counsel") });
    const factor = await callPartner("factoring", null, { loadId: "l", loadNumber: null, invoiceNumber: "INV-1", amount: 1, packet: [] }, W);
    expect(factor.result).toMatchObject({ ok: false, code: "not_configured" });
    expect(calls).toEqual([]);
    const status = await callPartner("payroll", null, { op: "status", reference: "PAY-1", sentAt: new Date().toISOString(), asOf: new Date().toISOString(), statements: [] }, W);
    expect(status.result).toMatchObject({ ok: true });
    expect(calls.map((c) => c.cap)).toEqual(["payroll"]);
  });

  test("the simulator never needs the switch; missing keys and a company not connected are still said first", async () => {
    // no keys at all: the switch has nothing to say yet
    expect(await checkMoneyMoving("factoring", W)).toEqual({ ok: true });
    process.env.TRIUMPHPAY_API_KEY = "live-key";
    await prisma.partnerConnection.deleteMany({ where: { workspaceId: W, capability: "factoring" } });
    expect(await checkMoneyMoving("factoring", W)).toEqual({ ok: true }); // keys, but not connected: callPartner says "not connected"
    await connectPartner("factoring", "triumphpay", null, new Date(), W);
    expect(await checkMoneyMoving("factoring", W)).toMatchObject({ ok: false, code: "money_moving_off" });
    process.env.TRIUMPHPAY_API_KEY = "sandbox_w7";
    expect(await checkMoneyMoving("factoring", W)).toEqual({ ok: true });
    const sim = await callPartner("factoring", null, { loadId: "l", loadNumber: null, invoiceNumber: "INV-1", amount: 1, packet: [] }, W);
    expect(sim.result).toMatchObject({ ok: true });
  });

  test("the switch is turned on only with the server's sign-off and a reason; off always; audited once per change, with who and why", async () => {
    const now = new Date();
    expect(await setMoneyMoving({ on: true, reason: "Counsel memo 2026-11 says go" }, "Chris", now, W)).toMatchObject({ ok: false, error: expect.stringContaining("not been signed off") });
    process.env.MONEY_MOVING_COUNSEL_APPROVED = "yes";
    expect(await setMoneyMoving({ on: true, reason: "  go " }, "Chris", now, W)).toMatchObject({ ok: false, error: expect.stringContaining("Say why") });
    expect(await setMoneyMoving({ on: true, reason: "Counsel memo 2026-11 says go" }, "Chris", now, W)).toEqual({ ok: true, changed: true, live: true });
    expect(await setMoneyMoving({ on: true, reason: "Counsel memo 2026-11 says go" }, "Chris", now, W)).toEqual({ ok: true, changed: false, live: true });
    expect(await moneyMovingState(W)).toMatchObject({ counsel: true, live: true, by: "Chris", reason: "Counsel memo 2026-11 says go" });
    // off needs no sign-off
    delete process.env.MONEY_MOVING_COUNSEL_APPROVED;
    expect(await setMoneyMoving({ on: false, reason: "Pausing while we change factor" }, "Jacob", new Date(now.getTime() + 1000), W)).toEqual({ ok: true, changed: true, live: false });
    const audit = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "money_moving_switched" }, orderBy: { createdAt: "asc" } });
    expect(audit).toHaveLength(2);
    expect(audit[0]!.summary).toBe("Money moving through companies switched on by Chris: Counsel memo 2026-11 says go");
    expect(audit[1]!.summary).toContain("switched off by Jacob");
    // the other fleet is untouched
    expect(await moneyMovingState(STARTER)).toMatchObject({ live: false, by: null });
  });

  test("a two-person race to switch it on changes it once", async () => {
    process.env.MONEY_MOVING_COUNSEL_APPROVED = "yes";
    const both = await Promise.all([setMoneyMoving({ on: true, reason: "Signed off, going live" }, "A", new Date(), W), setMoneyMoving({ on: true, reason: "Signed off, going live" }, "B", new Date(), W)]);
    expect(both.filter((r) => r.ok && r.changed)).toHaveLength(1);
  });
});
