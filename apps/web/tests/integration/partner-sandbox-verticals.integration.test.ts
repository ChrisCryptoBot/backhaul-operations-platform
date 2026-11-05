import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { POST as webhookRoute } from "@/app/(public)/partners/webhook/[provider]/[token]/route";
import { prisma } from "@/lib/db";
import { sandboxPayrollEvent } from "@/server/partners/adapters/gusto";
import { sandboxTrackingEvent } from "@/server/partners/adapters/project44";
import { webhookPath } from "@/server/partners/connections";
import { importFuelForLoad, saveFuelCard } from "@/server/partners/fuel-card";
import { calculateIfta, storedIfta } from "@/server/partners/ifta";
import { sendToPayroll } from "@/server/partners/payroll";
import { saveKeysAndConnect } from "@/server/partners/setup";
import { sendTestEvent } from "@/server/partners/test-event";
import { shareLoadLocation } from "@/server/partners/tracking";
import { vetDriverCarrier } from "@/server/partners/vetting";

/**
 * The remaining shelves on the simulator, end to end, with no company chosen and no network:
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/partner-sandbox-verticals.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "pb-verticals";
const OTHER = "pb-verticals-other";
const ENV_KEYS = ["DESK_CREDENTIAL_KEY", "DESK_AUTH", "DESK_PARTNER_SANDBOX"];
const KEYS = ["WEX_API_KEY", "PROJECT44_CLIENT_ID", "PROJECT44_CLIENT_SECRET", "PROJECT44_WEBHOOK_SECRET", "HIGHWAY_API_KEY", "GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "GUSTO_WEBHOOK_SECRET", "PROMILES_API_KEY"];
const saved: Record<string, string | undefined> = {};
const day = 86_400_000;
const hours = (n: number) => new Date(Date.now() + n * 3_600_000);
const days = (n: number) => new Date(Date.now() + n * day);
const COST = { estimatedMonthlyMiles: 10000, breakEvenRpm: 1.85 };

describe.skipIf(!run)("the remaining shelves on the sandbox simulator", () => {
  const fetchSpy = vi.fn(() => {
    throw new Error("the desk tried to reach the network");
  });
  const realFetch = globalThis.fetch;
  const SECRET = "sandbox_whsec_verticals";
  let truck = "";
  let fuelLoad = "";
  let openLoad = "";
  let openNumber = "";

  beforeAll(async () => {
    for (const k of [...ENV_KEYS, ...KEYS]) saved[k] = process.env[k];
    for (const k of [...ENV_KEYS, ...KEYS]) delete process.env[k];
    process.env.DESK_CREDENTIAL_KEY = randomBytes(32).toString("base64");
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const id of [W, OTHER]) {
      await prisma.workspace.deleteMany({ where: { id } });
      await prisma.workspace.create({ data: { id, name: id, plan: "enterprise" } });
    }
    truck = (await prisma.vehicle.create({ data: { workspaceId: W, name: "Unit 101", type: "dry_van", mpg: 8, costProfile: { create: COST } } })).id;
    const stop = (n: number, role: string, addr: string, opens: Date) => ({ stopSequence: n, stopType: role, stopRole: role, addressString: addr, timeWindowEarliest: opens, timeWindowLatest: new Date(opens.getTime() + 2 * 3_600_000) });
    fuelLoad = (await prisma.load.create({ data: { workspaceId: W, vehicleId: truck, loadNumber: "VF-1", status: "completed", completedAt: days(-1), quotedRevenue: 1500, loadedMiles: 800, stops: { create: [stop(1, "pickup", "Dallas, TX", days(-4)), stop(2, "delivery", "Atlanta, GA", days(-2))] } } })).id;
    const open = await prisma.load.create({ data: { workspaceId: W, vehicleId: truck, loadNumber: "VT-1", status: "in_progress", quotedRevenue: 900, loadedMiles: 300, originAddress: "Dallas, TX", destinationAddress: "Atlanta, GA", stops: { create: [stop(1, "pickup", "Dallas, TX", hours(-6)), stop(2, "delivery", "Atlanta, GA", hours(20))] } } });
    openLoad = open.id;
    openNumber = open.loadNumber!;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    for (const k of [...ENV_KEYS, ...KEYS]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await prisma.workspace.deleteMany({ where: { id: { in: [W, OTHER] } } });
  });

  test("all five connect on test keys at once", async () => {
    const conn = (provider: string, values: Record<string, string>) => saveKeysAndConnect(provider, values, new Date(), W);
    expect(await conn("wex", { WEX_API_KEY: "sandbox_wex_key_0001" })).toMatchObject({ ok: true, sandbox: true, connected: true });
    expect(await conn("project44", { PROJECT44_CLIENT_ID: "sandbox_p44_id_01", PROJECT44_CLIENT_SECRET: "sandbox_p44_secret", PROJECT44_WEBHOOK_SECRET: SECRET })).toMatchObject({ connected: true });
    expect(await conn("highway", { HIGHWAY_API_KEY: "sandbox_highway_key_1" })).toMatchObject({ connected: true });
    expect(await conn("gusto", { GUSTO_CLIENT_ID: "sandbox_gusto_id_01", GUSTO_CLIENT_SECRET: "sandbox_gusto_secret", GUSTO_WEBHOOK_SECRET: SECRET })).toMatchObject({ connected: true });
    expect(await conn("promiles", { PROMILES_API_KEY: "sandbox_promiles_key" })).toMatchObject({ connected: true });
    expect(await prisma.partnerConnection.count({ where: { workspaceId: W, status: "connected" } })).toBe(5);
  });

  test("fuel cards: a trip's purchases come back with gallons and the card's discount, and the audit says so", async () => {
    expect(await saveFuelCard(truck, "wex", "WEX-ACCT-1", new Date(), W)).toEqual({ ok: true, changed: true });
    const out = await importFuelForLoad(fuelLoad, new Date(), W);
    expect(out).toMatchObject({ ok: true, provider: "wex" });
    if (!out.ok) return;
    expect(out.purchases).toBeGreaterThan(0);
    expect(out.amount).toBeGreaterThan(100);
    expect(out.gallons!).toBeGreaterThan(60);
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "fuel_imported" }, orderBy: { createdAt: "desc" } });
    expect(ev.summary).toContain("card discount");
    // The same trip asked again is the same answer.
    expect(await importFuelForLoad(fuelLoad, new Date(), W)).toMatchObject({ ok: true, amount: out.amount, purchases: out.purchases });
  });

  test("load tracking: sharing returns a link that cannot resolve, stopping it says so, a signed geofence event lands in the load's trail", async () => {
    expect(await shareLoadLocation(openLoad, true, false, W)).toMatchObject({ ok: false, code: "bad_request" }); // never without the carrier's yes
    const on = await shareLoadLocation(openLoad, true, true, W);
    expect(on).toMatchObject({ ok: true, sharing: true });
    expect(on.ok && on.shareUrl).toMatch(/^https:\/\/track\.sandbox\.invalid\/s\//);
    expect(await shareLoadLocation(openLoad, false, false, W)).toMatchObject({ ok: true, sharing: false, shareUrl: null });

    // A signed arrival, delivered to the real route at the tracking address.
    const token = (await webhookPath("tracking", "project44", W))!.split("/").pop()!;
    const e = sandboxTrackingEvent({ kind: "tracking.arrived", loadNumber: openNumber, stop: 2, id: "evt_trk_1", secret: SECRET });
    const post = (raw: string, signature: string) => webhookRoute(new NextRequest(`http://desk.test/partners/webhook/tracking/${token}`, { method: "POST", body: raw, headers: { "x-signature": signature } }), { params: { provider: "tracking", token } });
    expect((await post(e.raw, "0".repeat(64))).status).toBe(401);
    expect(await (await post(e.raw, e.signature)).json()).toEqual({ ok: true, result: "applied" });
    expect(await (await post(e.raw, e.signature)).json()).toEqual({ ok: true, result: "duplicate" });
    const trail = await prisma.auditEvent.findMany({ where: { workspaceId: W, loadId: openLoad, action: "partner_event" } });
    expect(trail.map((t) => t.summary).join(" | ")).toContain("Tracking: arrived at stop 2");
    // It changed no stop and no trip.
    expect((await prisma.stop.findFirstOrThrow({ where: { loadId: openLoad, stopSequence: 2 } })).arrivedAt).toBeNull();
    // An event for a load nobody has is recorded as ignored, not an error.
    const stray = sandboxTrackingEvent({ kind: "tracking.arrived", loadNumber: "NO-SUCH", stop: 1, id: "evt_trk_2", secret: SECRET });
    expect(await (await post(stray.raw, stray.signature)).json()).toEqual({ ok: true, result: "ignored" });
    // The demo button does the same, with the next stop of the newest open load.
    expect(await sendTestEvent("tracking", "project44", new Date(), W)).toMatchObject({ ok: true, loadId: openLoad });
  });

  test("carrier vetting: each simulator carrier is judged by the desk's rules, and the status, the insurance date and the score are kept", async () => {
    const d = async (name: string, mc: string) => (await prisma.driver.create({ data: { workspaceId: W, name, carrierMcNumber: mc } })).id;
    const clear = await d("Clear Carrier", "MC-4000015");
    const review = await d("Expiring Carrier", "4000011");
    const failed = await d("Inactive Carrier", "4000010");
    expect(await vetDriverCarrier(clear, new Date(), W)).toMatchObject({ ok: true, provider: "highway", status: "clear" });
    expect(await vetDriverCarrier(review, new Date(), W)).toMatchObject({ ok: true, status: "review" });
    expect(await vetDriverCarrier(failed, new Date(), W)).toMatchObject({ ok: true, status: "failed" });
    const soon = await prisma.driver.findUniqueOrThrow({ where: { id: review } });
    expect(soon).toMatchObject({ vetStatus: "review" });
    expect(soon.coiExpiresAt!.getTime() - Date.now()).toBeLessThan(13 * day);
    expect(soon.vetCheckedAt).not.toBeNull();
    const ev = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "carrier_vetted", summary: { contains: "Expiring Carrier" } } });
    expect(ev.summary).toContain("safety score");
    expect(ev.summary).toContain("lapses within 30 days");
  });

  test("payroll: a sent batch gets one run reference; the company's cleared-run event marks the statements paid, once; a worker it does not know blocks the batch", async () => {
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "Paid Driver", payrollEmployeeId: "w-100", payrollWorkerType: "contractor" } });
    const st = await prisma.settlement.create({ data: { workspaceId: W, driverId: driver.id, number: "ST-VF-1", status: "final", periodStart: new Date("2026-11-02"), periodEnd: new Date("2026-11-08"), total: 1234.56, finalizedAt: days(-1) } });
    const sent = await sendToPayroll([st.id], new Date(), W);
    expect(sent).toMatchObject({ ok: true, sent: 1 });
    const reference = sent.ok ? sent.reference : "";
    expect(reference).toMatch(/^GUS-SBX-[0-9A-F]{10}$/);
    expect(await sendToPayroll([st.id], new Date(), W)).toMatchObject({ ok: false }); // never twice

    const token = (await webhookPath("payroll", "gusto", W))!.split("/").pop()!;
    const e = sandboxPayrollEvent({ kind: "payroll.paid", runId: reference, id: "evt_pay_1", secret: SECRET });
    const post = (raw: string, signature: string) => webhookRoute(new NextRequest(`http://desk.test/partners/webhook/payroll/${token}`, { method: "POST", body: raw, headers: { "x-signature": signature } }), { params: { provider: "payroll", token } });
    expect(await (await post(e.raw, e.signature)).json()).toEqual({ ok: true, result: "applied" });
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: st.id } })).toMatchObject({ paidMethod: "payroll" });
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: st.id } })).paidAt).not.toBeNull();
    // A second, different event for the same run changes nothing: the statement is already paid.
    const again = sandboxPayrollEvent({ kind: "payroll.paid", runId: reference, id: "evt_pay_2", secret: SECRET });
    expect(await (await post(again.raw, again.signature)).json()).toEqual({ ok: true, result: "ignored" });

    // A driver who is not set up at the company: the batch is refused and its claim given back.
    const nobody = await prisma.driver.create({ data: { workspaceId: W, name: "Not Set Up" } });
    const st2 = await prisma.settlement.create({ data: { workspaceId: W, driverId: nobody.id, number: "ST-VF-2", status: "final", periodStart: new Date("2026-11-02"), periodEnd: new Date("2026-11-08"), total: 500, finalizedAt: days(-1) } });
    expect(await sendToPayroll([st2.id], new Date(), W)).toMatchObject({ ok: false });
    expect(await prisma.settlement.findUniqueOrThrow({ where: { id: st2.id } })).toMatchObject({ payrollReference: null, payrollSentAt: null });
  });

  test("IFTA: a quarter's delivered loads go to the mileage company and the state-by-state answer is kept, replaced as a whole, for this fleet only", async () => {
    const q = (() => {
      const d = new Date();
      return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    })();
    // The fuel load (VF-1, Dallas to Atlanta, 800 miles, delivered yesterday) is in this quarter unless yesterday was the last day of the last one.
    const out = await calculateIfta(q, W);
    expect(out).toMatchObject({ ok: true, stored: true });
    if (!out.ok) return;
    expect(out.loads).toBeGreaterThanOrEqual(0);
    if ((out.loads ?? 0) > 0) {
      expect(out.jurisdictions.map((j) => j.state)).toEqual(expect.arrayContaining(["TX", "LA", "MS", "AL", "GA"]));
      expect(out.jurisdictions.reduce((s, j) => s + j.miles, 0)).toBeCloseTo(800, 0);
      const tx = out.jurisdictions.find((j) => j.state === "TX")!;
      expect(tx.gallons).toBeCloseTo(tx.miles / 8, 1); // the truck's own 8 miles to the gallon
    }
    const kept = await storedIfta(q, W);
    expect(kept.map((k) => k.state)).toEqual(out.jurisdictions.map((j) => j.state).sort());
    // Worked out again: replaced, not added to.
    await calculateIfta(q, W);
    expect((await storedIfta(q, W)).length).toBe(kept.length);
    expect(await storedIfta(q, OTHER)).toEqual([]);
    expect(await calculateIfta("2026-Q9", W)).toMatchObject({ ok: false, code: "bad_request" });
  });

  test("nothing in any of this touched the network", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
