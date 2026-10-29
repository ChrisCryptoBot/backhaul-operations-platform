import { computeCostProfileFloorBreakdown, type CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { effectiveCarrierCutPct, fscCutAppliesFor, normalizeArchetype } from "@/truelane/lib/domain/costArchetype";
import { evaluateLoad, type EvaluateLoadInput, type LoadEvaluation } from "@/truelane/lib/domain/evaluateLoad";
import { clampFraction } from "@/truelane/lib/formatNumbers";
import { num, numOrNull, type TlLoadRow } from "./convert";

/**
 * The same verdict the phone gives on its Calculate screen, run on a dispatcher's load: the truck's break-even
 * floor from its cost profile, fuel from its mpg and the last fuel price, and the load's own offer and miles.
 * Nothing here is new math; it assembles the inputs and calls TrueLane's evaluateLoad.
 */
type Dec = number | string | { toString(): string } | null | undefined;

export type TlCostProfileRow = {
  monthlyInsurance: Dec;
  monthlyAuthority: Dec;
  monthlyPhoneSubscriptions: Dec;
  monthlyLoanPayment: Dec;
  estimatedMonthlyMiles: Dec;
  maintenanceReservePerMile: Dec;
  tireReservePerMile: Dec;
  driverHourlyTarget: Dec;
  lastFuelPricePerGallon: Dec;
  insuranceLiabilityMonthly: Dec;
  insurancePhysicalDamageMonthly: Dec;
  insuranceCargoMonthly: Dec;
  insuranceGeneralLiabilityMonthly: Dec;
  insuranceOtherMonthly: Dec;
  otherFixedMonthly: Dec;
  truckReplacementMonthly: Dec;
  annualFixedCosts: Dec;
  archetype: string | null;
  hiredDriverHourlyRate: Dec;
  hiredDriverPayKind: string | null;
  hiredDriverRatePerMile: Dec;
  laborBurdenPct: Dec;
  carrierCutPct: Dec;
  selfEmploymentTaxPct: Dec;
  fscCutApplies: string | null;
  factoringFeePct: Dec;
};

/** Average road speed used for the drive-time estimate when the load has no measured hours (the phone uses a routed estimate). */
export const ASSUMED_AVG_MPH = 50;

export type TlEvaluateLoadRow = TlLoadRow & {
  fuelSurcharge: Dec;
  fuelSurchargeUnit: string | null;
  factoringFeePct: Dec;
  insuranceRiderFlat: Dec;
  dockWaitMinutes: number | null;
  stopsCount: number | null;
};

const n = (d: Dec) => num(d as never);

export function profileMathInput(p: TlCostProfileRow): CostProfileMathInput {
  return {
    monthlyInsurance: n(p.monthlyInsurance),
    monthlyAuthority: n(p.monthlyAuthority),
    monthlyPhoneSubscriptions: n(p.monthlyPhoneSubscriptions),
    monthlyLoanPayment: n(p.monthlyLoanPayment),
    estimatedMonthlyMiles: n(p.estimatedMonthlyMiles),
    maintenanceReservePerMile: n(p.maintenanceReservePerMile),
    tireReservePerMile: n(p.tireReservePerMile),
    insuranceLiabilityMonthly: numOrNull(p.insuranceLiabilityMonthly as never) ?? undefined,
    insurancePhysicalDamageMonthly: numOrNull(p.insurancePhysicalDamageMonthly as never) ?? undefined,
    insuranceCargoMonthly: numOrNull(p.insuranceCargoMonthly as never) ?? undefined,
    insuranceGeneralLiabilityMonthly: numOrNull(p.insuranceGeneralLiabilityMonthly as never) ?? undefined,
    insuranceOtherMonthly: numOrNull(p.insuranceOtherMonthly as never) ?? undefined,
    otherFixedMonthly: numOrNull(p.otherFixedMonthly as never) ?? undefined,
    truckReplacementMonthly: numOrNull(p.truckReplacementMonthly as never),
    annualFixedCosts: numOrNull(p.annualFixedCosts as never),
    archetype: p.archetype,
    hiredDriverHourlyRate: numOrNull(p.hiredDriverHourlyRate as never),
    laborBurdenPct: numOrNull(p.laborBurdenPct as never),
    carrierCutPct: numOrNull(p.carrierCutPct as never),
    selfEmploymentTaxPct: numOrNull(p.selfEmploymentTaxPct as never)
  };
}

export function evaluateTlLoad(
  load: TlEvaluateLoadRow,
  profile: TlCostProfileRow,
  vehicle: { mpg: Dec } | null
): LoadEvaluation {
  const breakdown = computeCostProfileFloorBreakdown(profileMathInput(profile));
  const archetype = normalizeArchetype(profile.archetype);
  const pickupDh = n(load.pickupDeadheadMiles);
  const loaded = n(load.loadedMiles);
  const returnDh = n(load.returnDeadheadMiles);
  const totalMiles = pickupDh + loaded + (load.isBackhaul ? 0 : returnDh);
  // The market rate is stored per mile; evaluateLoad wants the total for the load.
  const benchmark = numOrNull(load.marketBenchmark as never);
  const marketTotal = benchmark != null && benchmark > 0 ? benchmark * (pickupDh + loaded + returnDh) : 0;
  const fscUnit = load.fuelSurchargeUnit === "percent" ? "percent" : "per_mile";

  const input: EvaluateLoadInput = {
    truckCostPerMile: breakdown.breakEvenRpm,
    floorBreakdown: breakdown,
    archetype,
    carrierCutPct: effectiveCarrierCutPct(archetype, numOrNull(profile.carrierCutPct as never)),
    fscCutApplies: fscCutAppliesFor(profile.fscCutApplies),
    laborBurdenPct: clampFraction(numOrNull(profile.laborBurdenPct as never)),
    hiredDriverHourlyRate: n(profile.hiredDriverHourlyRate),
    hiredDriverPayKind: profile.hiredDriverPayKind ?? "hourly",
    hiredDriverRatePerMile: n(profile.hiredDriverRatePerMile),
    driverHourlyTarget: n(profile.driverHourlyTarget),
    routeBaseMinimum: null,
    routeIncludedMiles: null,
    routeIncludedStops: null,
    routeOveragePerMile: null,
    routeOveragePerStop: null,
    vehicleMpg: numOrNull(vehicle?.mpg as never),
    fuelPricePerGallon: numOrNull(profile.lastFuelPricePerGallon as never),
    marketBandFraction: 0.1,
    offer: n(load.quotedRevenue),
    fuelSurchargeAmount: n(load.fuelSurcharge),
    fuelSurchargeUnit: fscUnit,
    factoringFeePct: clampFraction(numOrNull((load.factoringFeePct ?? profile.factoringFeePct) as never)),
    insuranceRiderFlat: n(load.insuranceRiderFlat),
    pickupDeadheadMiles: pickupDh,
    loadedMiles: loaded,
    returnDeadheadMiles: returnDh,
    isBackhaul: load.isBackhaul,
    driveHours: totalMiles / ASSUMED_AVG_MPH,
    dockWaitMinutes: load.dockWaitMinutes ?? 0,
    isTowing: false,
    towingCpmAdjustment: 0,
    permitEscortCost: 0,
    stopsCount: load.stopsCount ?? 2,
    marketTotal
  };
  return evaluateLoad(input);
}
