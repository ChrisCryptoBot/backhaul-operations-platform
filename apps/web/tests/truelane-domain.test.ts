import { describe, expect, it } from "vitest";
import { evaluateLoad, type EvaluateLoadInput } from "@/truelane/lib/domain/evaluateLoad";
import { loadMarketVariance } from "@/truelane/lib/domain/marketVariance";
import { loadGross, revenueMiles, linehaul } from "@/truelane/lib/domain/loadEconomics";
import { computeAgingSummary } from "@/truelane/lib/invoice";

/**
 * Golden figures from the TrueLane site's deadhead clip (A2): the same offer, $650 over 51 + 257.2 + 237 miles,
 * reads $1.19/mi; with a load back the 237 empty miles drop out and it reads $2.11/mi. These run the vendored
 * phone code (src/truelane), so a refresh from TrueLane that changes the math fails here first.
 */
const base: EvaluateLoadInput = {
  truckCostPerMile: 0.966,
  floorBreakdown: null,
  archetype: "solo_owner",
  carrierCutPct: 0,
  fscCutApplies: true,
  laborBurdenPct: 0,
  hiredDriverHourlyRate: 0,
  hiredDriverPayKind: "hourly",
  hiredDriverRatePerMile: 0,
  driverHourlyTarget: 0,
  routeBaseMinimum: null,
  routeIncludedMiles: null,
  routeIncludedStops: null,
  routeOveragePerMile: null,
  routeOveragePerStop: null,
  vehicleMpg: 7,
  fuelPricePerGallon: 3.5,
  marketBandFraction: 0.1,
  offer: 650,
  fuelSurchargeAmount: 0,
  fuelSurchargeUnit: "per_mile",
  factoringFeePct: 0,
  insuranceRiderFlat: 0,
  pickupDeadheadMiles: 51,
  loadedMiles: 257.2,
  returnDeadheadMiles: 237,
  isBackhaul: false,
  driveHours: 9,
  dockWaitMinutes: 0,
  isTowing: false,
  towingCpmAdjustment: 0,
  permitEscortCost: 0,
  stopsCount: 2,
  marketTotal: 643
};

describe("vendored TrueLane math", () => {
  it("counts every mile when the way home is empty: $650 over 545.2 mi", () => {
    const e = evaluateLoad(base);
    expect(e.totalMiles).toBeCloseTo(545.2, 1);
    expect(e.effectiveGross).toBe(650);
    expect(e.effectiveGross / e.totalMiles).toBeCloseTo(1.19, 2);
  });

  it("drops the empty return when a load covers the way home: $650 over 308.2 mi", () => {
    const e = evaluateLoad({ ...base, isBackhaul: true });
    expect(e.totalMiles).toBeCloseTo(308.2, 1);
    expect(e.returnDeadheadMiles).toBe(0);
    expect(e.effectiveGross / e.totalMiles).toBeCloseTo(2.11, 2);
  });

  it("flips the verdict with the same offer when only the miles change", () => {
    const empty = evaluateLoad(base);
    const covered = evaluateLoad({ ...base, isBackhaul: true });
    expect(empty.finalDecision).toBe("reject");
    expect(covered.finalDecision).not.toBe("reject");
  });

  it("computes load economics from the TrueLane load shape (pickup deadhead counts as revenue miles)", () => {
    const load = {
      status: "completed",
      quotedRevenue: 650,
      actualRevenue: null,
      fuelSurcharge: 0,
      layoverPay: null,
      tonuRevenue: null,
      pickupDeadheadMiles: 51,
      loadedMiles: 257.2,
      returnDeadheadMiles: 237,
      isBackhaul: true
    };
    expect(linehaul(load)).toBe(650);
    expect(loadGross(load)).toBe(650);
    expect(revenueMiles(load)).toBeCloseTo(308.2, 1);
    expect(loadGross(load) / revenueMiles(load)).toBeCloseTo(2.11, 2);
    expect(revenueMiles({ ...load, isBackhaul: false })).toBeCloseTo(545.2, 1);
  });

  it("reads a load against a market rate entered per mile", () => {
    const v = loadMarketVariance({
      quotedRevenue: 650,
      actualRevenue: null,
      fuelSurcharge: 0,
      marketBenchmark: 2.0,
      pickupDeadheadMiles: 51,
      loadedMiles: 257.2,
      returnDeadheadMiles: 0
    });
    expect(v).not.toBeNull();
    expect(v!.miles).toBeCloseTo(308.2, 1);
    expect(v!.payRpm).toBeCloseTo(2.11, 2);
    expect(v!.benchmarkRpm).toBeCloseTo(2.0, 2);
    expect(v!.variancePct).toBeGreaterThan(0);
  });

  it("totals what is owed and counts what is overdue", () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 28, 12);
    const loads = [
      { paymentStatus: "invoiced", invoicedAt: now - 45 * day, payTermsDays: 30, quotedRevenue: 650, fuelSurcharge: 0 },
      { paymentStatus: "invoiced", invoicedAt: now - 5 * day, payTermsDays: 30, quotedRevenue: 800, fuelSurcharge: 0 },
      { paymentStatus: "paid", invoicedAt: now - 60 * day, payTermsDays: 30, quotedRevenue: 900, fuelSurcharge: 0 }
    ];
    const a = computeAgingSummary(loads, now);
    expect(a.count).toBe(2);
    expect(a.totalOutstanding).toBe(1450);
    expect(a.overdueCount).toBe(1);
    expect(a.oldestDaysOverdue).toBe(15);
  });
});
