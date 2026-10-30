import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GET as partnersStatus } from "@/app/(desk)/partners/status/route";
import { prisma } from "@/lib/db";
import { BLANK_QUOTE, readQuote } from "@/lib/quote";
import { saveTruck } from "@/server/tl/fleet";
import { commitImport } from "@/server/tl/import";
import { planSummary } from "@/server/tl/plan";
import { fitQuote } from "@/server/tl/quote";
import { listEntityAudit } from "@/server/tl/audit";
import { partnerAdapters, partnerState } from "@/server/partners/call";
import { connectPartner, disconnectPartner, partnerStatus } from "@/server/partners/connections";
import { syncEld } from "@/server/partners/eld";
import { applyFactoringUpdate, factorInvoice, getFactoringView } from "@/server/partners/factoring";
import { importFuelForLoad, saveFuelCard } from "@/server/partners/fuel-card";
import { calculateIfta } from "@/server/partners/ifta";
import { listPayroll, sendToPayroll } from "@/server/partners/payroll";
import { shareLoadLocation } from "@/server/partners/tracking";
import { vetDriverCarrier } from "@/server/partners/vetting";

/**
 * Wave E4 on the demo database, in a workspace of its own: the plan limit on trucks, and the seams for factoring, ELD hours, fuel cards, carrier vetting and payroll. No company
 * is chosen, so each adapter is stood in by a test double; what is proved is everything around the call: the order of the checks, what is written when it answers, and what is
 * written when it does not.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "e4-partners";
const KEYS = ["TRIUMPHPAY_API_KEY", "MOTIVE_API_KEY", "ATOB_API_KEY", "HIGHWAY_API_KEY", "GUSTO_CLIENT_ID", "GUSTO_CLIENT_SECRET", "PROJECT44_CLIENT_ID", "PROJECT44_CLIENT_SECRET", "PROMILES_API_KEY"] as const;
const days = (n: number) => new Date(Date.now() + n * 86_400_000);
const originals = { ...partnerAdapters };
const fake = (cap: keyof typeof partnerAdapters, fn: (call: { provider: string; input: never }) => unknown) => {
  (partnerAdapters as Record<string, unknown>)[cap] = async (call: { provider: string; input: never }) => ({ ok: true, data: await fn(call) });
};

describe.skipIf(!run)("a plan holds only its number of trucks", () => {
  const P = "e4-plan";
  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: P } });
    await prisma.workspace.create({ data: { id: P, name: "E4 plan", plan: "starter" } });
  });
  afterAll(() => prisma.workspace.deleteMany({ where: { id: P } }));

  const add = (name: string) => prisma.vehicle.create({ data: { workspaceId: P, name } });
  const file = (n: number, from = 0) => ["Name", ...Array.from({ length: n }, (_, i) => `E4 Imp ${from + i}`)].join("\n");

  test("trucks are added up to the limit, then refused with the plan named; an archived truck does not count", async () => {
    // saveTruck works in the request's workspace, so the plan check is exercised through the import and the plan summary here
    await add("E4 A");
    await add("E4 B");
    expect(await commitImport("trucks", file(1), "a.csv", new Date(), P)).toMatchObject({ ok: true, created: 1 }); // the third
    const refused = await commitImport("trucks", file(1, 10), "b.csv", new Date(), P);
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Starter plan covers 3 trucks") });
    expect(await prisma.vehicle.count({ where: { workspaceId: P } })).toBe(3);
    await prisma.vehicle.updateMany({ where: { workspaceId: P, name: "E4 B" }, data: { archivedAt: new Date() } });
    expect(await commitImport("trucks", file(1, 20), "c.csv", new Date(), P)).toMatchObject({ ok: true });
  });

  test("a file that would pass the limit is refused whole, with nothing written", async () => {
    const before = await prisma.vehicle.count({ where: { workspaceId: P } });
    const out = await commitImport("trucks", file(5, 100), "big.csv", new Date(), P);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("This file has 5 to add") });
    expect(await prisma.vehicle.count({ where: { workspaceId: P } })).toBe(before);
  });

  test("a workspace with no plan chosen has no limit, and the summary says what the fleet comes to", async () => {
    await prisma.workspace.update({ where: { id: P }, data: { plan: null } });
    expect(await commitImport("trucks", file(12, 200), "d.csv", new Date(), P)).toMatchObject({ ok: true, created: 12 });
    const s = await planSummary(P);
    expect(s).toMatchObject({ key: "pro", chosen: false, limit: null, trucks: 15 });
    expect(s.monthly).toBe("$379"); // $199 + 15 trucks at $12
    await prisma.workspace.update({ where: { id: P }, data: { plan: "growth" } });
    expect(await planSummary(P)).toMatchObject({ key: "growth", chosen: true, limit: 10 });
  });

  test("saveTruck in the request's workspace refuses the truck past the plan", async () => {
    const DEMO = "demo-workspace";
    const before = (await prisma.workspace.findUnique({ where: { id: DEMO }, select: { plan: true } }))?.plan ?? null;
    const count = await prisma.vehicle.count({ where: { workspaceId: DEMO, archivedAt: null } });
    await prisma.workspace.update({ where: { id: DEMO }, data: { plan: count <= 3 ? "starter" : "growth" } });
    try {
      const limit = count <= 3 ? 3 : 10;
      for (let i = count; i < limit; i++) expect(await saveTruck({ name: `E4 Fill ${i}` }, null)).toMatchObject({ ok: true });
      expect(await saveTruck({ name: "E4 One Too Many" }, null)).toMatchObject({ ok: false, error: expect.stringMatching(/plan covers/) });
    } finally {
      await prisma.vehicle.deleteMany({ where: { workspaceId: DEMO, name: { startsWith: "E4 " } } });
      await prisma.auditEvent.deleteMany({ where: { workspaceId: DEMO, summary: { contains: "E4 " } } });
      await prisma.workspace.update({ where: { id: DEMO }, data: { plan: before } });
    }
  });
});

describe.skipIf(!run)("the partner seams", () => {
  const ids = { truck: "", truck2: "", driver: "", ready: "", load: "", loadNoDoc: "" };

  beforeAll(async () => {
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "E4 partners" } });
    for (const k of KEYS) delete process.env[k];
    const cost = { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner" };
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "E4 Truck 1", costProfile: { create: cost } } });
    const truck2 = await prisma.vehicle.create({ data: { workspaceId: W, name: "E4 Truck 2", costProfile: { create: cost } } });
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "E4 Driver", cdlExpiry: days(900), medicalCardExpiry: days(900), carrierMcNumber: "123456" } });
    const ready = await prisma.driver.create({ data: { workspaceId: W, name: "E4 Ready", payrollWorkerType: "employee", payrollEmployeeId: "emp-77" } });
    const stops = (n: number) => ({ create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: days(-n - 2), timeWindowLatest: days(-n - 2) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: days(-n), timeWindowLatest: days(-n), podPhotoUrl: "pod.jpg" }] });
    const load = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E4-L1", status: "completed", completedAt: days(-3), quotedRevenue: 1500, vehicleId: truck.id, paymentStatus: "invoiced", invoiceNumber: "E4-INV-1", invoicedAt: days(-2), invoicedAmount: 1500, rateConPath: "rc.pdf", stops: stops(3) } });
    const noDoc = await prisma.load.create({ data: { workspaceId: W, loadNumber: "E4-L2", status: "completed", completedAt: days(-3), quotedRevenue: 900, paymentStatus: "invoiced", invoiceNumber: "E4-INV-2", invoicedAt: days(-2), invoicedAmount: 900, stops: { create: [{ stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX" }] } } });
    Object.assign(ids, { truck: truck.id, truck2: truck2.id, driver: driver.id, ready: ready.id, load: load.id, loadNoDoc: noDoc.id });
  });
  afterAll(async () => {
    Object.assign(partnerAdapters, originals);
    for (const k of KEYS) delete process.env[k];
    await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: W } } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("a call goes through three checks in order: keys, then the connection, then the adapter", async () => {
    expect(await partnerState("factoring", null, W)).toMatchObject({ provider: "triumphpay", configured: false, connected: false, reason: expect.stringContaining("no keys on the server") });
    expect(await connectPartner("factoring", "triumphpay", null, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("no keys") }); // nothing to connect to
    process.env.TRIUMPHPAY_API_KEY = "test-key";
    expect(await partnerState("factoring", null, W)).toMatchObject({ configured: true, connected: false, reason: expect.stringContaining("not connected for this fleet") });
    const view = await getFactoringView(ids.load, W);
    expect(view?.blocked).toMatch(/not connected for this fleet/);
    expect(await factorInvoice(ids.load, {}, new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    expect(await connectPartner("factoring", "triumphpay", "Main account", new Date(), W)).toEqual({ ok: true, changed: true });
    expect(await connectPartner("factoring", "triumphpay", "Main account", new Date(), W)).toEqual({ ok: true, changed: false });
    expect(await factorInvoice(ids.load, {}, new Date(), W)).toMatchObject({ ok: false, code: "not_implemented" }); // the stub, until a company is chosen
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.load } })).factoringStatus).toBe("none"); // nothing was written for a call that did not happen
    const events = await prisma.auditEvent.findMany({ where: { workspaceId: W, action: "partner_connected" } });
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe("TriumphPay connected for factoring");
  });

  test("the status route says booleans and company names, never a key or a key's name", async () => {
    const body = await (await partnersStatus()).json();
    const text = JSON.stringify(body);
    expect(body.partners.length).toBeGreaterThanOrEqual(10);
    expect(body.partners[0]).toEqual({ capability: "factoring", provider: "triumphpay", configured: expect.any(Boolean), connected: expect.any(Boolean) });
    expect(text).not.toMatch(/API_KEY|SECRET|test-key/);
    const rows = await partnerStatus(W);
    expect(rows.find((r) => r.provider === "triumphpay")).toMatchObject({ configured: true, connected: true, accountLabel: "Main account" });
  });

  test("factoring: the invoice is required, the optional items go missing only by Send anyway, and what the factor answers is written with its audit", async () => {
    fake("factoring", () => ({ referenceId: "REF-9", status: "submitted" }));
    const gaps = await getFactoringView(ids.loadNoDoc, W);
    expect(gaps?.manifest.map((m) => [m.kind, m.present])).toEqual([["invoice", true], ["rate_confirmation", false], ["proof_of_delivery", false]]);
    expect(await factorInvoice(ids.loadNoDoc, {}, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Send anyway") });
    const sent = await factorInvoice(ids.loadNoDoc, { sendAnyway: true }, new Date(), W);
    expect(sent).toEqual({ ok: true, referenceId: "REF-9", status: "submitted" });
    const l = await prisma.load.findUniqueOrThrow({ where: { id: ids.loadNoDoc } });
    expect([l.factoringStatus, l.factoringReferenceId]).toEqual(["submitted", "REF-9"]);
    const event = await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "factoring_requested", loadId: ids.loadNoDoc } });
    expect(event.summary).toContain("without rate confirmation and proof of delivery");
    expect(await factorInvoice(ids.loadNoDoc, { sendAnyway: true }, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Already with the factor") });

    // A full packet needs no "Send anyway"; a load that is not invoiced cannot be sent; a rejection can be sent again.
    expect(await factorInvoice(ids.load, {}, new Date(), W)).toMatchObject({ ok: true });
    await prisma.load.update({ where: { id: ids.load }, data: { paymentStatus: null } });
    expect((await getFactoringView(ids.load, W))?.blocked).toBe("Invoice it first.");
    await prisma.load.update({ where: { id: ids.load }, data: { paymentStatus: "invoiced" } });
    expect(await applyFactoringUpdate(ids.load, "rejected", null, new Date(), W)).toBe(true);
    expect(await applyFactoringUpdate(ids.load, "rejected", null, new Date(), W)).toBe(false);
    expect((await getFactoringView(ids.load, W))?.blocked).toBeNull();
    expect(await factorInvoice(ids.load, {}, new Date(), W)).toMatchObject({ ok: true });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "factoring_updated" } })).toBe(1);
  });

  test("a call that fails or throws writes nothing and says so", async () => {
    (partnerAdapters as Record<string, unknown>).factoring = async () => {
      throw new Error("socket hang up with secret details");
    };
    await prisma.load.update({ where: { id: ids.loadNoDoc }, data: { factoringStatus: "none", factoringReferenceId: null } });
    const out = await factorInvoice(ids.loadNoDoc, { sendAnyway: true }, new Date(), W);
    expect(out).toMatchObject({ ok: false, code: "upstream_error" });
    expect(JSON.stringify(out)).not.toContain("socket");
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.loadNoDoc } })).factoringStatus).toBe("none");
  });

  test("ELD: hours are read for this workspace's tractors only, with one audit event for the read and one for new links", async () => {
    process.env.MOTIVE_API_KEY = "k";
    expect(await syncEld(new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    await connectPartner("eld", "motive", null, new Date(), W);
    fake("eld", () => ({ vehicles: [{ id: ids.truck, eldVehicleId: "m-1", hosAvailableHours: 6.5 }, { id: "someone-elses", eldVehicleId: "x", hosAvailableHours: 1 }] }));
    const out = await syncEld(new Date(), W);
    expect(out).toEqual({ ok: true, provider: "motive", synced: 1, linked: 1 });
    const t = await prisma.vehicle.findUniqueOrThrow({ where: { id: ids.truck } });
    expect([t.eldProvider, t.eldVehicleId, Number(t.hosAvailableHours), t.hosSyncedAt != null]).toEqual(["motive", "m-1", 6.5, true]);
    expect((await prisma.vehicle.findUniqueOrThrow({ where: { id: ids.truck2 } })).eldProvider).toBe("none");
    expect((await prisma.auditEvent.findMany({ where: { workspaceId: W, action: { in: ["hos_synced", "eld_linked"] } } })).map((e) => e.action).sort()).toEqual(["eld_linked", "hos_synced"]);
  });

  test("the Quote cautions about hours left on the clock but prices the same: the verdict never reads them", async () => {
    const input = readQuote({ ...BLANK_QUOTE, stops: [{ role: "pickup", address: "Dallas, TX", appointment: "2027-06-09T08:00" }, { role: "delivery", address: "Tulsa, OK", appointment: "2027-06-09T17:00" }], broker: "E4 B", offer: "1500", loadedMiles: "260", emptyToPickup: "40", emptyHome: "240", marketRate: "1500" });
    if (!input) throw new Error("not priceable");
    const row = async () => (await fitQuote(input, W)).rows.find((r) => r.truckId === ids.truck)!;
    await prisma.vehicle.update({ where: { id: ids.truck }, data: { hosAvailableHours: 1 } });
    const short = await row();
    expect(short.hos).toMatchObject({ availableHours: 1, caution: { level: "short" } });
    expect(short.warnings.some((w) => /left on the clock/.test(w))).toBe(true);
    await prisma.vehicle.update({ where: { id: ids.truck }, data: { hosAvailableHours: null } });
    const none = await row();
    expect(none.hos.caution.level).toBe("none");
    expect(none.warnings.some((w) => /left on the clock/.test(w))).toBe(false);
    for (const k of ["decision", "marginPerMile", "allInPerMile", "floorPerMile", "leftOver", "totalMiles", "band", "blocked"] as const) expect(short[k]).toEqual(none[k]); // zero drift
  });

  test("fuel cards: a truck's card is saved (audited, validated); the import reads purchases in the trip's window and writes nothing to the load", async () => {
    expect(await saveFuelCard(ids.truck, "nobody", "a1", new Date(), W)).toMatchObject({ ok: false });
    expect(await saveFuelCard(ids.truck, "atob", "", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("account") });
    expect(await importFuelForLoad(ids.load, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("no fuel card") });
    expect(await saveFuelCard(ids.truck, "atob", "ACCT-1", new Date(), W)).toEqual({ ok: true, changed: true });
    expect(await saveFuelCard(ids.truck, "atob", "ACCT-1", new Date(), W)).toEqual({ ok: true, changed: false });
    process.env.ATOB_API_KEY = "k";
    expect(await importFuelForLoad(ids.load, new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    await connectPartner("fuel_card", "atob", null, new Date(), W);
    const day = (n: number) => days(n).toISOString().slice(0, 10);
    fake("fuel_card", () => ({ purchases: [{ on: day(-5), gallons: 50, amount: 210.55 }, { on: day(-3), gallons: 40, amount: 170.1 }, { on: day(-400), gallons: 99, amount: 999 }] }));
    const out = await importFuelForLoad(ids.load, new Date(), W);
    expect(out).toMatchObject({ ok: true, provider: "atob", amount: 380.65, gallons: 90, purchases: 2 });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: ids.load } })).expenseFuelActual.toString()).toBe("0"); // the screen decides what goes in the box
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "fuel_imported" } })).toBe(1);
  });

  test("carrier vetting: needs an MC or DOT, keeps what the check found on the driver, and writes the audit", async () => {
    const none = await prisma.driver.create({ data: { workspaceId: W, name: "E4 NoMc", cdlExpiry: days(900), medicalCardExpiry: days(900) } });
    expect(await vetDriverCarrier(none.id, new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("MC or DOT") });
    process.env.HIGHWAY_API_KEY = "k";
    expect(await vetDriverCarrier(ids.driver, new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    await connectPartner("vetting", "highway", null, new Date(), W);
    fake("vetting", ({ input }) => {
      expect((input as { mcNumber: string }).mcNumber).toBe("123456");
      return { status: "review", coiExpiresAt: days(20).toISOString() };
    });
    const out = await vetDriverCarrier(ids.driver, new Date(), W);
    expect(out).toMatchObject({ ok: true, status: "review" });
    const d = await prisma.driver.findUniqueOrThrow({ where: { id: ids.driver } });
    expect([d.vetStatus, d.coiExpiresAt != null, d.vetCheckedAt != null]).toEqual(["review", true, true]);
    expect((await prisma.auditEvent.findFirstOrThrow({ where: { workspaceId: W, action: "carrier_vetted" } })).summary).toMatch(/needs review/);
  });

  test("payroll: a finalized statement goes once, only for a driver set up there, with one audit event for the batch", async () => {
    const make = (driverId: string, number: string, status = "final") => prisma.settlement.create({ data: { workspaceId: W, number, driverId, status, periodStart: days(-30), periodEnd: days(-23), finalizedAt: days(-20), total: 800, lines: [] } });
    const a = await make(ids.ready, "E4-ST-1");
    const b = await make(ids.ready, "E4-ST-2");
    const notSetUp = await make(ids.driver, "E4-ST-3");
    const draft = await make(ids.ready, "E4-ST-4", "draft");
    const list = await listPayroll({ filter: "all" }, W);
    expect(list.rows.find((r) => r.id === a.id)!.notReady).toBeNull();
    expect(list.rows.find((r) => r.id === notSetUp.id)!.notReady).toBe("Set the driver's worker type.");
    expect(list.rows.some((r) => r.id === draft.id)).toBe(false); // a draft is not final
    expect(await sendToPayroll([notSetUp.id], new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("worker type") });
    expect(await sendToPayroll([draft.id], new Date(), W)).toMatchObject({ ok: false });
    process.env.GUSTO_CLIENT_ID = "a";
    process.env.GUSTO_CLIENT_SECRET = "b";
    expect(await sendToPayroll([a.id], new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    await connectPartner("payroll", "gusto", null, new Date(), W);
    fake("payroll", ({ input }) => {
      expect((input as { statements: Array<{ employeeId: string; total: number }> }).statements.map((s) => [s.employeeId, s.total])).toEqual([["emp-77", 800], ["emp-77", 800]]);
      return { reference: "PAY-1" };
    });
    expect(await sendToPayroll([a.id, b.id], new Date(), W)).toEqual({ ok: true, sent: 2, reference: "PAY-1" });
    expect(await sendToPayroll([a.id], new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Already sent") });
    expect(await prisma.settlement.count({ where: { workspaceId: W, payrollSentAt: { not: null } } })).toBe(2);
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: ids.ready } })).payrollStatus).toBe("sent");
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "payroll_sent" } })).toBe(1);
    expect((await listPayroll({ filter: "sent" }, W)).rows).toHaveLength(2);
  });

  test("location is shared only with the carrier's explicit yes for the load, and IFTA only for a real quarter", async () => {
    expect(await shareLoadLocation(ids.load, true, false, W)).toMatchObject({ ok: false, code: "bad_request" });
    expect(await shareLoadLocation(ids.load, false, false, W)).toMatchObject({ ok: false, code: "not_configured" }); // stopping needs no yes, but there is no company
    expect(await shareLoadLocation("nope", true, true, W)).toMatchObject({ ok: false, error: "That load does not exist." });
    expect(await calculateIfta("2026-Q5", W)).toMatchObject({ ok: false, code: "bad_request" });
    process.env.PROMILES_API_KEY = "k";
    expect(await calculateIfta("2026-Q3", W)).toMatchObject({ ok: false, code: "not_connected" });
  });

  test("disconnecting a company is audited and stops the calls", async () => {
    expect(await disconnectPartner("factoring", "triumphpay", new Date(), W)).toEqual({ ok: true, changed: true });
    expect(await disconnectPartner("factoring", "triumphpay", new Date(), W)).toEqual({ ok: true, changed: false });
    expect(await factorInvoice(ids.loadNoDoc, { sendAnyway: true }, new Date(), W)).toMatchObject({ ok: false, code: "not_connected" });
    expect(await prisma.auditEvent.count({ where: { workspaceId: W, action: "partner_connected", summary: { contains: "disconnected" } } })).toBe(1);
    expect(await listEntityAudit("none", 1, W)).toEqual([]);
  });
});
