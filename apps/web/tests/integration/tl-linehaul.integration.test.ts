import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { toCentralLocal } from "@/lib/zoned";
import { assignDriver, dispatchLoad, recordDriverResponse } from "@/server/tl/dispatch";
import { completeTrip, startTrip } from "@/server/tl/execution";
import { saveDriver, saveTruck } from "@/server/tl/fleet";
import { invoiceLoad } from "@/server/tl/invoicing";

/**
 * Needs a seeded database (see tl-dispatch.integration.test.ts). Makes its own truck, driver and loads (all named LH) and removes them afterwards. Every window is in 2027.
 * The linehaul actually paid, typed at delivery, becomes the load's actual revenue and what the invoice starts from.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const WS = "demo-workspace";
const H = 3_600_000;

describe.skipIf(!run)("linehaul actually paid at delivery", () => {
  let driverId = "";
  const day = (d: string, hour: number) => new Date(`${d}T${String(hour).padStart(2, "0")}:00:00Z`);

  const onTheRoad = async (n: string, d: string) => {
    const l = await prisma.load.create({
      data: {
        workspaceId: WS,
        loadNumber: `LH-${n}`,
        brokerName: "LH Broker",
        status: "draft",
        originAddress: "Dallas, TX",
        destinationAddress: "Tulsa, OK",
        loadedMiles: 260,
        quotedRevenue: 1000,
        scheduledDate: day(d, 14),
        stops: {
          create: [
            { stopSequence: 1, stopType: "pickup", addressString: "Dallas, TX", timeWindowEarliest: day(d, 14), timeWindowLatest: day(d, 16), referenceNumbers: [`PU-${n}`] },
            { stopSequence: 2, stopType: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: day(d, 22), timeWindowLatest: day(d, 23), referenceNumbers: [`DL-${n}`] }
          ]
        }
      }
    });
    await assignDriver({ loadId: l.id, driverId, pay: { kind: "cpm", rate: 0.6 } });
    await dispatchLoad(l.id);
    await recordDriverResponse(l.id, "accepted");
    expect(await startTrip(l.id, { arrivedAt: toCentralLocal(Date.now() - 5 * H), waitMinutes: "", seal: "" })).toEqual({ ok: true });
    return prisma.load.findUniqueOrThrow({ where: { id: l.id }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  };
  const deliver = (l: Awaited<ReturnType<typeof onTheRoad>>, over: Record<string, unknown> = {}) =>
    completeTrip(l.id, { stops: [{ id: l.stops[1]!.id, arrivedAt: toCentralLocal(Date.now() - 2 * H), waitMinutes: "" }], deliveredAt: toCentralLocal(Date.now() - H), pod: "received", podNote: "Signed BOL", fuel: "", tolls: "", misc: "", ...over });

  beforeAll(async () => {
    const t = await saveTruck({ name: "LH Truck", type: "box_truck", mpg: "9", fuelType: "diesel" }, null);
    if (!t.ok) throw new Error("truck");
    const d = await saveDriver({ name: "LH Driver", cdlClass: "A", cdlExpiry: "2031-01-31", medicalCardExpiry: "2031-01-31", assignedVehicleId: t.id, payKind: "cpm", payRate: "0.60" }, null);
    if (!d.ok) throw new Error("driver");
    driverId = d.id;
  });

  afterAll(async () => {
    const mine = await prisma.load.findMany({ where: { workspaceId: WS, brokerName: "LH Broker" }, select: { id: true } });
    const ids = mine.map((l) => l.id);
    await prisma.auditEvent.deleteMany({ where: { OR: [{ loadId: { in: ids } }, { summary: { contains: "LH Driver" } }, { summary: { contains: "LH Truck" } }] } });
    await prisma.load.deleteMany({ where: { id: { in: ids } } });
    await prisma.driver.deleteMany({ where: { workspaceId: WS, name: "LH Driver" } });
    await prisma.vehicle.deleteMany({ where: { workspaceId: WS, name: "LH Truck" } });
  });

  test("blank keeps the rate on the load", async () => {
    const l = await onTheRoad("A", "2027-03-01");
    expect(await deliver(l)).toEqual({ ok: true });
    const done = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect(Number(done.actualRevenue)).toBe(1000);
    const delivered = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: l.id, action: "delivered" } });
    expect(delivered.summary).not.toContain("linehaul paid");
  });

  test("a short pay becomes what the load earned, is said in the audit, and is where the invoice starts", async () => {
    const l = await onTheRoad("B", "2027-03-02");
    expect(await deliver(l, { actualRevenue: "850.25" })).toEqual({ ok: true });
    const done = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect(Number(done.actualRevenue)).toBe(850.25);
    expect(Number(done.quotedRevenue)).toBe(1000); // the rate on the load is not rewritten
    const delivered = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: l.id, action: "delivered" } });
    expect(delivered.summary).toContain("linehaul paid $850.25 (the load said $1000.00)");
    expect(delivered.after).toMatchObject({ "Linehaul paid": "$850.25" });
    const inv = await invoiceLoad(l.id, { form: { number: "LH-B", terms: "30", detention: false, lumper: "", layover: "", otherLabel: "", other: "" } });
    expect(inv).toMatchObject({ ok: true });
    const billed = await prisma.load.findUniqueOrThrow({ where: { id: l.id } });
    expect(Number(billed.invoicedAmount)).toBe(850.25);
  });

  test("a seal typed at the delivery is kept on that stop and audited; a blank one leaves what is there", async () => {
    const l = await onTheRoad("D", "2027-03-04");
    await prisma.stop.update({ where: { id: l.stops[1]!.id }, data: { sealNumber: "OLD-1" } });
    expect(await deliver(l, { stops: [{ id: l.stops[1]!.id, arrivedAt: toCentralLocal(Date.now() - 2 * H), waitMinutes: "", seal: "" }] })).toEqual({ ok: true });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: l.stops[1]!.id } })).sealNumber).toBe("OLD-1");
    const m = await onTheRoad("E", "2027-03-05");
    expect(await deliver(m, { stops: [{ id: m.stops[1]!.id, arrivedAt: toCentralLocal(Date.now() - 2 * H), waitMinutes: "", seal: "S-4471" }] })).toEqual({ ok: true });
    expect((await prisma.stop.findUniqueOrThrow({ where: { id: m.stops[1]!.id } })).sealNumber).toBe("S-4471");
    const delivered = await prisma.auditEvent.findFirstOrThrow({ where: { loadId: m.id, action: "delivered" } });
    expect(delivered.after).toMatchObject({ Seals: "2: S-4471" });
  });

  test("a bad amount is refused and nothing is written", async () => {
    const l = await onTheRoad("C", "2027-03-03");
    expect(await deliver(l, { actualRevenue: "-5" })).toMatchObject({ ok: false, errors: { actualRevenue: expect.any(String) } });
    expect((await prisma.load.findUniqueOrThrow({ where: { id: l.id } })).status).toBe("in_progress");
  });
});
