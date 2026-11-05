import { describe, expect, it } from "vitest";
import { buildDeskKpi, type KpiLoadRow, type KpiOptions } from "@/server/tl/kpi";
import { THRESHOLD_DEFAULTS } from "@/lib/thresholds";

/**
 * The KPI quick wins on plain rows: SLA split by pickup and drop, lead time, fuel surcharge, the tracker's mile columns, load mix, lane targets and their week-by-week grid, rolled loads,
 * tender acceptance, and empty miles by truck.
 */
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
    fuelSurcharge: 100,
    layoverPay: null,
    tonuRevenue: null,
    expenseFuelActual: 200,
    expenseTolls: 0,
    expenseMisc: 0,
    pickupDeadheadMiles: 50,
    loadedMiles: 400,
    returnDeadheadMiles: 30,
    quotedPickupDhMiles: null,
    quotedLoadedMiles: null,
    quotedReturnDhMiles: null,
    isBackhaul: false,
    brokerName: "Alpha Freight",
    originAddress: "Dallas, TX",
    destinationAddress: "Atlanta, GA",
    marketBenchmark: null,
    paymentStatus: null,
    invoicedAt: null,
    payTermsDays: null,
    invoicedAmount: null,
    loadNumber: `L-${over.id}`,
    createdAt: ago(10),
    scheduledDate: ago(7),
    paidAt: null,
    cancelReason: null,
    snapshotBaseFloorRpm: null,
    vehicleName: "Unit 1",
    verdict: null,
    trailerType: "dry_van",
    loadType: "general",
    stops: [],
    assignment: null,
    ...over
  };
}

const stop = (role: string, onTime: boolean) => ({ waitMinutes: 30, role, arrivedAt: new Date(ago(5).getTime() + (onTime ? -3_600_000 : 3_600_000)), timeWindowLatest: ago(5) });

describe("SLA by pickup and drop, lead time, fuel surcharge and the tracker's mile columns", () => {
  const rows = [
    row({ id: "1", stops: [stop("pickup", true), stop("delivery", true)] }),
    row({ id: "2", stops: [stop("pickup", false), stop("delivery", true)], createdAt: ago(8), scheduledDate: ago(7) }),
    row({ id: "3", brokerName: "Beta Co", stops: [stop("pickup", true), stop("delivery", false)], fuelSurcharge: 300, loadedMiles: 600, pickupDeadheadMiles: 0, returnDeadheadMiles: 100 })
  ];
  const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);

  it("splits on-time into pickups and drops with the number of stops behind each", () => {
    expect(k.current.pickupStops).toBe(3);
    expect(k.current.dropStops).toBe(3);
    expect(k.current.onTimePickup).toBeCloseTo(2 / 3, 10);
    expect(k.current.onTimeDrop).toBeCloseTo(2 / 3, 10);
    expect(k.current.onTimeArrivals).toBeCloseTo(4 / 6, 10); // the all-stops figure is unchanged
  });

  it("gives each customer its own on-time share and lead time", () => {
    const alpha = k.brokers.find((b) => b.name === "Alpha Freight")!;
    const beta = k.brokers.find((b) => b.name === "Beta Co")!;
    expect(alpha.onTimeArrivals).toBeCloseTo(3 / 4, 10);
    expect(alpha.arrivalStops).toBe(4);
    expect(beta.onTimeArrivals).toBeCloseTo(1 / 2, 10);
    expect(alpha.leadDays).toBeCloseTo((3 + 1) / 2, 10);
    expect(beta.leadDays).toBeCloseTo(3, 10);
  });

  it("lead time is days from booking to pickup over loads that have both, null when none do", () => {
    expect(k.current.leadDays).toBeCloseTo((3 + 1 + 3) / 3, 10);
    expect(k.current.leadLoads).toBe(3);
    const none = buildDeskKpi([row({ id: "9", scheduledDate: null })], all, THRESHOLD_DEFAULTS, now);
    expect(none.current.leadDays).toBeNull();
    expect(none.current.leadLoads).toBe(0);
  });

  it("sums the surcharge in dollars, per loaded mile and as a share of the line haul", () => {
    expect(k.current.fuelSurcharge).toBe(500);
    expect(k.current.lineHaul).toBe(3000);
    expect(k.current.loadedMiles).toBe(1400);
    expect(k.current.fscPerMile).toBeCloseTo(500 / 1400, 10);
    expect(k.current.fscPct).toBeCloseTo(500 / 3000, 10);
  });

  it("carries the tracker's mile columns: loaded, empty before and after, and every mile driven", () => {
    expect(k.current.pickupEmptyMiles).toBe(100);
    expect(k.current.returnEmptyMiles).toBe(160);
    expect(k.current.pickupEmptyMiles + k.current.returnEmptyMiles).toBe(k.current.emptyMiles);
    const lane = k.lanes.find((l) => l.key === "Dallas, TX → Atlanta, GA")!;
    expect(lane).toMatchObject({ loadedMiles: 1400, pickupEmptyMiles: 100, returnEmptyMiles: 160, loads: 3 });
    expect(lane.drivenMiles).toBe(1400 + 260);
    expect(lane.revPerLoad).toBeCloseTo(3500 / 3, 10);
  });
});

describe("load mix and empty miles by truck", () => {
  const rows = [
    row({ id: "1", trailerType: "reefer", loadType: "food", actualRevenue: 3000, vehicleName: "Unit 1", returnDeadheadMiles: 300 }),
    row({ id: "2", trailerType: "dry_van", loadType: "general", vehicleName: "Unit 2" }),
    row({ id: "3", trailerType: null, loadType: null, vehicleName: "Unit 2", brokerName: "Beta Co" })
  ];
  const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
  it("splits the finished loads by trailer, load type and customer, by revenue", () => {
    expect(k.mix.trailer.map((m) => [m.label, m.loads])).toEqual([["Reefer", 1], ["Dry van", 1], ["Not recorded", 1]]);
    expect(k.mix.loadType[0]).toMatchObject({ label: "Food" });
    expect(k.mix.customers[0]).toMatchObject({ label: "Alpha Freight", loads: 2 });
    expect(k.mix.trailer.reduce((s, m) => s + m.grossShare, 0)).toBeCloseTo(1, 10);
  });
  it("lists the trucks with the most empty miles first", () => {
    expect(k.trucks[0]).toMatchObject({ name: "Unit 1", emptyMiles: 350, loads: 1 });
    expect(k.trucks[1]).toMatchObject({ name: "Unit 2", loads: 2, emptyMiles: 160 });
    expect(k.trucks[0]!.emptyShare).toBeCloseTo(350 / 750, 10);
  });
});

describe("lane targets and the week-by-week grid", () => {
  const rows = [
    row({ id: "1", actualRevenue: 1000, fuelSurcharge: 0, completedAt: ago(2), updatedAt: ago(2) }),
    row({ id: "2", actualRevenue: 1400, fuelSurcharge: 0, completedAt: ago(3), updatedAt: ago(3) }),
    row({ id: "3", actualRevenue: 1200, fuelSurcharge: 0, completedAt: ago(10), updatedAt: ago(10), originAddress: "Houston, TX", destinationAddress: "Memphis, TN" })
  ];
  const targets = new Map([["Dallas, TX → Atlanta, GA", 1500], ["Houston, TX → Memphis, TN", 1000]]);
  const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now, undefined, { laneTargets: targets });
  it("marks a lane BELOW or OK against its target per load, with how far, and no target when none is set", () => {
    const dal = k.lanes.find((l) => l.key.startsWith("Dallas"))!;
    const hou = k.lanes.find((l) => l.key.startsWith("Houston"))!;
    expect(dal).toMatchObject({ targetRate: 1500, score: "below" });
    expect(dal.vsTarget).toBeCloseTo(1200 - 1500, 10);
    expect(hou).toMatchObject({ targetRate: 1000, score: "ok" });
    const bare = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
    expect(bare.lanes.every((l) => l.score === "no_target" && l.targetRate == null && l.vsTarget == null)).toBe(true);
  });
  it("shows the busiest lanes for each of the last six weeks, oldest first", () => {
    const g = k.laneWeeks.find((l) => l.key.startsWith("Dallas"))!;
    expect(g.weeks).toHaveLength(6);
    expect(g.weeks.reduce((s, w) => s + w.loads, 0)).toBe(2);
    expect(g.weeks[5]!.loads).toBe(2); // both in the most recent week
    expect(g.weeks[5]!.gross).toBe(2400);
    expect(k.laneWeeks[0]!.total).toBeGreaterThanOrEqual(k.laneWeeks[k.laneWeeks.length - 1]!.total);
  });
});

describe("rolled loads and tender acceptance", () => {
  const rows = [row({ id: "1", brokerName: "Alpha Freight" }), row({ id: "2", brokerName: "Beta Co" })];
  const at = (d: number) => ago(d).getTime();
  const extras = {
    rolled: [
      { loadId: "1", at: at(3), reason: "Customer changed the date" },
      { loadId: "1", at: at(4), reason: "Customer changed the date" },
      { loadId: "2", at: at(5), reason: "Driver not available" },
      { loadId: "2", at: at(400), reason: "Old" }
    ],
    tenders: [
      { at: at(2), kind: "booked" as const },
      { at: at(3), kind: "booked" as const },
      { at: at(3), kind: "passed" as const },
      { at: at(4), kind: "open" as const }
    ]
  };
  const k = buildDeskKpi(rows, { period: "4w", compare: true, filters: {} }, THRESHOLD_DEFAULTS, now, undefined, extras);
  it("counts the loads moved in the period, by reason and by customer, with the period before for comparison", () => {
    expect(k.rolled.count).toBe(3);
    expect(k.rolled.reasons).toEqual([{ label: "Customer changed the date", count: 2 }, { label: "Driver not available", count: 1 }]);
    expect(k.rolled.prior).toBe(0);
    expect(k.brokers.find((b) => b.name === "Alpha Freight")!.rolled).toBe(2);
    expect(k.brokers.find((b) => b.name === "Beta Co")!.rolled).toBe(1);
  });
  it("offers received against booked, in the period and week by week", () => {
    expect(k.tender.current).toEqual({ received: 4, booked: 2, passed: 1, open: 1, acceptance: 0.5 });
    expect(k.tender.weeks).toHaveLength(12);
    expect(k.tender.weeks.reduce((s, w) => s + w.received, 0)).toBe(4);
    expect(k.tender.weeks[11]!.acceptance).not.toBeUndefined();
  });
  it("with no extras there is nothing rolled and no offers, never an error", () => {
    const bare = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now);
    expect(bare.rolled).toEqual({ count: 0, prior: null, reasons: [] });
    expect(bare.tender.current).toEqual({ received: 0, booked: 0, passed: 0, open: 0, acceptance: null });
  });
});

describe("the weekly fuel surcharge and the diesel price in force", () => {
  it("each week carries the surcharge, line haul, loaded miles and the diesel price at its end", () => {
    const rows = [row({ id: "1", fuelSurcharge: 90, completedAt: ago(2), updatedAt: ago(2) }), row({ id: "2", fuelSurcharge: 60, completedAt: ago(9), updatedAt: ago(9) })];
    const diesel = [{ weekOf: "2026-10-12", price: 3.8 }, { weekOf: "2026-10-26", price: 3.95 }];
    const k = buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now, undefined, { diesel });
    const last = k.trend[k.trend.length - 1]!;
    const prev = k.trend[k.trend.length - 2]!;
    expect(last).toMatchObject({ fsc: 90, lineHaul: 1000, loadedMiles: 400, diesel: 3.95 });
    expect(prev).toMatchObject({ fsc: 60, diesel: 3.8 });
    expect(buildDeskKpi(rows, all, THRESHOLD_DEFAULTS, now).trend.every((w) => w.diesel === null)).toBe(true);
  });
});
