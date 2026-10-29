import { describe, expect, it } from "vitest";
import { evaluateTlLoad, profileMathInput, resolveLabour, type CostProfileRow, type EvaluateLoadRow } from "@/server/tl/evaluate";
import { computeCostProfileFloorBreakdown } from "@/truelane/lib/domain/calculators";

const profile: CostProfileRow = {
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

const load: EvaluateLoadRow = {
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

  // A load keeps its surcharge in dollars. The verdict must add those dollars once, whatever unit the amount was entered in; it once read the
  // dollars as a per-mile rate and multiplied them by the loaded miles.
  it("adds a stored fuel surcharge once, in dollars, for every unit", () => {
    const plain = evaluateTlLoad(load, profile, { mpg: 6.5 });
    expect(plain.fuelSurchargeDollars).toBe(0);
    for (const unit of ["percent", "per_mile", null]) {
      const e = evaluateTlLoad({ ...load, fuelSurcharge: 60, fuelSurchargeUnit: unit }, profile, { mpg: 6.5 });
      expect(e.fuelSurchargeDollars).toBeCloseTo(60, 1);
      expect(e.effectiveGross).toBeCloseTo(710, 1);
    }
  });

  it("turns a per-mile market rate into a total over every planned mile", () => {
    const e = evaluateTlLoad(load, profile, { mpg: 6.5 });
    expect(e.marketVariancePct).not.toBeNull();
  });
});

describe("the labour in a load's verdict", () => {
  // The load runs 51 + 257.2 + 237 = 545.2 miles, with the way home empty.
  const miles = 545.2;
  const hours = miles / 50;
  const assigned = (kind: string, rate: number): EvaluateLoadRow => ({ ...load, assignment: { payKind: kind, payRate: rate } });

  it("counts nothing for a truck its owner drives, until a driver is assigned", () => {
    const e = evaluateTlLoad(load, profile, { mpg: 6.5 });
    expect(e.tripLaborCpm).toBe(0);
    expect(resolveLabour(profile, null, miles, 1000).note).toMatch(/owner drives/);
  });

  it("judges an assigned load on that driver's pay per mile, with the payroll burden the phone starts at (18%)", () => {
    const solo = evaluateTlLoad(load, profile, { mpg: 6.5 });
    const e = evaluateTlLoad(assigned("cpm", 0.65), profile, { mpg: 6.5 });
    expect(e.tripLaborCpm).toBeCloseTo(0.65 * 1.18, 4);
    expect(e.allInTripFloorRpm!).toBeGreaterThan(solo.allInTripFloorRpm!);
    expect(resolveLabour(profile, { payKind: "cpm", payRate: 0.65 }, miles, 1000)).toMatchObject({ source: "assignment", archetype: "hired_driver", payKind: "cpm" });
  });

  it("judges hourly pay on every hour of the trip, and a flat pay as a rate over every mile", () => {
    const hourly = evaluateTlLoad(assigned("hourly", 24), profile, { mpg: 6.5 });
    expect(hourly.tripLaborCpm).toBeCloseTo((24 * hours * 1.18) / miles, 3);
    const flat = evaluateTlLoad(assigned("flat", 450), profile, { mpg: 6.5 });
    expect(flat.tripLaborCpm).toBeCloseTo((450 / miles) * 1.18, 4);
    // A load covering the way home spreads the same flat pay over fewer miles.
    const covered = evaluateTlLoad({ ...assigned("flat", 450), isBackhaul: true }, profile, { mpg: 6.5 });
    expect(covered.tripLaborCpm).toBeGreaterThan(flat.tripLaborCpm);
  });

  it("uses the truck's own burden when it has one, and the truck's own driver pay when nobody is assigned", () => {
    const fleet: CostProfileRow = { ...profile, archetype: "hired_driver", hiredDriverPayKind: "cpm", hiredDriverRatePerMile: 0.5, laborBurdenPct: 0.1 };
    expect(evaluateTlLoad(load, fleet, { mpg: 6.5 }).tripLaborCpm).toBeCloseTo(0.5 * 1.1, 4);
    expect(evaluateTlLoad(assigned("cpm", 0.7), fleet, { mpg: 6.5 }).tripLaborCpm).toBeCloseTo(0.7 * 1.1, 4);
    expect(resolveLabour(fleet, null, miles, 1000)).toMatchObject({ source: "truck", archetype: "hired_driver" });
    expect(resolveLabour(fleet, null, miles, 1000).note).toMatch(/truck's cost profile: \$0\.50 a mile, plus 10% payroll burden/);
  });

  it("leaves a leased-on truck on the carrier's cut, whatever pay is assigned", () => {
    const leased: CostProfileRow = { ...profile, archetype: "leased_on", carrierCutPct: 0.2, fscCutApplies: "yes" };
    const e = evaluateTlLoad(assigned("cpm", 0.9), leased, { mpg: 6.5 });
    expect(e.tripLaborCpm).toBe(0);
    expect(e.carrierCutPct).toBe(0.2);
    expect(resolveLabour(leased, { payKind: "cpm", payRate: 0.9 }, miles, 1000).source).toBe("truck");
  });

  it("describes where the pay came from, in words", () => {
    expect(resolveLabour(profile, { payKind: "hourly", payRate: 24 }, miles, 1000).note).toBe("Driver pay from this assignment: $24.00 an hour, plus 18% payroll burden.");
    expect(resolveLabour(profile, { payKind: "flat", payRate: 450 }, miles, 1000).note).toMatch(/\$450\.00 flat, which is \$0\.83 a mile over every mile of the trip/);
  });

  it("judges a percent of the rate as the set amount it comes to on the rate confirmation's total", () => {
    const total = Number(load.quotedRevenue) + Number(load.fuelSurcharge);
    const share = evaluateTlLoad(assigned("percent", 40), profile, { mpg: 6.5 });
    const same = evaluateTlLoad(assigned("flat", total * 0.4), profile, { mpg: 6.5 });
    expect(share.tripLaborCpm).toBeCloseTo(same.tripLaborCpm, 6);
    expect(share.tripLaborCpm).toBeCloseTo(((total * 0.4) / miles) * 1.18, 4);
    // A bigger rate means a bigger share, so the same percent costs more on a richer load.
    const richer = evaluateTlLoad({ ...assigned("percent", 40), quotedRevenue: Number(load.quotedRevenue) * 2 }, profile, { mpg: 6.5 });
    expect(richer.tripLaborCpm).toBeGreaterThan(share.tripLaborCpm);
  });

  it("says a percent in words, with the dollars and what that is per mile", () => {
    const note = resolveLabour(profile, { payKind: "percent", payRate: 25 }, miles, 1000).note;
    expect(note).toMatch(/^Driver pay from this assignment: 25% of the rate \(\$250\.00\), which is \$0\.46 a mile over every mile of the trip, plus 18% payroll burden\.$/);
  });
});
