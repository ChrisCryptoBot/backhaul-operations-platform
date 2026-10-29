import { describe, expect, it } from "vitest";
import { buildDeskKpi, type KpiLoadRow, type KpiOptions } from "@/server/tl/kpi";
import { THRESHOLD_DEFAULTS } from "@/lib/thresholds";

const DAY = 86_400_000;
const now = new Date("2026-10-28T12:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * DAY);
const all: KpiOptions = { period: "all", compare: false, filters: {} };

function row(over: Partial<KpiLoadRow> & { id: string }): KpiLoadRow {
  return {
    status: "completed",
    updatedAt: ago(5),
    completedAt: ago(5),
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
    createdAt: ago(8),
    scheduledDate: ago(6),
    paidAt: null,
    snapshotBaseFloorRpm: null,
    vehicleName: "Unit 101",
    verdict: null,
    stops: [],
    assignment: null,
    ...over
  };
}

describe("desk KPI from TrueLane-shaped rows", () => {
  const rows: KpiLoadRow[] = [
    row({ id: "1", assignment: { driverName: "Alex Rivera", payKind: "cpm", payEstimate: 260, status: "completed" } }),
    row({ id: "2", actualRevenue: 2000, quotedRevenue: 2000, loadedMiles: 800, isBackhaul: true, completedAt: ago(12), updatedAt: ago(12), assignment: { driverName: "Alex Rivera", payKind: "flat", payEstimate: 1400, status: "completed" } }),
    row({ id: "3", paymentStatus: "invoiced", invoicedAt: ago(45), payTermsDays: 30, invoicedAmount: 900 }),
    row({ id: "4", status: "draft", completedAt: null, actualRevenue: null, verdict: "reject" }),
    row({ id: "5", status: "in_progress", completedAt: null, actualRevenue: null, verdict: "accept", assignment: { driverName: "Sam Okafor", payKind: "cpm", payEstimate: 300, status: "in_progress" } }),
    row({ id: "6", status: "draft", completedAt: null, actualRevenue: null, verdict: "caution", assignment: { driverName: "Sam Okafor", payKind: "cpm", payEstimate: 300, status: "dispatched" } })
  ];
  const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);

  it("sums revenue and counts finished loads with TrueLane's analytics", () => {
    expect(k.analytics.summary.loadCount).toBe(3);
    expect(k.analytics.summary.grossRevenue).toBe(4000);
    expect(k.analytics.summary.totalExpenses).toBe(660);
    expect(k.current).toMatchObject({ loads: 3, gross: 4000, expenses: 660, netEstimate: 3340 });
  });

  it("counts empty miles as a share of every mile driven", () => {
    // TrueLane counts every driven mile: loads 1 and 3 are 100 empty of 500 driven; load 2 is 100 empty (pickup + return) of 900.
    expect(k.current.emptyShare).toBeCloseTo(300 / 1900, 4);
    expect(k.current.emptyMiles).toBe(300);
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

  it("rolls finished loads up by driver, with the display estimate owed and each driver's own empty share", () => {
    expect(k.drivers).toHaveLength(1);
    expect(k.drivers[0]).toMatchObject({ name: "Alex Rivera", loads: 2, gross: 3000, payOwed: 1660, drivenMiles: 1400, emptyMiles: 200 });
    expect(k.drivers[0]!.rpm).toBeCloseTo(3000 / (500 + 850), 4);
    expect(k.drivers[0]!.emptyShare).toBeCloseTo(200 / 1400, 4);
  });

  it("buckets revenue into twelve trailing weeks, oldest first", () => {
    expect(k.trend).toHaveLength(12);
    expect(k.trend.reduce((s, w) => s + w.gross, 0)).toBe(4000);
    expect(k.trend.reduce((s, w) => s + w.loads, 0)).toBe(3);
    for (let i = 1; i < 12; i++) expect(k.trend[i]!.end).toBeGreaterThan(k.trend[i - 1]!.end);
  });

  it("scopes to the month when asked, and to nothing outside it", () => {
    const month = buildDeskKpi(rows, { ...all, period: "month" }, THRESHOLD_DEFAULTS, now);
    expect(month.current.loads).toBe(3); // all three finished inside October
    const ytdOnly = buildDeskKpi([row({ id: "9", completedAt: new Date("2025-03-01T00:00:00Z"), updatedAt: new Date("2025-03-01T00:00:00Z") })], { ...all, period: "ytd" }, THRESHOLD_DEFAULTS, now);
    expect(ytdOnly.current.loads).toBe(0);
    expect(ytdOnly.current.emptyShare).toBeNull();
  });

  it("carries the thresholds it was given", () => {
    expect(k.thresholds).toEqual(THRESHOLD_DEFAULTS);
    expect(buildDeskKpi(rows, all, { ...THRESHOLD_DEFAULTS, emptyRedPct: 50 }, now).thresholds.emptyRedPct).toBe(50);
  });
});

describe("comparing a period with the one before it", () => {
  const rows = [
    row({ id: "a", completedAt: ago(3), updatedAt: ago(3), actualRevenue: 1500, quotedRevenue: 1500 }),
    row({ id: "b", completedAt: ago(10), updatedAt: ago(10), actualRevenue: 500, quotedRevenue: 500 }),
    row({ id: "c", completedAt: ago(35), updatedAt: ago(35), actualRevenue: 1000, quotedRevenue: 1000 }),
    row({ id: "d", completedAt: ago(60), updatedAt: ago(60), actualRevenue: 9000, quotedRevenue: 9000 })
  ];

  it("the last four weeks sit against the four weeks before, and nothing older leaks in", () => {
    const k = buildDeskKpi(rows, { period: "4w", compare: true, filters: {} }, THRESHOLD_DEFAULTS, now);
    expect(k.current).toMatchObject({ loads: 2, gross: 2000 });
    expect(k.prior).toMatchObject({ loads: 1, gross: 1000 });
    expect(k.previous!.end).toBe(k.window.start! - 1);
  });

  it("with compare off, or for all time, there is no prior period", () => {
    expect(buildDeskKpi(rows, { period: "4w", compare: false, filters: {} }, THRESHOLD_DEFAULTS, now).prior).toBeNull();
    expect(buildDeskKpi(rows, { period: "all", compare: true, filters: {} }, THRESHOLD_DEFAULTS, now).prior).toBeNull();
  });

  it("an empty prior period is zeros, not missing", () => {
    const k = buildDeskKpi([rows[0]!], { period: "4w", compare: true, filters: {} }, THRESHOLD_DEFAULTS, now);
    expect(k.prior).toMatchObject({ loads: 0, gross: 0, emptyShare: null, rpm: null });
  });
});

describe("the new measures", () => {
  it("cleared the floor: pay after tracked costs, per mile driven, against the floor frozen at accept", () => {
    const k = buildDeskKpi(
      [
        row({ id: "ok", snapshotBaseFloorRpm: 1.2 }), // (1000 - 220) / 500 = 1.56
        row({ id: "short", actualRevenue: 500, quotedRevenue: 500, snapshotBaseFloorRpm: 1.2 }), // (500 - 220) / 500 = 0.56
        row({ id: "nofloor", snapshotBaseFloorRpm: null }), // no frozen floor: not judged
        row({ id: "tonu", status: "tonu", tonuRevenue: 150, snapshotBaseFloorRpm: 1.2 }) // a TONU is not judged
      ],
      all,
      THRESHOLD_DEFAULTS,
      now
    );
    expect(k.current.judgedLoads).toBe(2);
    expect(k.current.clearedFloor).toBe(0.5);
  });

  it("paid within terms and days to pay, using the load's terms and falling back to the default", () => {
    const paid = (id: string, daysToPay: number, terms: number | null) => row({ id, paymentStatus: "paid", invoicedAt: ago(60), paidAt: ago(60 - daysToPay), payTermsDays: terms });
    const rows = [paid("fast", 15, 30), paid("slow", 40, 30), paid("noterms", 20, null), row({ id: "unpaid", paymentStatus: "invoiced", invoicedAt: ago(10), payTermsDays: 30 })];
    const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
    expect(k.current.paidLoads).toBe(3);
    expect(k.current.paidWithinTerms).toBeCloseTo(2 / 3, 6); // 15 and 20 (default 30) are in time, 40 is not
    expect(k.current.avgDaysToPay).toBeCloseTo((15 + 40 + 20) / 3, 6);
    const strict = buildDeskKpi(rows, all, { ...THRESHOLD_DEFAULTS, defaultPayTermsDays: 10 }, now);
    expect(strict.current.paidWithinTerms).toBeCloseTo(1 / 3, 6); // 20 days is now late against a 10-day default
  });

  it("average wait is over the stops that have one recorded, and honestly empty when none do", () => {
    const withWaits = buildDeskKpi([row({ id: "w1", stops: [{ waitMinutes: 30 }, { waitMinutes: null }] }), row({ id: "w2", stops: [{ waitMinutes: 150 }] })], all, THRESHOLD_DEFAULTS, now);
    expect(withWaits.current).toMatchObject({ avgWaitMinutes: 90, waitStops: 2 });
    const none = buildDeskKpi([row({ id: "n" })], all, THRESHOLD_DEFAULTS, now);
    expect(none.current.avgWaitMinutes).toBeNull();
    expect(none.current.avgDaysToPay).toBeNull();
    expect(none.current.paidWithinTerms).toBeNull();
    expect(none.current.clearedFloor).toBeNull();
  });
});

describe("filters, drivers and lanes", () => {
  const rows = [
    row({ id: "1", brokerName: "Northline Brokerage", vehicleName: "Unit 101", assignment: { driverName: "Alex Rivera", payKind: "cpm", payEstimate: 100, status: "completed" } }), // 100 / 500 empty
    row({ id: "2", brokerName: "Northline Brokerage", vehicleName: "Unit 101", assignment: { driverName: "Alex Rivera", payKind: "cpm", payEstimate: 100, status: "completed" } }),
    row({ id: "3", brokerName: "Blue Mesa Logistics", vehicleName: "Unit 102", pickupDeadheadMiles: 200, loadedMiles: 600, returnDeadheadMiles: 200, assignment: { driverName: "Sam Okafor", payKind: "flat", payEstimate: 300, status: "completed" } }), // 400 / 1000 empty
    row({ id: "4", originAddress: "Houston, TX", destinationAddress: "Memphis, TN", marketBenchmark: null, vehicleName: "Unit 102", assignment: { driverName: "Sam Okafor", payKind: "flat", payEstimate: 300, status: "completed" } })
  ];

  it("each filter narrows everything, and the menus still offer every choice", () => {
    const k = buildDeskKpi(rows, { period: "all", compare: false, filters: { broker: "Northline Brokerage" } }, THRESHOLD_DEFAULTS, now);
    expect(k.current.loads).toBe(2);
    expect(k.choices.brokers).toEqual(["Blue Mesa Logistics", "Northline Brokerage", "Sample Freight Co"]);
    expect(k.choices.drivers).toEqual(["Alex Rivera", "Sam Okafor"]);
    expect(k.choices.trucks).toEqual(["Unit 101", "Unit 102"]);
    expect(buildDeskKpi(rows, { period: "all", compare: false, filters: { driver: "Sam Okafor" } }, THRESHOLD_DEFAULTS, now).current.loads).toBe(2);
    expect(buildDeskKpi(rows, { period: "all", compare: false, filters: { truck: "Unit 102", lane: "Houston, TX → Memphis, TN" } }, THRESHOLD_DEFAULTS, now).current.loads).toBe(1);
    expect(buildDeskKpi(rows, { period: "all", compare: false, filters: { broker: "Nobody" } }, THRESHOLD_DEFAULTS, now).current.loads).toBe(0);
  });

  it("a driver's empty share is a ratio of sums over that driver's miles", () => {
    const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
    const alex = k.drivers.find((d) => d.name === "Alex Rivera")!;
    const sam = k.drivers.find((d) => d.name === "Sam Okafor")!;
    expect(alex.emptyShare).toBeCloseTo(200 / 1000, 6);
    expect(sam.drivenMiles).toBe(1500);
    expect(sam.emptyMiles).toBe(500); // 400 on load 3, 100 on load 4
    expect(sam.emptyShare).toBeCloseTo(500 / 1500, 6);
  });

  it("lanes: loads, empty split before the pickup and after the delivery, and the rate against the market", () => {
    const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
    const dallas = k.lanes.find((l) => l.key === "Dallas, TX → Atlanta, GA")!;
    expect(dallas.loads).toBe(3);
    expect(dallas.avgPickupEmpty).toBeCloseTo((50 + 50 + 200) / 3, 6);
    expect(dallas.avgReturnEmpty).toBeCloseTo((50 + 50 + 200) / 3, 6);
    // pay 1000 + 1000 + 1000 against market 1200 + 1200 + 2400 (2.4 x 1000 planned miles): 3000 vs 4800, so 37.5% under
    expect(dallas.marketVariancePct).toBeCloseTo((3000 - 4800) / 4800, 6);
    expect(dallas.status).toBe("below");
    const houston = k.lanes.find((l) => l.key === "Houston, TX → Memphis, TN")!;
    expect(houston).toMatchObject({ benchmarked: 0, marketVariancePct: null, status: "unknown" });
    expect(k.lanes[0]!.key).toBe("Dallas, TX → Atlanta, GA"); // most loads first
  });

  it("a lane that pays over the market is above it", () => {
    const k = buildDeskKpi([row({ id: "hi", marketBenchmark: 1.0 })], all, THRESHOLD_DEFAULTS, now);
    expect(k.lanes[0]!.status).toBe("above");
    expect(k.lanes[0]!.marketVariancePct).toBeCloseTo((1000 - 500) / 500, 6);
  });

  it("the variance list has one entry per finished freight load, null where no market rate was captured, and skips TONUs", () => {
    const k = buildDeskKpi([...rows, row({ id: "t", status: "tonu", tonuRevenue: 100 })], all, THRESHOLD_DEFAULTS, now);
    expect(k.variance).toHaveLength(4);
    expect(k.variance.filter((v) => v == null)).toHaveLength(1);
    expect(k.variance[0]).toBeCloseTo((1000 - 1200) / 1200, 6);
  });
});
