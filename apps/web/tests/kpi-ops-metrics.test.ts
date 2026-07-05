import { describe, expect, test } from "vitest";
import {
  computeAvgShuttleDeadheadRadius,
  computeDeadheadSplitPerLoad,
  computeDisruptionReasonBreakdown,
  computeGrowth,
  computeRateVarianceHistogram,
  computeReliabilityMetrics,
  computeShuttleEmptyLeaderboard,
  type OpsLoadInput
} from "@/server/kpi-ops-metrics";

/** Minimal load builder — override only what a test cares about. */
function load(overrides: Partial<OpsLoadInput> = {}): OpsLoadInput {
  return {
    status: "COMPLETED",
    driverType: "SHUTTLE",
    lineHaulRate: 1000,
    puDeadheadMiles: 0,
    delDeadheadMiles: 0,
    loadedMiles: 100,
    pickupWindowEnd: null,
    deliveryWindowEnd: null,
    deliveryApptType: null,
    laneTarget: null,
    marketRate: null,
    kpiEligible: true,
    legs: [],
    ...overrides
  };
}

const shuttleLeg = (driverId: string, name: string, legIndex = 0) => ({
  legIndex,
  legType: "SHUTTLE" as const,
  driverId,
  driverName: name,
  arrivalAt: null
});
const deliveryLeg = (driverId: string | null, name: string | null, legIndex = 1, arrivalAt: Date | null = null) => ({
  legIndex,
  legType: "DELIVERY" as const,
  driverId,
  driverName: name,
  arrivalAt
});

describe("computeShuttleEmptyLeaderboard", () => {
  test("excludes loads with no shuttle leg (PTP deadhead is expected)", () => {
    const rows = computeShuttleEmptyLeaderboard([
      load({ puDeadheadMiles: 50, legs: [{ legIndex: 0, legType: "PTP", driverId: "d1", driverName: "PTP Pete", arrivalAt: null }] })
    ]);
    expect(rows).toHaveLength(0);
  });

  test("attributes pu deadhead to the first shuttle driver, worst-first", () => {
    const rows = computeShuttleEmptyLeaderboard([
      load({ puDeadheadMiles: 30, loadedMiles: 100, legs: [shuttleLeg("d1", "Ann")] }),
      load({ puDeadheadMiles: 90, loadedMiles: 100, legs: [shuttleLeg("d2", "Bob")] })
    ]);
    expect(rows.map((r) => r.driverId)).toEqual(["d2", "d1"]); // worst (most deadhead) first
    expect(rows[0].deadheadMiles).toBe(90);
    expect(rows[0].emptyPct).toBeCloseTo(47.4, 1); // 90 / (90+100)
  });

  test("falls back to driverName when a leg has no linked driverId", () => {
    const rows = computeShuttleEmptyLeaderboard([
      load({
        puDeadheadMiles: 25,
        loadedMiles: 100,
        legs: [{ legIndex: 0, legType: "SHUTTLE", driverId: null, driverName: "Cara", arrivalAt: null }]
      })
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].driverId).toBeNull();
    expect(rows[0].driverName).toBe("Cara");
    expect(rows[0].key).toBe("name:Cara");
    expect(rows[0].deadheadMiles).toBe(25);
  });

  test("attributes the whole load (pickup + delivery deadhead + loaded) to the shuttle hauler", () => {
    const rows = computeShuttleEmptyLeaderboard([
      load({
        puDeadheadMiles: 10,
        delDeadheadMiles: 40,
        loadedMiles: 100,
        legs: [shuttleLeg("d1", "Ann", 0), deliveryLeg("d2", "Bob", 2)]
      })
    ]);
    // Single-attribution to the hauler avoids degenerate 100%-empty rows for
    // delivery-only drivers (we lack per-leg loaded miles).
    expect(rows).toHaveLength(1);
    expect(rows[0].driverId).toBe("d1");
    expect(rows[0].deadheadMiles).toBe(50); // 10 pickup + 40 delivery
    expect(rows[0].loadedMiles).toBe(100);
  });
});

describe("computeDeadheadSplitPerLoad", () => {
  test("splits controllable (has shuttle) vs expected (PTP)", () => {
    const split = computeDeadheadSplitPerLoad([
      load({ puDeadheadMiles: 20, delDeadheadMiles: 5, legs: [shuttleLeg("d1", "Ann")] }),
      load({ puDeadheadMiles: 60, delDeadheadMiles: 8, legs: [{ legIndex: 0, legType: "PTP", driverId: "d2", driverName: "Bob", arrivalAt: null }] })
    ]);
    expect(split.controllable).toEqual({ pickupDh: 20, deliveryDh: 5 });
    expect(split.expected).toEqual({ pickupDh: 60, deliveryDh: 8 });
  });
});

describe("computeAvgShuttleDeadheadRadius", () => {
  test("averages pu deadhead over shuttle loads per week, ignoring non-shuttle", () => {
    const points = computeAvgShuttleDeadheadRadius([
      { weekIso: "2026-W26", driverType: "SHUTTLE", puDeadheadMiles: 10 },
      { weekIso: "2026-W26", driverType: "SHUTTLE", puDeadheadMiles: 30 },
      { weekIso: "2026-W26", driverType: "PTP", puDeadheadMiles: 200 },
      { weekIso: "2026-W27", driverType: "SHUTTLE", puDeadheadMiles: 50 }
    ]);
    expect(points).toEqual([
      { weekIso: "2026-W26", avgRadius: 20, loadCount: 2 },
      { weekIso: "2026-W27", avgRadius: 50, loadCount: 1 }
    ]);
  });
});

describe("computeRateVarianceHistogram", () => {
  test("bins per-load variance into $100 buckets on the correct side of $0", () => {
    const h = computeRateVarianceHistogram([
      load({ lineHaulRate: 950, laneTarget: 1000 }), // -50 → bin [-100,0) under target
      load({ lineHaulRate: 1050, laneTarget: 1000 }), // +50 → bin [0,100) at-or-over
      load({ lineHaulRate: 1000, laneTarget: 1000 }) // 0 → bin [0,100)
    ]);
    expect(h.count).toBe(3);
    const under = h.bins.find((b) => b.lo === -100);
    const over = h.bins.find((b) => b.lo === 0);
    expect(under?.count).toBe(1);
    expect(under?.underTarget).toBe(true);
    expect(over?.count).toBe(2);
    expect(over?.underTarget).toBe(false);
    expect(h.median).toBe(0);
  });

  test("skips loads with no target or not KPI-eligible", () => {
    const h = computeRateVarianceHistogram([
      load({ lineHaulRate: 950, laneTarget: null }),
      load({ lineHaulRate: 950, laneTarget: 1000, kpiEligible: false })
    ]);
    expect(h.count).toBe(0);
    expect(h.bins).toHaveLength(0);
    expect(h.median).toBeNull();
  });
});

describe("computeReliabilityMetrics", () => {
  const win = new Date("2026-07-03T17:00:00.000Z");

  test("on-time when delivery arrival is at or before the window end", () => {
    const m = computeReliabilityMetrics([
      load({ deliveryWindowEnd: win, legs: [deliveryLeg("d1", "Ann", 1, new Date("2026-07-03T16:30:00.000Z"))] })
    ]);
    expect(m.otd).toEqual({ onTime: 1, total: 1, unverified: 0 });
    expect(m.missed.missed).toBe(0);
  });

  test("unverified loads (no arrival) count as neither on-time nor missed", () => {
    const m = computeReliabilityMetrics([
      load({ deliveryWindowEnd: win, legs: [deliveryLeg("d1", "Ann", 1, null)] })
    ]);
    expect(m.otd).toEqual({ onTime: 0, total: 0, unverified: 1 });
    expect(m.missed).toEqual({ missed: 0, total: 0, unverified: 1 });
  });

  test("late delivery is missed; firm-appt subset is tracked separately", () => {
    const late = new Date("2026-07-03T18:00:00.000Z");
    const m = computeReliabilityMetrics([
      load({ deliveryApptType: "FIRM_APPT", deliveryWindowEnd: win, legs: [deliveryLeg("d1", "Ann", 1, late)] })
    ]);
    expect(m.otd).toEqual({ onTime: 0, total: 1, unverified: 0 });
    expect(m.missed.missed).toBe(1);
    expect(m.firmAppt).toEqual({ onTime: 0, total: 1, unverified: 0 });
  });

  test("loads with no delivery window are out of scope entirely", () => {
    const m = computeReliabilityMetrics([load({ deliveryWindowEnd: null })]);
    expect(m.otd).toEqual({ onTime: 0, total: 0, unverified: 0 });
  });
});

describe("computeDisruptionReasonBreakdown", () => {
  test("pairs cancel vs reschedule over all 9 reasons and totals them", () => {
    const b = computeDisruptionReasonBreakdown(
      [
        { kind: "CANCEL", reason: "CARRIER_NO_SHOW", count: 3 },
        { kind: "RESCHEDULE", reason: "NO_DOCK_TIME", count: 2 },
        { kind: "RESCHEDULE", reason: "CARRIER_NO_SHOW", count: 1 }
      ],
      "2026-W20"
    );
    expect(b.reasons).toHaveLength(9);
    expect(b.totalCancel).toBe(3);
    expect(b.totalReschedule).toBe(3);
    expect(b.trackedFromWeekIso).toBe("2026-W20");
    const noShow = b.reasons.find((r) => r.reason === "CARRIER_NO_SHOW");
    expect(noShow).toMatchObject({ cancel: 3, reschedule: 1 });
  });
});

describe("computeGrowth", () => {
  test("computes WoW % with correct sign", () => {
    const g = computeGrowth({ loadCount: 120, lineHaulRevenue: 11000 }, { loadCount: 100, lineHaulRevenue: 12000 });
    expect(g.loadCount.pct).toBe(20);
    expect(g.lineHaulRevenue.pct).toBeCloseTo(-8.3, 1);
  });

  test("returns null pct when there is no prior (or prior is zero)", () => {
    expect(computeGrowth({ loadCount: 5, lineHaulRevenue: 100 }, null).loadCount.pct).toBeNull();
    expect(computeGrowth({ loadCount: 5, lineHaulRevenue: 100 }, { loadCount: 0, lineHaulRevenue: 0 }).loadCount.pct).toBeNull();
  });
});
