import { describe, expect, it } from "vitest";
import { buildDeskKpi, type KpiLoadRow } from "@/server/tl/kpi";

const DAY = 86_400_000;
const now = new Date("2026-10-28T12:00:00Z");

function row(over: Partial<KpiLoadRow> & { id: string }): KpiLoadRow {
  return {
    status: "completed",
    updatedAt: new Date(now.getTime() - 5 * DAY),
    completedAt: new Date(now.getTime() - 5 * DAY),
    cancelledAt: null,
    actualRevenue: 1000,
    quotedRevenue: 1000,
    fuelSurcharge: 0,
    layoverPay: null,
    tonuRevenue: null,
    expenseFuelActual: 200,
    expenseTolls: 20,
    expenseMisc: 0,
    pickupDeadheadMiles: 50,
    loadedMiles: 400,
    returnDeadheadMiles: 50,
    quotedPickupDhMiles: null,
    quotedLoadedMiles: null,
    quotedReturnDhMiles: null,
    isBackhaul: false,
    brokerName: "Sample Freight Co",
    originAddress: "Dallas, TX",
    destinationAddress: "Atlanta, GA",
    marketBenchmark: 2.4,
    paymentStatus: null,
    invoicedAt: null,
    payTermsDays: null,
    invoicedAmount: null,
    loadNumber: `L-${over.id}`,
    createdAt: new Date(now.getTime() - 8 * DAY),
    scheduledDate: new Date(now.getTime() - 6 * DAY),
    verdict: null,
    assignment: null,
    ...over
  };
}

describe("desk KPI from TrueLane-shaped rows", () => {
  const rows: KpiLoadRow[] = [
    row({ id: "1", assignment: { driverName: "Alex Rivera", payKind: "cpm", payEstimate: 260, status: "completed" } }),
    row({ id: "2", actualRevenue: 2000, quotedRevenue: 2000, loadedMiles: 800, isBackhaul: true, completedAt: new Date(now.getTime() - 12 * DAY), assignment: { driverName: "Alex Rivera", payKind: "flat", payEstimate: 1400, status: "completed" } }),
    row({ id: "3", paymentStatus: "invoiced", invoicedAt: new Date(now.getTime() - 45 * DAY), payTermsDays: 30, invoicedAmount: 900 }),
    row({ id: "4", status: "draft", completedAt: null, actualRevenue: null, verdict: "reject" }),
    row({ id: "5", status: "in_progress", completedAt: null, actualRevenue: null, verdict: "accept", assignment: { driverName: "Sam Okafor", payKind: "cpm", payEstimate: 300, status: "in_progress" } }),
    row({ id: "6", status: "draft", completedAt: null, actualRevenue: null, verdict: "caution", assignment: { driverName: "Sam Okafor", payKind: "cpm", payEstimate: 300, status: "dispatched" } })
  ];
  const k = buildDeskKpi(rows, "all", now);

  it("sums revenue and counts finished loads with TrueLane's analytics", () => {
    expect(k.analytics.summary.loadCount).toBe(3);
    expect(k.analytics.summary.grossRevenue).toBe(4000);
    expect(k.analytics.summary.totalExpenses).toBe(660);
  });

  it("counts empty miles as a share of every mile driven", () => {
    // TrueLane counts every driven mile: loads 1 and 3 are 100 empty of 500 driven; load 2 is 100 empty (pickup + return) of 900.
    expect(k.deadheadShare).toBeCloseTo(300 / 1900, 4);
  });

  it("splits the pipeline and the verdict mix over open loads", () => {
    expect(k.pipeline).toEqual({ needsDriver: 1, sent: 1, onTheRoad: 1 });
    expect(k.verdictMix).toEqual({ accept: 1, caution: 1, reject: 1, needs_fuel: 0 });
  });

  it("ages the invoice: billed amount, overdue by 15 days", () => {
    expect(k.aging.count).toBe(1);
    expect(k.aging.totalOutstanding).toBe(900);
    expect(k.outstanding[0]!.daysPastDue).toBe(15);
  });

  it("rolls finished loads up by driver, with the display estimate owed", () => {
    expect(k.drivers).toHaveLength(1);
    expect(k.drivers[0]).toMatchObject({ name: "Alex Rivera", loads: 2, gross: 3000, payOwed: 1660 });
    expect(k.drivers[0]!.rpm).toBeCloseTo(3000 / (500 + 850), 4);
  });

  it("buckets revenue into twelve weeks, oldest first", () => {
    expect(k.weekly).toHaveLength(12);
    expect(k.weekly.reduce((s, w) => s + w.value, 0)).toBe(4000);
  });

  it("scopes to the month when asked", () => {
    const month = buildDeskKpi(rows, "month", now);
    expect(month.analytics.summary.loadCount).toBe(3); // all three finished inside October
    const ytdOnly = buildDeskKpi([row({ id: "9", completedAt: new Date("2025-03-01T00:00:00Z"), updatedAt: new Date("2025-03-01T00:00:00Z") })], "ytd", now);
    expect(ytdOnly.analytics.summary.loadCount).toBe(0);
  });
});
