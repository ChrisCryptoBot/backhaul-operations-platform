import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { clearHealthCache, getDataHealth } from "@/server/tl/data-health";

/**
 * Data health on real rows: the checks read the finished loads and the units of the terminals in view (a Dallas read never carries Memphis), the cross-source checks compare what is stored (card against the
 * load's fuel, rate confirmation against the invoice, position pings against billed miles), and one fleet never reads another's.
 *   DATABASE_URL=postgresql://demo:demo@localhost:54330/demo RUN_DB_INTEGRATION=true npx vitest run tests/integration/data-health.integration.test.ts
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "dh-w";
const OTHER = "dh-other";
const NOW = new Date();
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const DAY = 86_400_000;
const HOUR = 3_600_000;

async function wipe(id: string) {
  await prisma.workspace.deleteMany({ where: { id } });
}

describe.skipIf(!run)("data health", () => {
  const ids = { d1: "", d2: "", m1: "", dTruck: "", mTruck: "" };
  beforeAll(async () => {
    await wipe(W);
    await wipe(OTHER);
    await prisma.workspace.create({ data: { id: W, name: "DH fleet", plan: "enterprise" } });
    await prisma.workspace.create({ data: { id: OTHER, name: "DH other", plan: "enterprise" } });
    const dTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "DH Dallas Truck", terminal: "Dallas", mpg: 7, homeBaseAddress: "Dallas, TX" } });
    await prisma.costProfile.create({ data: { vehicleId: dTruck.id, estimatedMonthlyMiles: "7000", breakEvenRpm: "1.5" } as never });
    const mTruck = await prisma.vehicle.create({ data: { workspaceId: W, name: "DH Memphis Truck", terminal: "Memphis" } });
    ids.dTruck = dTruck.id;
    ids.mTruck = mTruck.id;
    const dDriver = await prisma.driver.create({ data: { workspaceId: W, name: "DH Dallas Driver", terminal: "Dallas", cdlExpiry: new Date("2031-01-01"), phone: "5550101" } });
    const mDriver = await prisma.driver.create({ data: { workspaceId: W, name: "DH Memphis Driver", terminal: "Memphis" } });
    await prisma.trailer.create({ data: { workspaceId: W, number: "DH-T1", terminal: "Dallas", registrationExpiry: new Date("2031-01-01") } });
    await prisma.trailer.create({ data: { workspaceId: W, number: "DH-T2", terminal: "Memphis" } });
    // A load of the other fleet that must never be read here.
    await prisma.load.create({ data: { workspaceId: OTHER, loadNumber: "DH-OTHER", status: "completed", quotedRevenue: 100, completedAt: ago(DAY) } });

    const base = { workspaceId: W, status: "completed", completedAt: ago(DAY), createdAt: ago(5 * DAY) };
    // D1: whole, billed what the rate confirmation promised, a fuel card within tolerance, pings that agree with the billed miles.
    const d1 = await prisma.load.create({ data: { ...base, vehicleId: dTruck.id, loadNumber: "DH-D1", brokerName: "DH Broker", originAddress: "Dallas, TX", destinationAddress: "Waco, TX", loadedMiles: 100, quotedRevenue: 1000, actualRevenue: 1000, marketBenchmark: 3.5, snapshotBaseFloorRpm: 1.5, expenseFuelActual: 200, podNote: "Signed by Sam", rateConPath: "rc/d1.pdf", paymentStatus: "invoiced", invoicedAmount: 1000, invoicedAt: ago(DAY) } });
    // D2: gaps (no market, no floor, no proof), billed $100 under the rate confirmation, a fuel card far from its fuel, pings that cover far fewer miles than billed.
    const d2 = await prisma.load.create({ data: { ...base, vehicleId: dTruck.id, loadNumber: "DH-D2", brokerName: "DH Broker", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 400, quotedRevenue: 1000, actualRevenue: 1000, expenseFuelActual: 150, rateConPath: "rc/d2.pdf", paymentStatus: "invoiced", invoicedAmount: 900, invoicedAt: ago(DAY) } });
    // M1: Memphis's, with almost nothing filled in.
    const m1 = await prisma.load.create({ data: { ...base, vehicleId: mTruck.id, loadNumber: "DH-M1", quotedRevenue: 700 } });
    ids.d1 = d1.id;
    ids.d2 = d2.id;
    ids.m1 = m1.id;
    await prisma.assignment.create({ data: { loadId: d1.id, driverId: dDriver.id, payKind: "cpm", payRate: 0.5, status: "completed" } });
    await prisma.assignment.create({ data: { loadId: d2.id, driverId: dDriver.id, payKind: "cpm", payRate: 0.5, status: "completed" } });
    await prisma.assignment.create({ data: { loadId: m1.id, driverId: mDriver.id, payKind: "cpm", payRate: 0.5, status: "completed" } });
    const stop = (loadId: string, seq: number, arrived: Date | null) => prisma.stop.create({ data: { loadId, stopSequence: seq, stopType: seq === 0 ? "pickup" : "delivery", stopRole: seq === 0 ? "pickup" : "delivery", addressString: "X", arrivedAt: arrived } });
    await stop(d1.id, 0, ago(DAY + 4 * HOUR));
    await stop(d1.id, 1, ago(DAY + HOUR));
    await stop(d2.id, 0, ago(DAY + 8 * HOUR));
    await stop(d2.id, 1, null);
    // Fuel card purchases tied to the loads.
    await prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "dh", externalId: "f1", loadId: d1.id, vehicleId: dTruck.id, postedAt: ago(DAY), amount: 210, gallons: 55 } });
    await prisma.fuelTransaction.create({ data: { workspaceId: W, provider: "dh", externalId: "f2", loadId: d2.id, vehicleId: dTruck.id, postedAt: ago(DAY), amount: 400, gallons: 100 } });
    // D1's truck ran about 100 miles, the billed 100; D2's truck left pings for about 100 of the 400 billed (but D2 has only one arrival, so it cannot be measured).
    const at = (i: number, from: number) => new Date(NOW.getTime() - from + i * 20 * 60_000);
    for (let i = 0; i < 10; i++) await prisma.vehiclePing.create({ data: { workspaceId: W, vehicleId: dTruck.id, lat: 30 + i * 0.16, lng: -97, at: at(i, DAY + 4 * HOUR) } });
    clearHealthCache();
  });
  afterAll(async () => {
    await wipe(W);
    await wipe(OTHER);
  });

  test("a Dallas read carries Dallas only; the whole fleet carries both; another fleet's loads are never read", async () => {
    const dallas = await getDataHealth({ period: "all", terminals: ["Dallas"] }, NOW, W);
    const all = await getDataHealth({ period: "all", terminals: null }, NOW, W);
    expect(dallas.counts).toEqual({ loads: 2, trucks: 1, drivers: 1, trailers: 1 });
    expect(all.counts).toEqual({ loads: 3, trucks: 2, drivers: 2, trailers: 2 });
    const memphis = await getDataHealth({ period: "all", terminals: ["Memphis"] }, NOW, W);
    expect(memphis.counts.loads).toBe(1);
    expect(memphis.completeness.checks.find((c) => c.key === "customer")!.examples.map((e) => e.label)).toEqual(["DH-M1"]);
    expect(all.completeness.checks.flatMap((c) => c.examples).some((e) => e.label === "DH-OTHER")).toBe(false);
  });

  test("the gaps are the loads and units that have them, and the score falls with them", async () => {
    const all = await getDataHealth({ period: "all", terminals: null }, NOW, W);
    const check = (k: string) => all.completeness.checks.find((c) => c.key === k)!;
    expect(check("market")).toMatchObject({ checked: 3, passed: 1, gaps: 2 });
    expect(check("floor").examples.map((e) => e.label).sort()).toEqual(["DH-D2", "DH-M1"]);
    expect(check("pod").gaps).toBe(2);
    expect(check("arrivals")).toMatchObject({ checked: 2, passed: 1, gaps: 1 }); // only loads with stops are checked: D2's second stop has no arrival
    expect(check("profile").examples.map((e) => e.label)).toEqual(["DH Memphis Truck"]);
    expect(check("medical").gaps).toBe(2);
    expect(check("inspection").gaps).toBe(2);
    const dallas = await getDataHealth({ period: "all", terminals: ["Dallas"] }, NOW, W);
    expect(dallas.completeness.score!).toBeGreaterThan(0);
    expect(all.completeness.score!).toBeLessThan(dallas.completeness.score!);
  });

  test("fuel: a card within tolerance matches; one far from the load's own fuel is off", async () => {
    const dallas = await getDataHealth({ period: "all", terminals: ["Dallas"] }, NOW, W);
    expect(dallas.fuel).toMatchObject({ withCard: 2, matched: 1, off: 1, offDollars: 250, hasCardData: true });
    expect(dallas.fuel.worst[0]).toMatchObject({ label: "DH-D2", card: 400, load: 150 });
  });

  test("rate confirmation against invoice: D1 matches, D2 was billed $100 under", async () => {
    const dallas = await getDataHealth({ period: "all", terminals: ["Dallas"] }, NOW, W);
    expect(dallas.rateCon).toMatchObject({ invoiced: 2, checkable: 2, matched: 1, under: 1, underDollars: 100, over: 0 });
    expect(dallas.rateCon.worst[0]).toMatchObject({ label: "DH-D2", promised: 1000, billed: 900 });
  });

  test("pings: the trip with two arrivals is measured against its billed miles; the one without is not", async () => {
    const dallas = await getDataHealth({ period: "all", terminals: ["Dallas"] }, NOW, W);
    expect(dallas.pings.measured).toBe(1);
    expect(dallas.pings.agreed).toBe(1);
    expect(dallas.pings.apart).toBe(0);
    expect(dallas.pingDays).toBe(7);
  });

  test("a period narrows the window: nothing finished a day ago is outside 'this month' only by the calendar, but the window start is returned", async () => {
    const h = await getDataHealth({ period: "4w", terminals: null }, NOW, W);
    expect(h.windowStart).toBeLessThanOrEqual(NOW.getTime() - 27 * DAY);
    expect(h.counts.loads).toBe(3);
  });
});
