import { computeCostProfileFloorBreakdown, DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE, type CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { effectiveCarrierCutPct, fscCutAppliesFor, normalizeArchetype, type CostArchetype } from "@/truelane/lib/domain/costArchetype";
import { evaluateLoad, type EvaluateLoadInput, type LoadEvaluation } from "@/truelane/lib/domain/evaluateLoad";
import { clampFraction } from "@/truelane/lib/formatNumbers";
import { fuelSurchargePerMileFromDollars, fuelSurchargePercentFromDollars } from "@/truelane/lib/fuelSurcharge";
import { num, numOrNull, type LoadRow } from "./convert";

/**
 * The same verdict the phone gives on its Calculate screen, run on a dispatcher's load: the truck's break-even
 * floor from its cost profile, fuel from its mpg and the last fuel price, and the load's own offer and miles.
 * Nothing here is new math; it assembles the inputs and calls TrueLane's evaluateLoad.
 */
type Dec = number | string | { toString(): string } | null | undefined;

export type CostProfileRow = {
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
  routeBaseMinimum?: Dec;
  routeIncludedMiles?: Dec;
  routeIncludedStops?: Dec;
  routeOveragePerMile?: Dec;
  routeOveragePerStop?: Dec;
};

/** Average road speed used for the drive-time estimate when the load has no measured hours (the phone uses a routed estimate). */
export const ASSUMED_AVG_MPH = 50;

export type EvaluateLoadRow = LoadRow & {
  fuelSurcharge: Dec;
  fuelSurchargeUnit: string | null;
  factoringFeePct: Dec;
  insuranceRiderFlat: Dec;
  dockWaitMinutes: number | null;
  stopsCount: number | null;
  /** The driver's pay on this load, when one is assigned. It is the labour in the verdict (see resolveLabour). */
  assignment?: { payKind: string; payRate: Dec } | null;
};

const n = (d: Dec) => num(d as never);

export function profileMathInput(p: CostProfileRow): CostProfileMathInput {
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

/** Where the verdict's labour comes from, and what it is. */
export type Labour = {
  source: "assignment" | "truck";
  archetype: CostArchetype;
  payKind: "hourly" | "cpm";
  hourlyRate: number;
  ratePerMile: number;
  burden: number;
  /** One sentence for the load page. */
  note: string;
};

const perHour = (n: number) => `$${n.toFixed(2)} an hour`;
const perMileText = (n: number) => `$${n.toFixed(2)} a mile`;

/**
 * The labour in a load's verdict. A load with a driver assigned is judged on that driver's pay, whatever the truck's own profile says, so
 * a dispatcher sees what the load clears after the person actually driving it is paid: per mile and hourly pay are the phone's two driver
 * models as they are, and a flat pay becomes a per-mile rate over every mile of the trip (the way home counts unless a load covers it).
 * Payroll burden is the truck's, or the phone's 18% start when the truck has none. A leased-on truck keeps its own model: the carrier's cut,
 * not a wage. With nobody assigned the truck's profile decides, as before.
 */
export function resolveLabour(profile: CostProfileRow, assignment: EvaluateLoadRow["assignment"], tripMiles: number): Labour {
  const truck = normalizeArchetype(profile.archetype);
  const pay = assignment && n(assignment.payRate) > 0 ? { kind: assignment.payKind, rate: n(assignment.payRate) } : null;
  if (!pay || truck === "leased_on") {
    const payKind = profile.hiredDriverPayKind === "cpm" ? "cpm" : "hourly";
    const burden = clampFraction(numOrNull(profile.laborBurdenPct as never));
    const note =
      truck === "hired_driver"
        ? `Driver pay from the truck's cost profile: ${payKind === "cpm" ? perMileText(n(profile.hiredDriverRatePerMile)) : perHour(n(profile.hiredDriverHourlyRate))}, plus ${(burden * 100).toFixed(0)}% payroll burden.`
        : truck === "leased_on"
          ? "Leased on: the carrier's cut is taken out, and there is no separate driver pay."
          : "The owner drives: no driver pay is counted. Assign a driver to see the load after their pay.";
    return { source: "truck", archetype: truck, payKind, hourlyRate: n(profile.hiredDriverHourlyRate), ratePerMile: n(profile.hiredDriverRatePerMile), burden, note };
  }
  const burden = profile.laborBurdenPct != null ? clampFraction(numOrNull(profile.laborBurdenPct as never)) : DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE;
  const burdenText = `${(burden * 100).toFixed(0)}% payroll burden`;
  if (pay.kind === "hourly") return { source: "assignment", archetype: "hired_driver", payKind: "hourly", hourlyRate: pay.rate, ratePerMile: 0, burden, note: `Driver pay from this assignment: ${perHour(pay.rate)}, plus ${burdenText}.` };
  const ratePerMile = pay.kind === "cpm" ? pay.rate : tripMiles > 0 ? pay.rate / tripMiles : 0;
  const text = pay.kind === "cpm" ? perMileText(pay.rate) : `$${pay.rate.toFixed(2)} flat, which is ${perMileText(ratePerMile)} over every mile of the trip`;
  return { source: "assignment", archetype: "hired_driver", payKind: "cpm", hourlyRate: 0, ratePerMile, burden, note: `Driver pay from this assignment: ${text}, plus ${burdenText}.` };
}

export function evaluateTlLoad(
  load: EvaluateLoadRow,
  profile: CostProfileRow,
  vehicle: { mpg: Dec } | null
): LoadEvaluation {
  const breakdown = computeCostProfileFloorBreakdown(profileMathInput(profile));
  const pickupDh = n(load.pickupDeadheadMiles);
  const loaded = n(load.loadedMiles);
  const returnDh = n(load.returnDeadheadMiles);
  const totalMiles = pickupDh + loaded + (load.isBackhaul ? 0 : returnDh);
  const labour = resolveLabour(profile, load.assignment, totalMiles);
  const archetype = labour.archetype;
  // The market rate is stored per mile; evaluateLoad wants the total for the load.
  const benchmark = numOrNull(load.marketBenchmark as never);
  const marketTotal = benchmark != null && benchmark > 0 ? benchmark * (pickupDh + loaded + returnDh) : 0;
  // A load stores its surcharge in dollars; the verdict wants it in the unit it was entered in (percent of the offer, or dollars per
  // loaded mile), as the phone converts it when it reopens a load. A load with no unit opens as a percent there, so it does here.
  const fscUnit = load.fuelSurchargeUnit === "per_mile" ? "per_mile" : "percent";
  const fscDollars = n(load.fuelSurcharge);
  const fscAmount =
    (fscUnit === "per_mile" ? fuelSurchargePerMileFromDollars(loaded, fscDollars) : fuelSurchargePercentFromDollars(n(load.quotedRevenue), fscDollars)) ?? 0;

  const input: EvaluateLoadInput = {
    truckCostPerMile: breakdown.breakEvenRpm,
    floorBreakdown: breakdown,
    archetype,
    carrierCutPct: effectiveCarrierCutPct(archetype, numOrNull(profile.carrierCutPct as never)),
    fscCutApplies: fscCutAppliesFor(profile.fscCutApplies),
    laborBurdenPct: labour.burden,
    hiredDriverHourlyRate: labour.hourlyRate,
    hiredDriverPayKind: labour.payKind,
    hiredDriverRatePerMile: labour.ratePerMile,
    driverHourlyTarget: n(profile.driverHourlyTarget),
    routeBaseMinimum: numOrNull(profile.routeBaseMinimum as never),
    routeIncludedMiles: numOrNull(profile.routeIncludedMiles as never),
    routeIncludedStops: numOrNull(profile.routeIncludedStops as never),
    routeOveragePerMile: numOrNull(profile.routeOveragePerMile as never),
    routeOveragePerStop: numOrNull(profile.routeOveragePerStop as never),
    vehicleMpg: numOrNull(vehicle?.mpg as never),
    fuelPricePerGallon: numOrNull(profile.lastFuelPricePerGallon as never),
    marketBandFraction: 0.1,
    offer: n(load.quotedRevenue),
    fuelSurchargeAmount: fscAmount,
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
