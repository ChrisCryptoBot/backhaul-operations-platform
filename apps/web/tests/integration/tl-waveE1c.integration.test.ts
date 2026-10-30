import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { GET as pickDrivers } from "@/app/(desk)/drivers/pick/route";
import { agingSummary } from "@/server/tl/aging";
import { clearAlertCache, getAlerts } from "@/server/tl/alerts";
import { getDetentionRecovery } from "@/server/tl/detention";
import { clearKpiCache, getDeskKpi } from "@/server/tl/kpi";
import { countInvoices, listInvoiceRows } from "@/server/tl/queries";
import { getShellData } from "@/server/tl/shell";
import { unsettledByDriver } from "@/server/tl/settlement";

/**
 * Wave E1 on the demo database, in workspaces of their own: the kept KPI and alert answers move the moment the data under them does, the invoice lists are searched,
 * ordered and counted by the database, the detention scan names the loads somebody waited on, and the unsettled list reads plain columns but adds up the same pay.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const day = (d: string) => new Date(`${d}T17:00:00Z`);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

// A statement holds on to its loads and its driver (the database will not let a load go while a statement is paid on it), so they go first.
async function drop(id: string) {
  await prisma.settlementLoad.deleteMany({ where: { settlement: { workspaceId: id } } });
  await prisma.settlement.deleteMany({ where: { workspaceId: id } });
  await prisma.workspace.deleteMany({ where: { id } });
}
async function workspace(id: string) {
  await drop(id);
  await prisma.workspace.create({ data: { id, name: `E1 ${id}` } });
}

describe.skipIf(!run)("kept answers move with the data", () => {
  const W = "e1-kept";
  beforeAll(async () => {
    await workspace(W);
    clearKpiCache();
    clearAlertCache();
  });
  afterAll(() => drop(W));

  const finished = (loadNumber: string, quotedRevenue: number) =>
    prisma.load.create({ data: { workspaceId: W, loadNumber, brokerName: "E1K Broker", status: "completed", completedAt: daysAgo(3), quotedRevenue, loadedMiles: 100, originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK" } });

  test("the KPI is the same answer until a load changes, then it is worked out again", async () => {
    await finished("E1K-1", 1000);
    const first = await getDeskKpi({ period: "4w", compare: false }, new Date(), W);
    expect(first.current.loads).toBe(1);
    expect(await getDeskKpi({ period: "4w", compare: false }, new Date(), W)).toBe(first); // kept: the very same answer
    await finished("E1K-2", 500);
    const second = await getDeskKpi({ period: "4w", compare: false }, new Date(), W);
    expect(second).not.toBe(first);
    expect(second.current.loads).toBe(2);
  });

  test("a different period or filter is its own answer", async () => {
    const a = await getDeskKpi({ period: "4w", compare: false }, new Date(), W);
    const b = await getDeskKpi({ period: "all", compare: false }, new Date(), W);
    const c = await getDeskKpi({ period: "4w", compare: false, filters: { broker: "nobody" } }, new Date(), W);
    expect(new Set([a, b, c]).size).toBe(3);
    expect(c.current.loads).toBe(0);
  });

  test("a stop's wait changing moves it too (the dock waits are in the numbers)", async () => {
    const load = await finished("E1K-3", 700);
    const stop = await prisma.stop.create({ data: { loadId: load.id, stopSequence: 1, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", waitMinutes: 10, timeWindowLatest: daysAgo(3) } });
    const before = await getDeskKpi({ period: "4w", compare: false }, new Date(), W);
    await prisma.stop.update({ where: { id: stop.id }, data: { waitMinutes: 120 } });
    expect(await getDeskKpi({ period: "4w", compare: false }, new Date(), W)).not.toBe(before);
  });

  test("the alerts are kept per screen until the data moves, and the open-load ones see a new draft at once", async () => {
    const a = await getAlerts(new Date(), W, "shell");
    expect(await getAlerts(new Date(), W, "shell")).toBe(a);
    const draft = await prisma.load.create({
      data: { workspaceId: W, loadNumber: "E1K-DRAFT", status: "draft", quotedRevenue: 900, stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date(Date.now() + 3_600_000), timeWindowLatest: new Date(Date.now() + 7_200_000) }] } }
    });
    const b = await getAlerts(new Date(), W, "shell");
    expect(b).not.toBe(a);
    expect([...b.byLoad.keys()]).toContain(draft.id); // a pickup an hour away with nobody on it
  });

  test("the header's counts come from the same answers", async () => {
    const shell = await getShellData(W);
    expect(shell.counts.needsDriver).toBe(1);
    expect(shell.totals.open).toBe(1);
  });
});

describe.skipIf(!run)("invoice lists, a page at a time", () => {
  const W = "e1-invoices";
  beforeAll(async () => {
    await workspace(W);
    const make = (n: number, extra: Record<string, unknown>) =>
      prisma.load.create({ data: { workspaceId: W, loadNumber: `E1I-${String(n).padStart(3, "0")}`, brokerName: n % 2 ? "E1I Alpha" : "E1I Beta", poNumber: `PO-${n}`, status: "completed", completedAt: daysAgo(100 - n), quotedRevenue: 1000 + n, ...extra } });
    for (let n = 1; n <= 6; n++) await make(n, {}); // ready to invoice
    for (let n = 11; n <= 18; n++) await make(n, { paymentStatus: "invoiced", invoiceNumber: `INV-${n}`, invoicedAt: daysAgo(100 - n), payTermsDays: 30, invoicedAmount: 1000 + n });
    for (let n = 21; n <= 24; n++) await make(n, { paymentStatus: "paid", invoiceNumber: `INV-${n}`, invoicedAt: daysAgo(100 - n), paidAt: daysAgo(90 - n), paidAmount: 1000 + n, invoicedAmount: 1000 + n });
  });
  afterAll(() => drop(W));

  test("each list is counted by the database, and the search narrows only what is out", async () => {
    expect([await countInvoices("ready", W), await countInvoices("out", W), await countInvoices("paid", W)]).toEqual([6, 8, 4]);
    expect(await countInvoices("out", W, "alpha")).toBe(4);
    expect(await countInvoices("out", W, "INV-13")).toBe(1);
    expect(await countInvoices("out", W, "po-14 beta")).toBe(1); // every word must match something
    expect(await countInvoices("out", W, "po-14 alpha")).toBe(0);
  });

  test("what is waiting is oldest first, what is paid is newest first, and a page is a slice", async () => {
    const ready = await listInvoiceRows(W, { scope: "ready" });
    expect(ready.map((r) => r.loadNumber)).toEqual(["E1I-001", "E1I-002", "E1I-003", "E1I-004", "E1I-005", "E1I-006"]);
    const out = await listInvoiceRows(W, { scope: "out", take: 3 });
    expect(out.map((r) => r.invoiceNumber)).toEqual(["INV-11", "INV-12", "INV-13"]);
    const next = await listInvoiceRows(W, { scope: "out", skip: 3, take: 3 });
    expect(next.map((r) => r.invoiceNumber)).toEqual(["INV-14", "INV-15", "INV-16"]);
    const paid = await listInvoiceRows(W, { scope: "paid" });
    expect(paid.map((r) => r.invoiceNumber)).toEqual(["INV-24", "INV-23", "INV-22", "INV-21"]);
    expect((await listInvoiceRows(W, { scope: "out", q: "beta" })).every((r) => r.broker === "E1I Beta")).toBe(true);
  });

  test("the money owed and the overdue count read plain columns and agree with TrueLane's aging rule", async () => {
    const aging = await agingSummary(Date.now(), W);
    expect(aging.count).toBe(8);
    expect(aging.totalOutstanding).toBe(8 * 1000 + (11 + 12 + 13 + 14 + 15 + 16 + 17 + 18));
    expect(aging.overdueCount).toBe(8); // sent 70+ days ago on 30-day terms
    expect(aging.oldestDaysOverdue).toBeGreaterThan(40);
  });
});

describe.skipIf(!run)("detention: only loads somebody waited on are read", () => {
  const W = "e1-detention";
  beforeAll(async () => {
    await workspace(W);
    const truck = await prisma.vehicle.create({ data: { workspaceId: W, name: "E1D Truck", costProfile: { create: { monthlyInsurance: 800, monthlyAuthority: 100, monthlyPhoneSubscriptions: 60, monthlyLoanPayment: 0, estimatedMonthlyMiles: 7000, maintenanceReservePerMile: 0.15, tireReservePerMile: 0.04, driverHourlyTarget: 25, lastFuelPricePerGallon: 3.9, breakEvenRpm: 1.5, survivalFloorRpm: 1.2, archetype: "solo_owner", detentionHourlyRate: 60 } } } });
    const load = (loadNumber: string, extra: Record<string, unknown> = {}) => prisma.load.create({ data: { workspaceId: W, loadNumber, vehicleId: truck.id, status: "completed", completedAt: daysAgo(5), quotedRevenue: 1000, brokerName: "E1D Broker", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", ...extra } });
    const withStop = async (l: { id: string }, wait: number | null) => prisma.stop.create({ data: { loadId: l.id, stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", waitMinutes: wait } });
    await withStop(await load("E1D-LONG"), 240); // four hours at the dock
    await withStop(await load("E1D-NONE"), null); // no wait recorded
    await withStop(await load("E1D-ZERO"), 0); // none at all
    await load("E1D-DOCK", { dockWaitMinutes: 300 }); // a total only, on the load
    await withStop(await load("E1D-OLD", { completedAt: daysAgo(200) }), 240); // too long ago to bill
  });
  afterAll(() => drop(W));

  test("the loads that waited past their free time are the ones listed, with what is still owed", async () => {
    const d = await getDetentionRecovery(W);
    expect(d.rows.map((r) => r.loadNumber).sort()).toEqual(["E1D-DOCK", "E1D-LONG"]);
    const long = d.rows.find((r) => r.loadNumber === "E1D-LONG")!;
    expect(long.unbilled).toBeGreaterThan(100); // 240 minutes at $60 an hour, less the free time
    expect(d.unbilledLoads).toBe(2);
    expect(d.totalUnbilled).toBeCloseTo(d.rows.reduce((s, r) => s + r.unbilled, 0), 2);
  });
});

describe.skipIf(!run)("the unsettled list adds up each kind of pay from plain columns", () => {
  const W = "e1-unsettled";
  beforeAll(async () => {
    await workspace(W);
    const driver = await prisma.driver.create({ data: { workspaceId: W, name: "E1U Driver", cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01") } });
    const make = async (n: number, pay: { payKind: string; payRate: number; payEstimate?: number }) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `E1U-${n}`, status: "completed", completedAt: daysAgo(n), quotedRevenue: 1000, fuelSurcharge: 100, loadedMiles: 200 } });
      await prisma.assignment.create({ data: { loadId: l.id, driverId: driver.id, status: "completed", ...pay } });
    };
    await make(1, { payKind: "cpm", payRate: 0.5 }); //             200 miles x 0.50 = 100
    await make(2, { payKind: "flat", payRate: 250 }); //            250
    await make(3, { payKind: "percent", payRate: 20 }); //          20% of 1,100 = 220
    await make(4, { payKind: "hourly", payRate: 20, payEstimate: 100 }); // 5 hours = 100
    await make(5, { payKind: "hourly", payRate: 20 }); //           needs hours
  });
  afterAll(() => drop(W));

  test("one row per driver with the pay of every load and a period that covers them", async () => {
    const [row, ...rest] = await unsettledByDriver(W);
    expect(rest).toEqual([]);
    expect(row).toMatchObject({ driverName: "E1U Driver", loads: 5, amount: 100 + 250 + 220 + 100, hourlyWithoutHours: 1 });
    expect(row!.start <= row!.end).toBe(true);
  });

  test("a load on a final statement is no longer unsettled", async () => {
    const load = await prisma.load.findFirstOrThrow({ where: { workspaceId: W, loadNumber: "E1U-1" } });
    const driver = await prisma.driver.findFirstOrThrow({ where: { workspaceId: W } });
    const statement = await prisma.settlement.create({ data: { workspaceId: W, number: "ST-E1U", driverId: driver.id, status: "final", periodStart: daysAgo(30), periodEnd: daysAgo(0), finalizedAt: new Date(), total: 100, lines: [] } });
    await prisma.settlementLoad.create({ data: { settlementId: statement.id, loadId: load.id, amount: 100 } });
    const [row] = await unsettledByDriver(W);
    expect(row).toMatchObject({ loads: 4, amount: 250 + 220 + 100 });
  });
});

describe.skipIf(!run)("the driver search also finds drivers who are out of service when asked", () => {
  const W = "demo-workspace";
  beforeAll(async () => {
    await prisma.driver.create({ data: { workspaceId: W, name: "E1X Retired Driver", active: false, cdlExpiry: day("2031-01-01"), medicalCardExpiry: day("2031-01-01") } });
  });
  afterAll(async () => {
    await prisma.driver.deleteMany({ where: { workspaceId: W, name: "E1X Retired Driver" } });
  });

  test("the assign box offers only drivers in service; the statement box can reach the rest", async () => {
    const names = async (url: string) => ((await (await pickDrivers(new Request(url))).json()) as { drivers: Array<{ name: string }> }).drivers.map((d) => d.name);
    expect(await names("http://desk.test/drivers/pick?q=E1X")).toEqual([]);
    expect(await names("http://desk.test/drivers/pick?q=E1X&inactive=1")).toEqual(["E1X Retired Driver"]);
  });
});
