import { describe, expect, test } from "vitest";
import { kpiOpsAnalyticsSchema } from "@/contracts/kpi";
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

// Guards the "four places" invariant: the metric functions' output must parse
// against the contract, or the strict Zod parse would silently drop opsAnalytics.
describe("kpiOpsAnalyticsSchema ⇔ metric function output", () => {
  const loads: OpsLoadInput[] = [
    {
      status: "COMPLETED",
      driverType: "SHUTTLE",
      lineHaulRate: 950,
      puDeadheadMiles: 40,
      delDeadheadMiles: 10,
      loadedMiles: 120,
      pickupWindowEnd: new Date("2026-07-03T12:00:00.000Z"),
      deliveryWindowEnd: new Date("2026-07-03T17:00:00.000Z"),
      deliveryApptType: "FIRM_APPT",
      laneTarget: 1000,
      kpiEligible: true,
      legs: [
        { legIndex: 0, legType: "SHUTTLE", driverId: "d1", driverName: "Ann", arrivalAt: new Date("2026-07-03T11:00:00.000Z") },
        { legIndex: 1, legType: "DELIVERY", driverId: "d2", driverName: "Bob", arrivalAt: new Date("2026-07-03T16:30:00.000Z") }
      ]
    }
  ];

  test("assembled opsAnalytics parses cleanly", () => {
    const opsAnalytics = {
      shuttleLeaderboard: computeShuttleEmptyLeaderboard(loads),
      deadheadSplit: computeDeadheadSplitPerLoad(loads),
      deadheadRadius: computeAvgShuttleDeadheadRadius([
        { weekIso: "2026-W27", driverType: "SHUTTLE", puDeadheadMiles: 40 }
      ]),
      rateVarianceHistogram: computeRateVarianceHistogram(loads),
      reliability: computeReliabilityMetrics(loads),
      disruptionBreakdown: computeDisruptionReasonBreakdown(
        [{ kind: "CANCEL" as const, reason: "CARRIER_NO_SHOW" as const, count: 2 }],
        "2026-W20"
      ),
      growth: computeGrowth({ loadCount: 10, lineHaulRevenue: 9500 }, { loadCount: 8, lineHaulRevenue: 8000 })
    };
    const parsed = kpiOpsAnalyticsSchema.safeParse(opsAnalytics);
    expect(parsed.success).toBe(true);
  });

  test("an empty week still produces a parseable block", () => {
    const opsAnalytics = {
      shuttleLeaderboard: computeShuttleEmptyLeaderboard([]),
      deadheadSplit: computeDeadheadSplitPerLoad([]),
      deadheadRadius: computeAvgShuttleDeadheadRadius([]),
      rateVarianceHistogram: computeRateVarianceHistogram([]),
      reliability: computeReliabilityMetrics([]),
      disruptionBreakdown: computeDisruptionReasonBreakdown([], null),
      growth: computeGrowth({ loadCount: 0, lineHaulRevenue: 0 }, null)
    };
    expect(kpiOpsAnalyticsSchema.safeParse(opsAnalytics).success).toBe(true);
  });
});
