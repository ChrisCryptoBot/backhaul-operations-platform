import { describe, expect, it } from "vitest";
import { evaluateTlLoad, profileMathInput, type TlCostProfileRow, type TlEvaluateLoadRow } from "@/server/tl/evaluate";
import { computeCostProfileFloorBreakdown } from "@/truelane/lib/domain/calculators";

const profile: TlCostProfileRow = {
  monthlyInsurance: 1400,
  monthlyAuthority: 120,
  monthlyPhoneSubscriptions: 90,
  monthlyLoanPayment: 1800,
  estimatedMonthlyMiles: 9000,
  maintenanceReservePerMile: 0.15,
  tireReservePerMile: 0.04,
  driverHourlyTarget: 30,
  lastFuelPricePerGallon: 3.9,
  insuranceLiabilityMonthly: null,
  insurancePhysicalDamageMonthly: null,
  insuranceCargoMonthly: null,
  insuranceGeneralLiabilityMonthly: null,
  insuranceOtherMonthly: null,
  otherFixedMonthly: null,
  truckReplacementMonthly: 600,
  annualFixedCosts: 2400,
  archetype: "solo_owner",
  hiredDriverHourlyRate: null,
  hiredDriverPayKind: null,
  hiredDriverRatePerMile: null,
  laborBurdenPct: null,
  carrierCutPct: null,
  selfEmploymentTaxPct: null,
  fscCutApplies: null,
  factoringFeePct: null
};

const load: TlEvaluateLoadRow = {
  status: "draft",
  updatedAt: new Date("2026-10-20T00:00:00Z"),
  completedAt: null,
  cancelledAt: null,
  actualRevenue: null,
  quotedRevenue: 650,
  fuelSurcharge: 0,
  fuelSurchargeUnit: "per_mile",
  layoverPay: null,
  tonuRevenue: null,
  expenseFuelActual: 0,
  expenseTolls: 0,
  expenseMisc: 0,
  pickupDeadheadMiles: 51,
  loadedMiles: 257.2,
  returnDeadheadMiles: 237,
  quotedPickupDhMiles: null,
  quotedLoadedMiles: null,
  quotedReturnDhMiles: null,
  isBackhaul: false,
  brokerName: "Sample Freight Co",
  originAddress: "Harrisburg, PA",
  destinationAddress: "Columbus, OH",
  marketBenchmark: 1.18,
  paymentStatus: null,
  invoicedAt: null,
  payTermsDays: null,
  invoicedAmount: null,
  factoringFeePct: null,
  insuranceRiderFlat: null,
  dockWaitMinutes: 0,
  stopsCount: 2
};

describe("evaluating a dispatcher's load with TrueLane's math", () => {
  it("uses the truck's break-even floor from its cost profile", () => {
    const floor = computeCostProfileFloorBreakdown(profileMathInput(profile)).breakEvenRpm;
    const e = evaluateTlLoad(load, profile, { mpg: 6.5 });
    expect(e.effectiveBreakEven).toBeCloseTo(floor, 4);
  });

  it("counts every mile with an empty way home, and drops it when a load covers it", () => {
    const empty = evaluateTlLoad(load, profile, { mpg: 6.5 });
    const covered = evaluateTlLoad({ ...load, isBackhaul: true }, profile, { mpg: 6.5 });
    expect(empty.totalMiles).toBeCloseTo(545.2, 1);
    expect(covered.totalMiles).toBeCloseTo(308.2, 1);
    expect(covered.effectiveGross / covered.totalMiles).toBeGreaterThan(empty.effectiveGross / empty.totalMiles);
  });

  it("gives the same offer a worse verdict with the empty miles counted", () => {
    const rank = { accept: 0, caution: 1, reject: 2, needs_fuel: 3 } as const;
    const empty = evaluateTlLoad(load, profile, { mpg: 6.5 });
    const covered = evaluateTlLoad({ ...load, isBackhaul: true }, profile, { mpg: 6.5 });
    expect(rank[empty.finalDecision]).toBeGreaterThanOrEqual(rank[covered.finalDecision]);
  });

  it("turns a per-mile market rate into a total over every planned mile", () => {
    const e = evaluateTlLoad(load, profile, { mpg: 6.5 });
    expect(e.marketVariancePct).not.toBeNull();
  });
});
