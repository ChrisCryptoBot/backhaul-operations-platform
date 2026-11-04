import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prisma } from "@/lib/db";
import { daysPastDue } from "@/lib/overdue";
import { agingSummary, clearAgingCache } from "@/server/tl/aging";
import { assignDriver } from "@/server/tl/dispatch";
import { saveExpenses } from "@/server/tl/execution";
import { getInvoice } from "@/server/tl/invoicing";
import { countInvoices, listInvoiceRows } from "@/server/tl/queries";
import { getSettlement, startSettlement, unsettledByDriver } from "@/server/tl/settlement";
import { listPayroll } from "@/server/partners/payroll";

/**
 * One money view: the aging the header and the Invoices screen show is one aggregate that agrees with the lists beside it, day by day, terminal by terminal; an invoice reads the same
 * on the list and the sheet; the driver statements say a short pay and a TONU; an hourly driver's estimate is real and follows the miles. A workspace of its own, so the numbers are exact.
 */
const run = process.env.RUN_DB_INTEGRATION === "true";
const W = "im-w";
const NOW = new Date("2026-11-20T18:00:00Z"); // 12:00 in Dallas
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe.skipIf(!run)("invoices, one money view, on the demo database", () => {
  const ids: Record<string, string> = {};
  let driverId = "";

  beforeAll(async () => {
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
    await prisma.workspace.create({ data: { id: W, name: "IM desk", plan: "enterprise" } });
    const dallas = await prisma.vehicle.create({ data: { workspaceId: W, name: "IM Dallas", type: "box_truck", terminal: "Dallas" } as never });
    const houston = await prisma.vehicle.create({ data: { workspaceId: W, name: "IM Houston", type: "box_truck", terminal: "Houston" } as never });
    driverId = (await prisma.driver.create({ data: { workspaceId: W, name: "IM Driver", terminal: "Dallas" } as never })).id;
    const out = async (key: string, over: Record<string, unknown>) => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: `IM-${key}`, brokerName: "IM Customer", originAddress: "Dallas, TX", destinationAddress: "Tulsa, OK", loadedMiles: 200, status: "completed", completedAt: daysAgo(60), quotedRevenue: 1000, ...over } as never });
      ids[key] = l.id;
    };
    // Invoiced loads, each sent on its own day on Net 30: not yet due, due today, 5 and 45 and 95 days late.
    await out("A", { vehicleId: dallas.id, paymentStatus: "invoiced", invoiceNumber: "IM-A", invoicedAt: daysAgo(10), invoicedAmount: 1000, payTermsDays: 30 });
    await out("B", { vehicleId: dallas.id, paymentStatus: "invoiced", invoiceNumber: "IM-B", invoicedAt: daysAgo(30), invoicedAmount: 800, payTermsDays: 30 });
    await out("C", { vehicleId: houston.id, paymentStatus: "invoiced", invoiceNumber: "IM-C", invoicedAt: daysAgo(35), invoicedAmount: 1000, paidAmount: 400, payTermsDays: 30 });
    await out("D", { vehicleId: houston.id, paymentStatus: "invoiced", invoiceNumber: "IM-D", invoicedAt: daysAgo(75), invoicedAmount: 500, payTermsDays: 30 });
    await out("E", { paymentStatus: "invoiced", invoiceNumber: "IM-E", invoicedAt: daysAgo(125), invoicedAmount: 300, payTermsDays: 30 });
    // An invoice from before amounts were kept (no amount stored), and a paid one that is not out.
    await out("L", { vehicleId: dallas.id, paymentStatus: "invoiced", invoiceNumber: "IM-L", invoicedAt: daysAgo(5), fuelSurcharge: 50, payTermsDays: 30 });
    await out("P", { vehicleId: dallas.id, paymentStatus: "paid", invoiceNumber: "IM-P", invoicedAt: daysAgo(50), invoicedAmount: 700, paidAmount: 640, writeOffAmount: 60, writeOffReason: "Lumper deducted", paidAt: daysAgo(20), payTermsDays: 30 });
  });
  afterAll(async () => {
    await prisma.auditEvent.deleteMany({ where: { workspaceId: W } });
    await prisma.settlement.deleteMany({ where: { workspaceId: W } });
    await prisma.workspace.deleteMany({ where: { id: W } });
  });

  test("the aging is one aggregate: what is owed, what is late, and by how much", async () => {
    clearAgingCache();
    const a = await agingSummary(NOW.getTime(), W);
    // A 1000 (due in 20), B 800 (due today), C 600 owing of 1000 (5 late), D 500 (45 late), E 300 (95 late), L 1050 (legacy: rate + surcharge, due in 25)
    expect(a).toMatchObject({ count: 6, totalOutstanding: 4250, overdueCount: 3, overdueAmount: 1400, oldestDaysOverdue: 95, nextDueInDays: null });
    expect(a.buckets.current).toEqual({ count: 3, amount: 2850 });
    expect(a.buckets.d1_30).toEqual({ count: 1, amount: 600 });
    expect(a.buckets.d31_60).toEqual({ count: 1, amount: 500 });
    expect(a.buckets.d61_90).toEqual({ count: 0, amount: 0 });
    expect(a.buckets.d90plus).toEqual({ count: 1, amount: 300 });
    // The buckets add up to the whole.
    const all = Object.values(a.buckets);
    expect(all.reduce((n, b) => n + b.count, 0)).toBe(a.count);
    expect(all.reduce((n, b) => n + b.amount, 0)).toBe(a.totalOutstanding);
  });

  test("it agrees with the overdue rule the lists use, invoice by invoice, on the Dallas calendar", async () => {
    const rows = await listInvoiceRows(W, { scope: "out" });
    const late = rows.filter((r) => (daysPastDue(r.invoicedAt, r.payTermsDays, NOW) ?? 0) > 0);
    const a = await agingSummary(NOW.getTime(), W);
    expect(late.length).toBe(a.overdueCount);
    expect(late.reduce((s, r) => s + r.balance, 0)).toBe(a.overdueAmount);
    expect(rows.reduce((s, r) => s + r.balance, 0)).toBe(a.totalOutstanding);
  });

  test("the day turning in Dallas turns an invoice late, though it is still the same day in UTC", async () => {
    // B is due today (sent 30 days ago on Net 30): late from the next Dallas day.
    const noon = await agingSummary(NOW.getTime(), W);
    clearAgingCache();
    const nextMorning = await agingSummary(new Date("2026-11-21T06:30:00Z").getTime(), W); // 00:30 in Dallas on the 21st
    expect(nextMorning.overdueCount).toBe(noon.overdueCount + 1);
    clearAgingCache();
  });

  test("it is narrowed to a terminal the way the lists are", async () => {
    clearAgingCache();
    const dallas = await agingSummary(NOW.getTime(), W, "Dallas");
    const rows = await listInvoiceRows(W, { scope: "out", terminal: "Dallas" });
    expect(dallas.count).toBe(rows.length);
    expect(dallas.totalOutstanding).toBe(rows.reduce((s, r) => s + r.balance, 0));
    expect(await countInvoices("out", W, undefined, "Dallas")).toBe(dallas.count);
    // Dallas: A, B, L on its truck, and E, which is not placed anywhere yet.
    expect(rows.map((r) => r.invoiceNumber).sort()).toEqual(["IM-A", "IM-B", "IM-E", "IM-L"]);
  });

  test("an invoice reads the same on the list and the sheet, legacy ones included", async () => {
    const list = (await listInvoiceRows(W, { scope: "out" })).find((r) => r.invoiceNumber === "IM-L")!;
    const sheet = (await getInvoice(ids.L!, W))!;
    expect(list.amount).toBe(1050);
    expect(sheet.total).toBe(1050);
    expect(sheet.balance).toBe(1050);
    const part = (await getInvoice(ids.C!, W))!;
    expect([part.total, part.paidAmount, part.balance]).toEqual([1000, 400, 600]);
    const paid = (await getInvoice(ids.P!, W))!;
    expect([paid.writeOffAmount, paid.writeOffReason]).toEqual([60, "Lumper deducted"]);
    const row = (await listInvoiceRows(W, { scope: "paid" }))[0]!;
    expect([row.writeOffAmount, row.writeOffReason, row.paidDifference]).toEqual([60, "Lumper deducted", -60]);
  });

  test("a load waiting to be invoiced shows what the dialog will bill, detention included", async () => {
    const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "IM-R", brokerName: "IM Customer", status: "completed", completedAt: daysAgo(2), quotedRevenue: 900, fuelSurcharge: 100, loadedMiles: 100 } as never });
    const [row] = (await listInvoiceRows(W, { scope: "ready" })).filter((r) => r.loadNumber === "IM-R");
    expect(row!.amount).toBe(1000);
    expect(row!.readyAmount).toBe(1000 + row!.detentionBillable);
    expect(row!.defaultNumber).toBe("INV-IM-R");
    await prisma.load.delete({ where: { id: l.id } });
  });

  describe("driver statements", () => {
    test("a short-paid load and a TONU are said on the unsettled list, and the statement says so too", async () => {
      const pay = (n: string, over: Record<string, unknown>) =>
        prisma.load.create({ data: { workspaceId: W, loadNumber: `IM-S${n}`, brokerName: "IM Customer", loadedMiles: 100, quotedRevenue: 1000, ...over, assignment: { create: { driverId, payKind: "percent", payRate: 20, payEstimate: 200, status: "completed" } } } as never });
      const okLoad = await pay("1", { status: "completed", completedAt: daysAgo(3), paymentStatus: "paid", invoicedAmount: 1000, paidAmount: 1000 });
      const short = await pay("2", { status: "completed", completedAt: daysAgo(2), paymentStatus: "paid", invoicedAmount: 1000, paidAmount: 900, writeOffAmount: 100, writeOffReason: "Damage claim" });
      await pay("3", { status: "tonu", cancelledAt: daysAgo(2), tonuRevenue: 150 });
      const u = (await unsettledByDriver(W, NOW)).find((x) => x.driverId === driverId)!;
      expect(u).toMatchObject({ loads: 2, amount: 400, paidShort: 1, tonu: 1 });
      const started = await startSettlement({ driverId, start: u.start, end: u.end }, NOW, W);
      if (!started.ok) throw new Error("setup");
      const view = (await getSettlement(started.id, W))!;
      expect(view.loads.map((l) => l.brokerStatus).sort()).toEqual(["paid", "paid_short"]);
      expect(view.statement.cautions.join(" ")).toContain("paid short by the customer");
      expect(view.statement.loadsTotal).toBe(400); // the percent is still on the agreed rate
      await prisma.settlement.delete({ where: { id: started.id } });
      await prisma.load.deleteMany({ where: { id: { in: [okLoad.id, short.id] } } });
    });

    test("an hourly driver's estimate is the trip's hours, not nothing, and follows the miles once they are corrected", async () => {
      const l = await prisma.load.create({ data: { workspaceId: W, loadNumber: "IM-H", brokerName: "IM Customer", status: "draft", quotedRevenue: 800, loadedMiles: 400, pickupDeadheadMiles: 0, returnDeadheadMiles: 100, isBackhaul: false, stops: { create: [{ stopSequence: 1, stopType: "pickup", stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: new Date("2030-01-10T14:00:00Z"), timeWindowLatest: new Date("2030-01-10T16:00:00Z") }, { stopSequence: 2, stopType: "delivery", stopRole: "delivery", addressString: "Tulsa, OK", timeWindowEarliest: new Date("2030-01-10T22:00:00Z") }] } } as never });
      const hourly = (await prisma.driver.create({ data: { workspaceId: W, name: "IM Hourly", terminal: "Dallas" } as never })).id;
      await assignDriver({ loadId: l.id, driverId: hourly, pay: { kind: "hourly", rate: 20 } }, NOW, W);
      // 500 miles at 50 mph is 10 hours: $200.
      expect(Number((await prisma.assignment.findUniqueOrThrow({ where: { loadId: l.id } })).payEstimate)).toBe(200);
      await prisma.load.update({ where: { id: l.id }, data: { status: "in_progress" } });
      await prisma.assignment.update({ where: { loadId: l.id }, data: { status: "in_progress" } });
      expect(await saveExpenses(l.id, { fuel: "", tolls: "", misc: "", miles: { pickup: "", loaded: "450", home: "" } }, NOW, W)).toMatchObject({ ok: true, changed: true });
      // 550 miles: 11 hours, $220.
      expect(Number((await prisma.assignment.findUniqueOrThrow({ where: { loadId: l.id } })).payEstimate)).toBe(220);
      await prisma.assignment.deleteMany({ where: { loadId: l.id } });
      await prisma.load.delete({ where: { id: l.id } });
    });
  });

  test("payroll counts what is ready to send apart from what waits on something", async () => {
    const mk = async (n: string, over: Record<string, unknown>, d?: Record<string, unknown>) => {
      const dr = await prisma.driver.create({ data: { workspaceId: W, name: `IM PR ${n}`, ...(d ?? {}) } as never });
      await prisma.settlement.create({ data: { workspaceId: W, driverId: dr.id, number: `ST-IM-${n}`, status: "final", periodStart: new Date("2026-10-12T00:00:00Z"), periodEnd: new Date("2026-10-18T00:00:00Z"), total: 500, finalizedAt: NOW, ...over } as never });
    };
    await mk("ok", {}, { payrollWorkerType: "contractor", payrollEmployeeId: "E1" });
    await mk("unset", {});
    await mk("paid", { paidAt: NOW, paidMethod: "check" }, { payrollWorkerType: "contractor", payrollEmployeeId: "E2" });
    await mk("zero", { total: 0 }, { payrollWorkerType: "contractor", payrollEmployeeId: "E3" });
    const p = await listPayroll({ filter: "all" }, W);
    expect([p.unsent, p.ready]).toEqual([4, 1]);
    const dates = p.rows.find((r) => r.number === "ST-IM-ok")!;
    expect(dates.periodStart.toISOString().slice(0, 10)).toBe("2026-10-12");
  });
});
