import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prisma } from "@/lib/db";
import { statesAgree } from "@/lib/load-state";
import { toCentralLocal } from "@/lib/zoned";

/**
 * The rest of Part D, on the demo database in a workspace of its own: taking a pickup or a delivery back, alerts for a pickup nobody entered / a truck on two loads / a delivery with
 * no proof / a delivery nobody invoiced for months, an upload that is never mistaken for a sample, the header's terminal on Invoices and Alerts, and two dispatchers assigning one
 * driver at once.
 */
const W = "partd2";
vi.mock("@/server/tl/workspace", async (original) => {
  const real = await original<typeof import("@/server/tl/workspace")>();
  const { prisma: db } = await import("@/lib/db");
  return { ...real, currentWorkspaceId: () => "partd2", currentWorkspace: () => db.workspace.findUniqueOrThrow({ where: { id: "partd2" } }) };
});

const run = process.env.RUN_DB_INTEGRATION === "true";
const H = 3_600_000;
const day = (n: number) => new Date(Date.now() + n * 86_400_000);
const cost = { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner" };

describe.skipIf(!run)("the rest of Part D", () => {
  let dallas = "";
  let houston = "";
  let d1 = "";
  let d2 = "";
  let seq = 0;
  const pay = { kind: "cpm" as const, rate: 0.6 };
  const events = (loadId: string) => prisma.auditEvent.findMany({ where: { loadId }, orderBy: { createdAt: "asc" } });
  const mk = (over: Record<string, unknown> = {}, offsetDays = 30) => {
    seq += 1;
    return prisma.load.create({
      data: { workspaceId: W, loadNumber: `P2-${seq}`, status: "draft", brokerName: "P2 Broker", brokerEmail: "ap@p2.example", quotedRevenue: 1000, loadedMiles: 200, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", scheduledDate: day(offsetDays), vehicleId: dallas,
        stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: day(offsetDays), timeWindowLatest: day(offsetDays) }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: day(offsetDays + 1), timeWindowLatest: day(offsetDays + 1) }] }, ...over },
      include: { stops: true }
    });
  };

  beforeAll(async () => {
    await clear();
    await prisma.workspace.create({ data: { id: W, name: "Part D2 desk", plan: "enterprise" } });
    dallas = (await prisma.vehicle.create({ data: { workspaceId: W, name: "P2 Dallas truck", terminal: "Dallas", costProfile: { create: cost } } })).id;
    houston = (await prisma.vehicle.create({ data: { workspaceId: W, name: "P2 Houston truck", terminal: "Houston", costProfile: { create: cost } } })).id;
    const ok = { cdlExpiry: day(900), medicalCardExpiry: day(900) };
    d1 = (await prisma.driver.create({ data: { workspaceId: W, name: "P2 Driver One", terminal: "Dallas", ...ok } })).id;
    d2 = (await prisma.driver.create({ data: { workspaceId: W, name: "P2 Driver Two", terminal: "Houston", ...ok } })).id;
  });
  const clear = async () => {
    await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: W } } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  };
  afterAll(clear);

  test("a pickup entered against the wrong load can be taken back, with a reason; the driver keeps the load", async () => {
    const { assignDriver, dispatchLoad, recordDriverResponse } = await import("@/server/tl/dispatch");
    const { startTrip, undoStartTrip } = await import("@/server/tl/execution");
    const l = await mk({}, 40);
    await assignDriver({ loadId: l.id, driverId: d1, pay }, new Date(), W);
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    expect(await undoStartTrip(l.id, "Wrong load", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("on the road") });
    expect(await startTrip(l.id, { arrivedAt: toCentralLocal(Date.now() - 5 * H), waitMinutes: "30", seal: "SEAL-9" }, new Date(), W)).toEqual({ ok: true });
    expect(await undoStartTrip(l.id, "x", new Date(), W)).toMatchObject({ ok: false });
    expect(await undoStartTrip(l.id, "Entered on the wrong load", new Date(), W)).toEqual({ ok: true });
    const back = await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { assignment: true, stops: { orderBy: { stopSequence: "asc" } } } });
    expect([back.status, back.assignment?.status]).toEqual(["accepted", "accepted"]);
    expect([back.stops[0]!.arrivedAt, back.stops[0]!.waitMinutes, back.stops[0]!.sealNumber]).toEqual([null, null, null]);
    expect(statesAgree(back.status, back.assignment?.status)).toBe(true);
    expect((await events(l.id)).find((e) => e.action === "trip_undone")).toMatchObject({ reason: "Entered on the wrong load" });
  });

  test("a delivery can be taken back until it is invoiced or on a statement; the load is on the road again", async () => {
    const { assignDriver, dispatchLoad, recordDriverResponse } = await import("@/server/tl/dispatch");
    const { startTrip, completeTrip, reopenDelivered } = await import("@/server/tl/execution");
    const l = await mk({}, 45);
    await assignDriver({ loadId: l.id, driverId: d1, pay }, new Date(), W);
    await dispatchLoad(l.id, new Date(), {}, W);
    await recordDriverResponse(l.id, "accepted", new Date(), undefined, W);
    await startTrip(l.id, { arrivedAt: toCentralLocal(Date.now() - 30 * H), waitMinutes: "", seal: "" }, new Date(), W);
    const stops = await prisma.stop.findMany({ where: { loadId: l.id }, orderBy: { stopSequence: "asc" } });
    const done = await completeTrip(l.id, { deliveredAt: toCentralLocal(Date.now() - 2 * H), pod: "received", podNote: "Signed by J", fuel: "40", tolls: "", misc: "", stops: stops.map((s) => ({ id: s.id, arrivedAt: toCentralLocal(Date.now() - 3 * H), waitMinutes: "" })) }, new Date(), W);
    expect(done).toEqual({ ok: true });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).actualRevenue).not.toBeNull();

    expect(await reopenDelivered(l.id, "x", new Date(), W)).toMatchObject({ ok: false });
    expect(await reopenDelivered(l.id, "Wrong times entered", new Date(), W)).toEqual({ ok: true });
    const back = await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { assignment: true } });
    expect([back.status, back.assignment?.status, back.completedAt, back.actualRevenue, back.podNote]).toEqual(["in_progress", "in_progress", null, null, null]);
    expect(statesAgree(back.status, back.assignment?.status)).toBe(true);
    expect(await reopenDelivered(l.id, "Not delivered now", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("Only a delivered") });

    // invoiced, or on a statement: not reopened
    const billed = await mk({ status: "completed", completedAt: day(-3), paymentStatus: "invoiced", invoiceNumber: "P2-INV", invoicedAmount: 1000, invoicedAt: new Date() }, -5);
    await prisma.assignment.create({ data: { loadId: billed.id, driverId: d1, payKind: "cpm", payRate: 0.5, payEstimate: 100, status: "completed" } });
    expect(await reopenDelivered(billed.id, "Mistake", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("invoiced") });
    const paid = await mk({ status: "completed", completedAt: day(-6) }, -8);
    await prisma.assignment.create({ data: { loadId: paid.id, driverId: d1, payKind: "cpm", payRate: 0.5, payEstimate: 100, status: "completed" } });
    const st = await prisma.settlement.create({ data: { workspaceId: W, number: "P2-ST-1", driverId: d1, status: "final", periodStart: day(-10), periodEnd: day(-4), finalizedAt: day(-3), total: 100, lines: [] } });
    await prisma.settlementLoad.create({ data: { settlementId: st.id, loadId: paid.id, amount: 100 } });
    expect(await reopenDelivered(paid.id, "Mistake", new Date(), W)).toMatchObject({ ok: false, error: expect.stringContaining("driver statement") });
  });

  test("alerts: a pickup nobody entered, one truck on two loads, a delivery with no proof, and a delivery nobody invoiced for months", async () => {
    const { getAlerts, clearAlertCache } = await import("@/server/tl/alerts");
    clearAlertCache();
    const late = await mk({ vehicleId: houston }, -2); // pickup window closed two days ago
    await prisma.assignment.create({ data: { loadId: late.id, driverId: d2, payKind: "cpm", payRate: 0.5, payEstimate: 100, status: "accepted" } });
    await prisma.load.update({ where: { id: late.id }, data: { status: "accepted" } });
    const t1 = await mk({ loadNumber: "P2-T1", vehicleId: dallas }, 60);
    const t2 = await mk({ loadNumber: "P2-T2", vehicleId: dallas }, 60);
    const old = await mk({ status: "completed", completedAt: day(-200), closedWithoutPod: true }, -202); // never invoiced, 200 days ago
    const { alerts } = await getAlerts(new Date(), W, "all");
    const codes = (id: string) => alerts.filter((a) => a.loadId === id).map((a) => a.code);
    expect(codes(late.id)).toContain("LATE_TO_PICKUP");
    expect(codes(t1.id)).toContain("TRUCK_DOUBLE_BOOKED");
    expect(codes(t2.id)).toContain("TRUCK_DOUBLE_BOOKED");
    expect(codes(old.id)).toEqual(expect.arrayContaining(["READY_TO_INVOICE", "MISSING_POD"]));
  });

  test("the header's terminal narrows Invoices and Alerts: a Houston load is not in Dallas's list, and a load placed nowhere is in everyone's", async () => {
    const { countInvoices, listInvoiceRows } = await import("@/server/tl/queries");
    const { getAlertsInTerminal } = await import("@/server/tl/alerts");
    const mineD = await mk({ status: "completed", completedAt: day(-1), vehicleId: dallas, brokerName: "TD Co" }, -3);
    const mineH = await mk({ status: "completed", completedAt: day(-1), vehicleId: houston, brokerName: "TH Co" }, -3);
    const nowhere = await mk({ status: "completed", completedAt: day(-1), vehicleId: null, brokerName: "TN Co" }, -3);
    const ids = async (terminal: string | null) => (await listInvoiceRows(W, { scope: "ready", terminal })).map((r) => r.id);
    const all = await ids(null);
    expect([mineD.id, mineH.id, nowhere.id].every((i) => all.includes(i))).toBe(true);
    const dal = await ids("Dallas");
    expect(dal).toContain(mineD.id);
    expect(dal).toContain(nowhere.id);
    expect(dal).not.toContain(mineH.id);
    expect(await countInvoices("ready", W, undefined, "Dallas")).toBe(dal.length);
    expect(await countInvoices("ready", W, undefined, null)).toBe(all.length);
    const dalAlerts = await getAlertsInTerminal("Dallas", new Date(), W);
    expect(dalAlerts.alerts.some((a) => a.loadId === mineH.id)).toBe(false);
    expect(dalAlerts.alerts.some((a) => a.loadId === mineD.id)).toBe(true);
  });

  test("an uploaded file named like a sample is read as the file it is, never answered with the sample's canned reading", async () => {
    const { readRateCon } = await import("@/server/ratecon/reader");
    const sample = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf" }, { ANTHROPIC_API_KEY: undefined });
    expect(sample).toMatchObject({ ok: true, source: "demo" }); // the sample's own button
    const upload = await readRateCon({ fileName: "RC-AFB-482913_dallas-to-houston_cargo-van.pdf", mime: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) }, { ANTHROPIC_API_KEY: undefined });
    expect(upload).toEqual({ ok: false, reason: "no_key" }); // a real file with no key cannot be read: it is not the sample
  });

  test("two dispatchers assigning one driver to two loads at the same time: only one gets in without a reason", async () => {
    const { assignDriver } = await import("@/server/tl/dispatch");
    const a = await mk({ vehicleId: dallas }, 80);
    const b = await mk({ vehicleId: houston }, 80); // the same hours
    const two = await Promise.allSettled([assignDriver({ loadId: a.id, driverId: d1, pay }, new Date(), W), assignDriver({ loadId: b.id, driverId: d1, pay }, new Date(), W)]);
    expect(two.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = two.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(lost.reason.message)).toContain("Add a reason");
    expect(await prisma.assignment.count({ where: { driverId: d1, loadId: { in: [a.id, b.id] } } })).toBe(1);
  });
});
