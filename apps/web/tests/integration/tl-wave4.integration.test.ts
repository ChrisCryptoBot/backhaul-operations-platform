import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { computeCostProfileFloorBreakdown } from "@/truelane/lib/domain/calculators";
import { assignDriver, DispatchError, dispatchLoad } from "@/server/tl/dispatch";
import { cancelLoad, recordTonu, rescheduleLoad } from "@/server/tl/disruptions";
import { getDetentionRecovery } from "@/server/tl/detention";
import { invoiceLoad } from "@/server/tl/invoicing";
import { getAlerts } from "@/server/tl/alerts";
import { getDeskKpi } from "@/server/tl/kpi";
import { getPlannerData } from "@/server/tl/planner";
import { listAudit, listLoadAudit } from "@/server/tl/audit";
import { getTruckDetail, saveCostProfile, saveDriver, saveTruck, setDriverActive, setTruckArchived } from "@/server/tl/fleet";
import { num } from "@/server/tl/convert";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own driver, truck and loads (all named W4), and removes
 * them and their audit events afterwards, so the demo data is left as the seed wrote it.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;
const D = 24 * H;

describe.skipIf(!run)("disruptions, detention, fleet editing, planner and brokers on the demo database", () => {
  const startedAt = new Date();
  const loadIds: string[] = [];
  let driverId = "";
  let truckId = "";
  const base = Date.now() + 30 * D; // clear of every seeded load

  async function makeLoad(n: string, startOff: number, endOff: number, over: Record<string, unknown> = {}, stopOver: Record<string, unknown> = {}) {
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        vehicleId: truckId,
        loadNumber: `W4-${n}`,
        status: "draft",
        brokerName: "W4 Broker",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 700,
        scheduledDate: new Date(base + startOff),
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(base + startOff), timeWindowLatest: new Date(base + startOff + 3 * H), referenceNumbers: ["PU"], ...stopOver },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date(base + endOff - 4 * H), timeWindowLatest: new Date(base + endOff), referenceNumbers: ["DEL"] }
          ]
        },
        ...over
      }
    });
    loadIds.push(l.id);
    return l;
  }

  beforeAll(async () => {
    const t = await saveTruck({ name: "W4 Truck", type: "tractor", mpg: "6.5", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    truckId = t.id;
    const p = await saveCostProfile(truckId, { monthlyInsurance: "1000", monthlyAuthority: "100", monthlyPhoneSubscriptions: "50", monthlyLoanPayment: "0", estimatedMonthlyMiles: "6000", maintenanceReservePerMile: "0.15", tireReservePerMile: "0.04", detentionHourlyRate: "60", freeGraceMinutes: "120", lastFuelPricePerGallon: "3.9" });
    if (!p.ok) throw new Error("profile");
    const d = await saveDriver({ name: "W4 Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: loadIds } }, { createdAt: { gte: startedAt }, entity: "fleet" }] } });
    await prisma.load.deleteMany({ where: { id: { in: loadIds } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W4" } } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: { startsWith: "W4" } } });
  });

  test("cancelling takes the driver off, keeps the reason on the load and in the audit log, and refuses what makes no sense", async () => {
    const l = await makeLoad("C1", 2 * D, 3 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 400 } });
    await expect(cancelLoad({ loadId: l.id, reason: "mystery" })).rejects.toMatchObject({ code: "bad_reason" });
    await expect(cancelLoad({ loadId: l.id, reason: "other", note: " " })).rejects.toMatchObject({ code: "bad_reason" });

    await cancelLoad({ loadId: l.id, reason: "broker_cancelled", note: "Broker found a cheaper truck" });
    const after = await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { assignment: true } });
    expect(after).toMatchObject({ status: "cancelled", cancelReason: "broker_cancelled" });
    expect(after.cancelledAt).toBeInstanceOf(Date);
    expect(after.assignment).toBeNull();
    const [ev] = await listLoadAudit(l.id);
    expect(ev).toMatchObject({ action: "cancelled", reason: "Broker found a cheaper truck", before: { Driver: "W4 Driver" }, after: { Status: "Cancelled", Reason: "Broker cancelled" } });

    await expect(cancelLoad({ loadId: l.id, reason: "pulled" })).rejects.toMatchObject({ code: "not_allowed" }); // already cancelled
    const done = await makeLoad("C2", -3 * D, -2 * D, { status: "completed", completedAt: new Date() });
    await expect(cancelLoad({ loadId: done.id, reason: "pulled" })).rejects.toBeInstanceOf(DispatchError);
  });

  test("a TONU closes the load, earns its fee and keeps the driver's trip; it needs a driver already on the way and a fee", async () => {
    const draft = await makeLoad("T0", 4 * D, 5 * D);
    await expect(recordTonu({ loadId: draft.id, reason: "shipper_not_ready", fee: 150 })).rejects.toMatchObject({ code: "not_allowed" });

    const l = await makeLoad("T1", 4 * D, 5 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 400 } });
    await dispatchLoad(l.id);
    await prisma.assignment.update({ where: { loadId: l.id }, data: { status: "accepted" } });
    await prisma.load.update({ where: { id: l.id }, data: { status: "accepted" } });
    await expect(recordTonu({ loadId: l.id, reason: "shipper_not_ready", fee: 0 })).rejects.toMatchObject({ code: "bad_fee" });

    const before = await getDeskKpi({ period: "all", compare: false });
    await recordTonu({ loadId: l.id, reason: "shipper_not_ready", fee: 175, note: "Dock closed" });
    const after = await prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { assignment: true } });
    expect(after).toMatchObject({ status: "tonu", cancelReason: "shipper_not_ready" });
    expect(num(after.tonuRevenue)).toBe(175);
    expect(after.assignment!.status).toBe("completed");

    const kpi = await getDeskKpi({ period: "all", compare: false });
    expect(kpi.reliability.tonu).toBe(before.reliability.tonu + 1);
    expect(kpi.current.tonuLoads).toBe(before.current.tonuLoads + 1);
    expect(kpi.current.gross).toBeCloseTo(before.current.gross + 175, 2);
    expect(kpi.reliability.reasons.find((r) => r.key === "shipper_not_ready")!.count).toBe((before.reliability.reasons.find((r) => r.key === "shipper_not_ready")?.count ?? 0) + 1);
  });

  test("rescheduling moves every stop by the same amount, asks a driver who had it to confirm again, and will not put a driver in two places", async () => {
    const l = await makeLoad("R1", 6 * D, 7 * D);
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "flat", rate: 400 } });
    await dispatchLoad(l.id);
    const was = await prisma.stop.findMany({ where: { loadId: l.id }, orderBy: { stopSequence: "asc" } });

    await expect(rescheduleLoad({ loadId: l.id, reason: "nonsense", newPickup: new Date(base + 6 * D + D) })).rejects.toMatchObject({ code: "bad_reason" });
    await expect(rescheduleLoad({ loadId: l.id, reason: "weather_road", newPickup: was[0]!.timeWindowEarliest! })).rejects.toMatchObject({ code: "bad_time" });

    await rescheduleLoad({ loadId: l.id, reason: "weather_road", note: "Ice on I-35", newPickup: new Date(was[0]!.timeWindowEarliest!.getTime() + 1 * D) });
    const now = await prisma.stop.findMany({ where: { loadId: l.id }, orderBy: { stopSequence: "asc" } });
    for (const [i, s] of now.entries()) {
      expect(s.timeWindowEarliest!.getTime() - was[i]!.timeWindowEarliest!.getTime()).toBe(D);
      expect(s.timeWindowLatest!.getTime() - was[i]!.timeWindowLatest!.getTime()).toBe(D);
    }
    const a = await prisma.assignment.findUniqueOrThrow({ where: { loadId: l.id } });
    expect(a.status).toBe("dispatched");
    expect(a.respondedAt).toBeNull();
    expect(a.assignmentVersion).toBeGreaterThan(2);
    const [ev] = await listLoadAudit(l.id);
    expect(ev).toMatchObject({ action: "rescheduled", reason: "Ice on I-35" });
    expect(ev!.summary).toContain("has to confirm again");

    // a second load for the same driver, then try to move the first on top of it
    const other = await makeLoad("R2", 12 * D, 13 * D);
    await assignDriver({ loadId: other.id, driverId, pay: { kind: "flat", rate: 400 } });
    const mid = (await prisma.stop.findFirstOrThrow({ where: { loadId: l.id }, orderBy: { stopSequence: "asc" } })).timeWindowEarliest!;
    await expect(rescheduleLoad({ loadId: l.id, reason: "equipment", newPickup: new Date(base + 12 * D + 2 * H) })).rejects.toMatchObject({ code: "double_booked" });
    expect((await prisma.stop.findFirstOrThrow({ where: { loadId: l.id }, orderBy: { stopSequence: "asc" } })).timeWindowEarliest!.getTime()).toBe(mid.getTime()); // nothing moved

    const going = await makeLoad("R3", 20 * D, 21 * D, { status: "in_progress" });
    await expect(rescheduleLoad({ loadId: going.id, reason: "equipment", newPickup: new Date(base + 21 * D) })).rejects.toMatchObject({ code: "not_allowed" });
  });

  test("detention: what a stop waited past the free time is owed, shows as unbilled and as an alert, and goes on the invoice when asked", async () => {
    const l = await makeLoad("D1", -6 * D, -5 * D, { status: "completed", completedAt: new Date(base - 5 * D) }, { waitMinutes: 200 });
    await prisma.stop.updateMany({ where: { loadId: l.id, stopSequence: 2 }, data: { waitMinutes: 100 } }); // 200 - 120 = 80 min at the pickup, the delivery was inside the free time

    const rec = await getDetentionRecovery();
    const row = rec.rows.find((r) => r.loadId === l.id)!;
    expect(row).toMatchObject({ billableMinutes: 80, billable: 80, unbilled: 80, invoiced: false });
    expect(rec.totalUnbilled).toBeGreaterThanOrEqual(80);
    expect((await getAlerts()).alerts.some((a) => a.loadId === l.id && a.code === "DETENTION_UNBILLED")).toBe(true);

    const out = await invoiceLoad(l.id, { includeDetention: true });
    expect(out).toMatchObject({ ok: true, detention: 80 });
    const inv = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect(num(inv.invoicedAmount)).toBe(780); // 700 rate + 80 detention
    const [ev] = await listLoadAudit(l.id);
    expect(ev!.after).toMatchObject({ Detention: "$80.00" });
    const after = (await getDetentionRecovery()).rows.find((r) => r.loadId === l.id)!;
    expect(after).toMatchObject({ billedExtra: 80, unbilled: 0, invoiced: true });
    expect((await getAlerts()).alerts.some((a) => a.loadId === l.id && a.code === "DETENTION_UNBILLED")).toBe(false);

    // an invoice sent without it leaves it owed
    const left = await makeLoad("D2", -9 * D, -8 * D, { status: "completed", completedAt: new Date(base - 8 * D) }, { waitMinutes: 180 });
    await invoiceLoad(left.id, { includeDetention: false });
    expect((await getDetentionRecovery()).rows.find((r) => r.loadId === left.id)).toMatchObject({ billable: 60, billedExtra: 0, unbilled: 60, invoiced: true });
  });

  test("drivers: added with their dates, changed with a before and after, never silently edited, and held in service while on an open load", async () => {
    expect(await saveDriver({ name: "", cdlExpiry: "2031-02-31" }, null)).toMatchObject({ ok: false, errors: { name: expect.any(String), cdlExpiry: expect.any(String) } });
    const added = await saveDriver({ name: "W4 Second", phone: "555-0123", cdlClass: "B", cdlExpiry: "2030-06-30", assignedVehicleId: truckId }, null);
    if (!added.ok) throw new Error("add");
    expect((await listAudit({ group: "fleet", q: "W4 Second" })).rows[0]).toMatchObject({ action: "driver_added", after: { Name: "W4 Second", Truck: "W4 Truck" } });

    expect(await saveDriver({ name: "W4 Second", phone: "555-0123", cdlClass: "B", cdlExpiry: "2030-06-30", assignedVehicleId: truckId }, added.id)).toMatchObject({ ok: true, changed: false });
    expect(await saveDriver({ name: "W4 Second", phone: "555-0199", cdlClass: "B", cdlExpiry: "2030-06-30", assignedVehicleId: truckId }, added.id)).toMatchObject({ ok: true, changed: true });
    const ev = (await listAudit({ group: "fleet", q: "W4 Second" })).rows.find((e) => e.action === "driver_changed")!;
    expect(ev).toMatchObject({ before: { Phone: "555-0123" }, after: { Phone: "555-0199" } });
    expect(await saveDriver({ name: "W4 Second", assignedVehicleId: "nope" }, added.id)).toMatchObject({ ok: false, errors: { assignedVehicleId: expect.any(String) } });

    const l = await makeLoad("F1", 40 * D, 41 * D);
    await assignDriver({ loadId: l.id, driverId: added.id, pay: { kind: "flat", rate: 400 } });
    const blocked = await setDriverActive(added.id, false);
    expect(blocked).toMatchObject({ ok: false });
    if (!blocked.ok) expect(blocked.error).toContain("W4-F1");
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: added.id } })).active).toBe(true);

    await prisma.assignment.deleteMany({ where: { loadId: l.id } });
    expect(await setDriverActive(added.id, false)).toEqual({ ok: true });
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: added.id } })).active).toBe(false);
    expect(await setDriverActive(added.id, true)).toEqual({ ok: true }); // the undo
    expect((await listAudit({ group: "fleet", q: "W4 Second" })).rows.map((e) => e.action)).toEqual(expect.arrayContaining(["driver_deactivated", "driver_reactivated"]));
  });

  test("trucks: names are unique, a truck on an open load cannot be archived, and archiving frees its drivers", async () => {
    expect(await saveTruck({ name: "w4 truck" }, null)).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    const extra = await saveTruck({ name: "W4 Spare", type: "box_truck" }, null);
    if (!extra.ok) throw new Error("add");
    await prisma.driver.update({ where: { id: driverId }, data: { assignedVehicleId: extra.id } });
    const l = await makeLoad("F2", 50 * D, 51 * D, { vehicleId: extra.id });
    const blocked = await setTruckArchived(extra.id, true);
    expect(blocked).toMatchObject({ ok: false });
    if (!blocked.ok) expect(blocked.error).toContain("W4-F2");

    await prisma.load.update({ where: { id: l.id }, data: { status: "cancelled" } });
    expect(await setTruckArchived(extra.id, true)).toEqual({ ok: true });
    const gone = await prisma.vehicle.findUniqueOrThrow({ where: { id: extra.id } });
    expect(gone.archivedAt).not.toBeNull();
    expect((await prisma.driver.findUniqueOrThrow({ where: { id: driverId } })).assignedVehicleId).toBeNull();
    expect(await saveDriver({ name: "W4 Driver", assignedVehicleId: extra.id }, driverId)).toMatchObject({ ok: false, errors: { assignedVehicleId: expect.any(String) } }); // an archived truck is not on offer
    expect(await setTruckArchived(extra.id, false)).toEqual({ ok: true });
  });

  test("the cost profile: the floor stored is TrueLane's, recomputed on the server, and a change is audited with the floor before and after", async () => {
    const detail = (await getTruckDetail(truckId))!;
    const fixed = 1000 + 100 + 50;
    const expected = computeCostProfileFloorBreakdown({ monthlyInsurance: 1000, monthlyAuthority: 100, monthlyPhoneSubscriptions: 50, monthlyLoanPayment: 0, estimatedMonthlyMiles: 6000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04 });
    expect(detail.stored!.breakEven).toBeCloseTo(expected.breakEvenRpm, 4);
    expect(detail.stored!.breakEven).toBeCloseTo(fixed / 6000 + 0.19, 4);

    const out = await saveCostProfile(truckId, { ...Object.fromEntries(Object.entries(detail.numbers).map(([k, v]) => [k, v == null ? "" : String(v)])), monthlyInsurance: "1600" });
    expect(out).toMatchObject({ ok: true, changed: true });
    if (!out.ok) return;
    const bumped = computeCostProfileFloorBreakdown({ monthlyInsurance: 1600, monthlyAuthority: 100, monthlyPhoneSubscriptions: 50, monthlyLoanPayment: 0, estimatedMonthlyMiles: 6000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04 });
    expect(out.floors!.breakEven).toBeCloseTo(bumped.breakEvenRpm, 4);
    expect(num((await prisma.costProfile.findUniqueOrThrow({ where: { vehicleId: truckId } })).breakEvenRpm)).toBeCloseTo(bumped.breakEvenRpm, 4);

    const ev = (await listAudit({ group: "fleet", q: "W4 Truck" })).rows.find((e) => e.action === "cost_profile_changed" && e.before && (e.before as Record<string, unknown>)["Insurance ($ a month)"] === 1000)!;
    expect(ev.after).toMatchObject({ "Insurance ($ a month)": 1600 });
    expect(String(ev.before!["Break-even floor"])).toMatch(/^\$\d\.\d\d\/mi$/);

    expect(await saveCostProfile(truckId, { ...Object.fromEntries(Object.entries(detail.numbers).map(([k, v]) => [k, v == null ? "" : String(v)])), monthlyInsurance: "1600" })).toMatchObject({ ok: true, changed: false });
    expect(await saveCostProfile(truckId, { monthlyInsurance: "x", estimatedMonthlyMiles: "" })).toMatchObject({ ok: false, errors: { monthlyInsurance: expect.any(String), estimatedMonthlyMiles: "Required." } });
  });

  test("the planner puts an open load in its driver's row, flags an overlap, and chases a stop whose window closed with nobody there", async () => {
    const t0 = Date.now();
    const a = await makeLoad("P1", t0 - 10 * H - base, t0 + 20 * H - base, { status: "in_progress" }); // picked up 10 h ago
    await prisma.stop.updateMany({ where: { loadId: a.id, stopSequence: 1 }, data: { arrivedAt: new Date(t0 - 9 * H) } });
    await prisma.stop.updateMany({ where: { loadId: a.id, stopSequence: 2 }, data: { timeWindowEarliest: new Date(t0 - 4 * H), timeWindowLatest: new Date(t0 - 2 * H) } }); // the delivery window closed 2 h ago, nobody there
    await prisma.assignment.create({ data: { loadId: a.id, driverId, payKind: "flat", payRate: 300, status: "in_progress" } });

    const p = await getPlannerData(Date.now(), Date.now(), 7);
    expect(p.days).toHaveLength(7);
    const mine = p.rows.find((r) => r.driverId === driverId)!;
    expect(mine.cells.flat().some((i) => i.loadId === a.id)).toBe(true);
    const chase = p.watchlist.find((w) => w.loadId === a.id && w.state === "past_due");
    expect(chase).toMatchObject({ stopRole: "delivery", driverName: "W4 Driver" });
    expect(chase!.minutesOver).toBeGreaterThanOrEqual(119);
    expect(p.watchlist.find((w) => w.loadId === a.id && w.stopRole === "pickup")).toMatchObject({ state: "done", late: expect.any(Boolean) });
  });

  test("brokers add up: their loads are the finished loads, and what they let fall through is what the reliability card counts", async () => {
    const k = await getDeskKpi({ period: "all", compare: false });
    expect(k.brokers.reduce((s, b) => s + b.loads, 0)).toBe(k.current.loads);
    expect(k.brokers.reduce((s, b) => s + b.lost, 0)).toBe(k.reliability.lost);
    expect(k.brokers.reduce((s, b) => s + b.gross, 0)).toBeCloseTo(k.current.gross, 2);
    expect(k.reliability.lost).toBe(k.reliability.cancelled + k.reliability.tonu);
    expect(k.reliability.reasons.reduce((s, r) => s + r.count, 0)).toBe(k.reliability.lost);
    expect(k.current.onTimeArrivals).not.toBeNull();
    expect(k.current.onTimeArrivals!).toBeGreaterThan(0.5);
    expect(k.current.onTimeArrivals!).toBeLessThan(1); // the seed has late arrivals
  });
});
