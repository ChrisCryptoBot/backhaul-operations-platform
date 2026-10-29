// VENDORED from TrueLane lib/domain/calculators.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Pure domain math only. No async, no DB, no imports from @/lib or @/db.
 * Used by Load, CostProfile, TripSegment and app code. Async persistence stays in models.
 *
 * No metric may silently mix profile-level assumptions and trip-level costs
 * without labeling both layers explicitly. One RPM number must never imply
 * more than it contains. Layer: base floor -> trip fuel -> trip labor ->
 * decision revenue (after factoring and per-load insurance rider) -> net above layered floor.
 */

// ─── ON-SCREEN NAMES (C2) — the code keeps its historical names; screens say: ───
//   survivalFloorRpm      → "Fixed bills" ($/mi)                 A: fixed monthly bills ÷ monthly miles
//   breakEvenRpm          → "Truck cost per mile (before fuel)"  B: A + maintenance & tire savings /mi
//   effective floor       → "Truck cost per mile — this load"    B + this load's towing / permit $/mi
//   allInTripFloorRpm     → the true break-even                  C: B + fuel + driver pay (+ towing/permits)
//   allInNptmVsBase       → "Above truck cost"                   RPM − B
//   netAboveAllInPerMi    → "Profit per mile (after all trip costs)"  RPM − C (drives the verdict)
// Despite the name, `breakEvenRpm` is NOT a full break-even: it leaves out fuel and driver pay.
// Full map + rationale: constants/MetricExplanations.ts.

// ─── THE THREE "NET" METRICS (read this before touching the calculator) ───
//
// Three different quantities share "net" / "profit" language. They are NOT the same
// number, and changing one does not change the others.
//
//   1. allInNptm / allInNptmVsBase   — allInRpm − baseBreakEvenRpm
//        Margin vs the truck-cost floor only. Does NOT include this trip's fuel or labor.
//        Drives the verdict ONLY as the fallback when fuel can't be priced (no MPG / price).
//
//   2. FuelCostResult.netMarginPct   — (decisionRevenue − fuel − baseFloor×miles) / decisionRevenue
//        Margin after fuel AND the truck-cost floor. Does NOT include labor. Display-only, on
//        the fuel card in MetricsDisplay.
//
//   3. RateResult.netAboveAllInPerMi — allInRpm − allInTripFloorRpm
//        Margin vs the FULL trip floor (truck cost + towing + permit + fuel + labor). This is the
//        "true profit" number and the verdict (accept / caution / reject) whenever it is known.
//        Callers pass allInTripFloorRpm only when fuel was actually priced — never with fuel as $0.
//
// The base floor (breakEvenRpm from computeCostProfileFloorBreakdown) includes insurance,
// authority, phone, loan, other fixed, maintenance reserve, tire reserve — divided by
// estimated monthly miles. It excludes fuel, trip labor, SE tax, carrier cut, towing,
// permits, and the insurance rider. Those are layered on top by the callers.

// ----- Edge-case guards (B3) -----
// Small pure predicates the UI can call to decide when a metric is meaningful.

/** True when loadedMiles is too low to produce a meaningful Load RPM. */
export function isLoadedMilesTooLow(miles: number): boolean {
  return miles < 1;
}

/** True when quotedRevenue is not a positive number. */
export function isRevenueTooLow(rev: number): boolean {
  return rev <= 0;
}

/** True when estimatedTotalHours is not positive, meaning RPH is undefined. */
export function isHoursTooLow(hours: number | null): boolean {
  return hours == null || hours <= 0;
}

/** True when NPTM has gone negative (driver is paying to haul). */
export function isNptmNegative(nptm: number | null): boolean {
  return nptm != null && nptm < 0;
}

// ----- Rate (Load) -----

export type RateInput = {
  quotedRevenue: number;
  factoringFeePct?: number;
  /** Leased-on: carrier's share of gross (0–1). Applied after factoring fee on gross. */
  carrierCutPct?: number;
  /** Per-load insurance rider ($); subtracted after factoring on gross. */
  insuranceRiderFlat?: number;
  pickupDeadheadMiles: number;
  loadedMiles: number;
  returnDeadheadMiles: number;
  estimatedTotalHours: number | null;
  breakEvenRpm: number;
  /**
   * Full trip floor (truck cost + fuel + driver pay, $/mi). When supplied the verdict is judged on
   * it; when omitted (fuel not priced) there is no verdict unless the load already loses money
   * before fuel (V-02, see computeRates).
   */
  allInTripFloorRpm?: number | null;
  /** Driver pay ($/mi) — known without fuel; judges the load when fuel can't be priced. Default 0. */
  tripLaborCpm?: number;
  /** The part of quotedRevenue that is fuel surcharge ($). Only matters for a carrier cut. Default 0. */
  fuelSurcharge?: number;
  /** Leased-on: does the carrier take its cut from fuel surcharge (V-04)? Default true. */
  cutAppliesToFsc?: boolean;
};

/**
 * The verdict: accept / caution / reject, or needs_fuel — fuel can't be priced (no MPG or no fuel
 * price) and the load clears its truck cost + driver pay, so there is no verdict until both are set
 * (math review round 6, V-02). A load that loses money before fuel is still a reject: fuel only adds cost.
 */
export type LoadVerdict = 'accept' | 'caution' | 'reject' | 'needs_fuel';

/**
 * Which floor the verdict was judged against:
 * - full_cost: truck cost + fuel + driver pay (the real break-even).
 * - truck_cost_only: fuel couldn't be priced (no MPG or fuel price) — truck cost + driver pay, before
 *   fuel. Below it is a certain reject; above it is needs_fuel (no verdict).
 */
export type VerdictBasis = 'full_cost' | 'truck_cost_only';

export type RateResult = {
  grossRevenue: number;
  decisionRevenue: number;
  loadRpm: number | null;
  pickupRpm: number | null;
  allInRpm: number | null;
  /** Legacy name retained for compatibility (same as allInNptmVsBase). */
  allInNptm: number | null;
  /** Margin per mile against base floor only (legacy break-even comparison). */
  allInNptmVsBase: number | null;
  /** Margin per mile against layered all-in floor when supplied. */
  netAboveAllInPerMi: number | null;
  rph: number | null;
  /** Floor the verdict used (see VerdictBasis). */
  verdictBasis: VerdictBasis;
  /**
   * The margin ($/mi) the verdict was judged on: netAboveAllInPerMi, or when fuel can't be priced,
   * marginBeforeFuelPerMi.
   */
  verdictMarginPerMi: number | null;
  /** Driver pay ($/mi) the input carried (0 unless Owner + driver). */
  driverPayCpm: number;
  /** Truck cost this load + driver pay ($/mi) — every trip cost except fuel. */
  fuelFreeFloorRpm: number;
  /** RPM − fuelFreeFloorRpm: what's left per mile for fuel. Null without miles. */
  marginBeforeFuelPerMi: number | null;
  decision: LoadVerdict;
};

export function computeOnlyIfGap(
  decisionRevenue: number,
  totalMiles: number,
  breakEvenRpm: number,
  dockWaitMinutes?: number | null,
  driverHourlyTarget?: number | null
): number {
  if (totalMiles <= 0) return 0;
  const revenueNeededForFloor = breakEvenRpm * totalMiles;
  let additionalForWait = 0;
  if (
    dockWaitMinutes != null &&
    dockWaitMinutes > 0 &&
    driverHourlyTarget != null &&
    driverHourlyTarget > 0
  ) {
    additionalForWait = (dockWaitMinutes / 60) * driverHourlyTarget;
  }
  const totalNeeded = revenueNeededForFloor + additionalForWait;
  const gap = totalNeeded - decisionRevenue;
  return gap > 0 ? Math.round(gap * 100) / 100 : 0;
}

export function computeTowingAdjustedBreakEven(
  baseBreakEvenRpm: number,
  isTowing: boolean,
  towingCpmAdjustment?: number | null
): number {
  if (!isTowing || towingCpmAdjustment == null || towingCpmAdjustment === 0) {
    return baseBreakEvenRpm;
  }
  return baseBreakEvenRpm + towingCpmAdjustment;
}

/**
 * Cash trip revenue (a saved load's gross): linehaul/base + FSC + layover.
 * Always returns a number (never null); nullish FSC/layover count as 0.
 * "Actual" profit per mile after the trip is lib/domain/tripScorecard actualProfitPerMile (net pay basis,
 * math review round 6, V-05).
 */
export function cashTripRevenue(
  actualOrQuotedRevenue: number,
  fuelSurcharge: number | null | undefined,
  layoverPay: number | null | undefined
): number {
  return (
    (Number.isFinite(actualOrQuotedRevenue) ? actualOrQuotedRevenue : 0) +
    (fuelSurcharge != null && Number.isFinite(fuelSurcharge) ? fuelSurcharge : 0) +
    (layoverPay != null && Number.isFinite(layoverPay) ? layoverPay : 0)
  );
}

export function computeRates(input: RateInput): RateResult {
  const {
    quotedRevenue: rawRevenue,
    factoringFeePct = 0,
    carrierCutPct = 0,
    insuranceRiderFlat = 0,
    pickupDeadheadMiles: rawPickup,
    loadedMiles: rawLoaded,
    returnDeadheadMiles: rawReturn,
    estimatedTotalHours,
    breakEvenRpm,
    allInTripFloorRpm = null,
    tripLaborCpm = 0,
    fuelSurcharge = 0,
    cutAppliesToFsc = true,
  } = input;

  const grossRevenue = Math.max(0, rawRevenue);
  const riderFlat = Math.max(0, insuranceRiderFlat);
  const fscPart = Math.min(grossRevenue, Math.max(0, Number.isFinite(fuelSurcharge) ? fuelSurcharge : 0));
  const decisionRevenue = computeSettlement({
    linehaul: grossRevenue - fscPart,
    fuelSurcharge: fscPart,
    layoverPay: 0,
    carrierCutPct,
    cutAppliesToFsc,
    factoringFeePct,
    insuranceRiderFlat: riderFlat,
  }).net;
  const pickupDeadheadMiles = Math.max(0, rawPickup);
  const loadedMiles = Math.max(0, rawLoaded);
  const returnDeadheadMiles = Math.max(0, rawReturn);

  const loadRpm = loadedMiles > 0 ? decisionRevenue / loadedMiles : null;
  const pickupDenom = pickupDeadheadMiles + loadedMiles;
  const pickupRpm = pickupDenom > 0 ? decisionRevenue / pickupDenom : null;
  const totalMiles =
    pickupDeadheadMiles + loadedMiles + returnDeadheadMiles;
  const allInRpm = totalMiles > 0 ? decisionRevenue / totalMiles : null;
  const allInNptmVsBase = allInRpm !== null ? allInRpm - breakEvenRpm : null;
  const netAboveAllInPerMi =
    allInRpm !== null && allInTripFloorRpm != null ? allInRpm - allInTripFloorRpm : null;
  const rph =
    estimatedTotalHours != null && estimatedTotalHours > 0
      ? decisionRevenue / estimatedTotalHours
      : null;
  // The accept / caution / reject band is judged on the FULL trip floor (truck cost + fuel +
  // driver pay) whenever it is known: a load that loses money once fuel is paid is a reject, never a
  // green accept.
  // V-02 (math review round 6): when fuel can't be priced there is no verdict — a green Accept without
  // fuel could hide a loss. The one exception is a certain reject: if the pay doesn't cover the truck
  // cost + driver pay (both known without fuel), fuel only makes it worse.
  const driverPayCpm = Number.isFinite(tripLaborCpm) && tripLaborCpm > 0 ? tripLaborCpm : 0;
  const fuelFreeFloorRpm = breakEvenRpm + driverPayCpm;
  const marginBeforeFuelPerMi = allInRpm !== null ? allInRpm - fuelFreeFloorRpm : null;
  const verdictBasis: VerdictBasis = netAboveAllInPerMi !== null ? 'full_cost' : 'truck_cost_only';
  const verdictMarginPerMi = verdictBasis === 'full_cost' ? netAboveAllInPerMi : marginBeforeFuelPerMi;
  const decision: LoadVerdict =
    verdictBasis === 'full_cost'
      ? decisionForMargin(verdictMarginPerMi)
      : marginBeforeFuelPerMi === null || marginBeforeFuelPerMi < 0
        ? 'reject'
        : 'needs_fuel';

  return {
    grossRevenue,
    decisionRevenue,
    loadRpm,
    pickupRpm,
    allInRpm,
    allInNptm: allInNptmVsBase,
    allInNptmVsBase,
    netAboveAllInPerMi,
    rph,
    verdictBasis,
    verdictMarginPerMi,
    driverPayCpm,
    fuelFreeFloorRpm,
    marginBeforeFuelPerMi,
    decision,
  };
}

/** Margins at or above zero but under this ($/mi) are "caution" — profitable but thin. */
export const THIN_MARGIN_PER_MILE = 0.05;

/** The band for a margin ($/mi): below zero rejects, under 5¢ is caution. Null (no miles) rejects. */
export function decisionForMargin(marginPerMi: number | null): 'accept' | 'caution' | 'reject' {
  if (marginPerMi === null) return 'reject';
  if (marginPerMi < 0) return 'reject';
  return marginPerMi < THIN_MARGIN_PER_MILE ? 'caution' : 'accept';
}

// ----- Route minimum (medical / multi-stop) -----

export type RouteMinimumInput = {
  /** Base contract minimum for this route structure (e.g. $350) */
  routeBaseMinimum: number;
  /** Miles included in base rate before overage kicks in */
  routeIncludedMiles: number | null;
  /** Stops included in base rate before overage kicks in */
  routeIncludedStops: number | null;
  /** $/mile charged for miles beyond included */
  routeOveragePerMile: number | null;
  /** $/stop charged for stops beyond included */
  routeOveragePerStop: number | null;
  /** Total route miles (pickup deadhead + loaded + return deadhead) */
  totalMiles: number;
  /** Number of stops on this run */
  stopsCount: number;
  /** Decision revenue (post-fee) to compare against */
  decisionRevenue: number;
};

export type RouteMinimumResult = {
  /** Computed expected minimum: base + overage miles + overage stops */
  expectedMinimum: number;
  /** true when decisionRevenue >= expectedMinimum */
  meetsMinimum: boolean;
};

/**
 * Pure: computes route expected minimum and whether quoted revenue meets it.
 * Formula: base + max(0, totalMiles - includedMiles) * $/mi + max(0, stops - includedStops) * $/stop
 * Null included/overage values default to 0 (e.g. no overage structure = flat base minimum).
 */
export function computeRouteMinimum(input: RouteMinimumInput): RouteMinimumResult {
  const includedMiles = input.routeIncludedMiles ?? 0;
  const includedStops = input.routeIncludedStops ?? 0;
  const overagePerMile = input.routeOveragePerMile ?? 0;
  const overagePerStop = input.routeOveragePerStop ?? 0;
  const mileageOverage = Math.max(0, input.totalMiles - includedMiles) * overagePerMile;
  const stopOverage = Math.max(0, input.stopsCount - includedStops) * overagePerStop;
  const expectedMinimum =
    Math.round((input.routeBaseMinimum + mileageOverage + stopOverage) * 100) / 100;
  const meetsMinimum = input.decisionRevenue >= expectedMinimum;
  return { expectedMinimum, meetsMinimum };
}

/**
 * Pure: route model is ON when route_base_minimum > 0.
 * All other fields (included miles/stops, overage rates) default to 0 when null/blank.
 * This makes configuration forgiving: a base-only minimum is valid without overage structure.
 */
export function isRouteModelActive(
  routeBaseMinimum: number | null | undefined
): boolean {
  return routeBaseMinimum != null && routeBaseMinimum > 0;
}

// ----- Route gate (combined decision) -----

export type RouteMinimumGateParams = {
  routeBaseMinimum: number | null;
  routeIncludedMiles: number | null;
  routeIncludedStops: number | null;
  routeOveragePerMile: number | null;
  routeOveragePerStop: number | null;
  totalMiles: number;
  stopsCount: number;
  decisionRevenue: number;
  result: RateResult;
};

export type RouteMinimumGateResult = {
  routeResult: RouteMinimumResult | null;
  routeModelOn: boolean;
  finalDecision: LoadVerdict;
  rejectReason: string | null;
};

/**
 * Pure: combines RPM gate result with optional route minimum gate.
 * Returns the merged finalDecision and human-readable rejectReason.
 */
/** The floor a verdict was judged on, as the cards and the reject reason name it. */
export type VerdictFloorName = 'trip costs' | 'truck cost and driver pay' | 'truck cost';

/**
 * 'trip costs' when fuel was priced; otherwise the truck cost, plus "and driver pay" only when there is
 * driver pay (Owner + driver). Solo and Leased-on have none, so theirs reads 'truck cost'. One rule for
 * the verdict card, the reject reason and the route pricing card (verifier re-pass after round 6).
 */
export function verdictFloorNameOf(result: Pick<RateResult, 'verdictBasis' | 'driverPayCpm'>): VerdictFloorName {
  if (result.verdictBasis === 'full_cost') return 'trip costs';
  return result.driverPayCpm > 0 ? 'truck cost and driver pay' : 'truck cost';
}

export function computeRouteMinimumGate(params: RouteMinimumGateParams): RouteMinimumGateResult {
  const routeModelOn = isRouteModelActive(params.routeBaseMinimum);
  const routeResult: RouteMinimumResult | null = routeModelOn
    ? computeRouteMinimum({
        routeBaseMinimum: params.routeBaseMinimum!,
        routeIncludedMiles: params.routeIncludedMiles ?? null,
        routeIncludedStops: params.routeIncludedStops ?? null,
        routeOveragePerMile: params.routeOveragePerMile ?? null,
        routeOveragePerStop: params.routeOveragePerStop ?? null,
        totalMiles: params.totalMiles,
        stopsCount: params.stopsCount,
        decisionRevenue: params.decisionRevenue,
      })
    : null;
  const routeGateFails = routeResult !== null && !routeResult.meetsMinimum;
  const finalDecision: LoadVerdict =
    params.result.decision === 'reject' || routeGateFails ? 'reject' : params.result.decision;
  const belowCost = `below your ${verdictFloorNameOf(params.result)}`;
  const rejectReason: string | null =
    finalDecision === 'reject'
      ? params.result.decision === 'reject' && routeGateFails
        ? `Reject — ${belowCost} and route minimum`
        : params.result.decision === 'reject'
          ? `Reject — ${belowCost}`
          : ROUTE_MINIMUM_ONLY_REJECT
      : null;
  return { routeResult, routeModelOn, finalDecision, rejectReason };
}

/** rejectReason when the load clears its cost floor but not the route minimum. */
export const ROUTE_MINIMUM_ONLY_REJECT = 'Reject — below route minimum';

// ----- Fuel cost estimation -----

export type FuelCostResult = {
  /** Estimated total fuel cost for this load (all miles) */
  totalFuelCost: number;
  /** Fuel cost per mile */
  fuelCostPerMile: number;
  /** Net revenue after subtracting estimated fuel cost */
  netRevenueAfterFuel: number;
  /** Net profit margin % after fuel ((netRevenue - breakEvenTotal) / quotedRevenue) */
  netMarginPct: number | null;
};

/** Fuel cost by segment for display next to Load / Pickup / All-In RPM */
export type FuelCostBySegment = {
  /** Fuel for loaded miles only (Load RPM segment) */
  loadedFuel: number;
  /** Fuel for pickup deadhead + loaded (Pickup RPM segment) */
  pickupLoadedFuel: number;
  /** Fuel for pickup + loaded + return (All-In RPM segment) */
  allInFuel: number;
};

/**
 * Pure: fuel cost for given miles. Returns 0 when mpg/price missing or zero.
 */
export function fuelCostForMiles(
  miles: number,
  vehicleMpg: number | null,
  fuelPricePerGallon: number | null
): number {
  if (miles <= 0 || vehicleMpg == null || vehicleMpg <= 0 || fuelPricePerGallon == null || fuelPricePerGallon <= 0) {
    return 0;
  }
  const gallons = miles / vehicleMpg;
  return Math.round(gallons * fuelPricePerGallon * 100) / 100;
}

/**
 * Pure: segment fuel costs for display next to RPM lines. All zero when mpg/price missing.
 */
export function computeFuelCostBySegment(
  pickupDeadheadMiles: number,
  loadedMiles: number,
  returnDeadheadMiles: number,
  vehicleMpg: number | null,
  fuelPricePerGallon: number | null
): FuelCostBySegment | null {
  if (vehicleMpg == null || vehicleMpg <= 0 || fuelPricePerGallon == null || fuelPricePerGallon <= 0) {
    return null;
  }
  const loadedFuel = fuelCostForMiles(loadedMiles, vehicleMpg, fuelPricePerGallon);
  const pickupLoadedFuel = fuelCostForMiles(pickupDeadheadMiles + loadedMiles, vehicleMpg, fuelPricePerGallon);
  const allInFuel = fuelCostForMiles(pickupDeadheadMiles + loadedMiles + returnDeadheadMiles, vehicleMpg, fuelPricePerGallon);
  return { loadedFuel, pickupLoadedFuel, allInFuel };
}

/**
 * Pure: estimates fuel cost from total miles, vehicle MPG, and EIA $/gal.
 * Returns null when any required input is missing or zero (caller should show a nudge).
 */
export function computeFuelCost(
  totalMiles: number,
  vehicleMpg: number | null,
  fuelPricePerGallon: number | null,
  /** Use decision (net) revenue when comparing margin after fuel. */
  revenueForMargin: number,
  breakEvenRpm: number
): FuelCostResult | null {
  if (
    totalMiles <= 0 ||
    vehicleMpg == null ||
    vehicleMpg <= 0 ||
    fuelPricePerGallon == null ||
    fuelPricePerGallon <= 0
  ) {
    return null;
  }
  const gallonsUsed = totalMiles / vehicleMpg;
  const totalFuelCost = gallonsUsed * fuelPricePerGallon;
  const fuelCostPerMile = totalFuelCost / totalMiles;
  const netRevenueAfterFuel = revenueForMargin - totalFuelCost;
  const breakEvenTotal = breakEvenRpm * totalMiles;
  const profit = netRevenueAfterFuel - breakEvenTotal;
  const netMarginPct =
    revenueForMargin > 0 ? (profit / revenueForMargin) * 100 : null;
  return {
    totalFuelCost: Math.round(totalFuelCost * 100) / 100,
    // Unrounded: this feeds the verdict floor. Screens round for display (toFixed(3)).
    fuelCostPerMile,
    netRevenueAfterFuel: Math.round(netRevenueAfterFuel * 100) / 100,
    netMarginPct: netMarginPct !== null ? Math.round(netMarginPct * 10) / 10 : null,
  };
}

// ----- Break-even (CostProfile) -----

export type BreakEvenInput = {
  monthlyInsurance: number;
  monthlyAuthority: number;
  monthlyPhoneSubscriptions: number;
  monthlyLoanPayment: number;
  estimatedMonthlyMiles: number;
  maintenanceReservePerMile: number;
  tireReservePerMile: number;
  insuranceLiabilityMonthly?: number;
  insurancePhysicalDamageMonthly?: number;
  insuranceCargoMonthly?: number;
  insuranceGeneralLiabilityMonthly?: number;
  insuranceOtherMonthly?: number;
  otherFixedMonthly?: number;
  /**
   * Truck replacement / depreciation set-aside ($/month). An owned, paid-off truck still wears out;
   * without this its truck cost per mile carries no equipment cost at all.
   */
  truckReplacementMonthly?: number | null;
  /** Once-a-year bills ($/year: 2290 HVUT, IRP plates, permits, UCR). Spread as ÷ 12 per month. */
  annualFixedCosts?: number | null;
  legacyInsuranceMigrated?: boolean;
  archetype?: string | null;
  hiredDriverHourlyRate?: number | null;
  /**
   * Payroll taxes + WC reserve for W-2 / hired drivers (0–1). Does not affect break-even RPM
   * until used in trip labor CPM; stored on profile for calculator.
   */
  laborBurdenPct?: number | null;
  /** Leased-on: house % of gross (0–1). Used in decision revenue only, not break-even floor. */
  carrierCutPct?: number | null;
  /**
   * Solo SE tax reserve (0–1). Intentionally excluded from break-even / survival floor;
   * use for net-profit displays only.
   */
  selfEmploymentTaxPct?: number | null;
};

export type InsuranceBuckets = {
  liability: number;
  physicalDamage: number;
  cargo: number;
  generalLiability: number;
  other: number;
};

export type CostProfileMathInput = BreakEvenInput;

/** Matches pre-Robin Hood hardcoded trip labor burden (existing rows / migration default). */
export const DEFAULT_LABOR_BURDEN_PCT_LEGACY = 0.15;
/** Industry-seed default for newly created cost profiles (payroll tax + WC). */
export const DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE = 0.18;

export type CostProfileFloorBreakdown = {
  breakEvenRpm: number;
  survivalFloorRpm: number;
  totalInsuranceMonthly: number;
  insuranceCpm: number;
  otherFixedMonthlyCpm: number;
  /** Truck replacement ($/mo) + yearly bills ÷ 12 — the part of fixed monthly the two v46 fields add. */
  equipmentAndYearlyMonthly: number;
  totalFixedMonthly: number;
  totalFixedCpm: number;
  fixedNonInsuranceCpm: number;
  maintenanceCpm: number;
  tireCpm: number;
  archetype: string;
};

export function computeTotalInsuranceMonthly(buckets: InsuranceBuckets): number {
  return (
    (buckets.liability || 0) +
    (buckets.physicalDamage || 0) +
    (buckets.cargo || 0) +
    (buckets.generalLiability || 0) +
    (buckets.other || 0)
  );
}

export function getEffectiveTotalInsuranceMonthly(input: CostProfileMathInput): number {
  const bucketTotal = computeTotalInsuranceMonthly({
    liability: input.insuranceLiabilityMonthly ?? 0,
    physicalDamage: input.insurancePhysicalDamageMonthly ?? 0,
    cargo: input.insuranceCargoMonthly ?? 0,
    generalLiability: input.insuranceGeneralLiabilityMonthly ?? 0,
    other: input.insuranceOtherMonthly ?? 0,
  });
  if (bucketTotal > 0 || input.legacyInsuranceMigrated === true) return bucketTotal;
  return input.monthlyInsurance ?? 0;
}

export function computeInsuranceCPM(input: CostProfileMathInput): number {
  // Fail closed when monthly miles are unset/zero — do not invent a CPM by
  // dividing insurance over 1 mile (matches computeCostProfileFloorBreakdown).
  if (input.estimatedMonthlyMiles === 0) return 0;
  return getEffectiveTotalInsuranceMonthly(input) / input.estimatedMonthlyMiles;
}

/** Truck replacement ($/mo) + yearly bills ÷ 12. Negative or non-finite values count as 0. */
function equipmentAndYearlyMonthlyOf(input: CostProfileMathInput): number {
  const nonNeg = (n: number | null | undefined) => (n != null && Number.isFinite(n) && n > 0 ? n : 0);
  return nonNeg(input.truckReplacementMonthly) + nonNeg(input.annualFixedCosts) / 12;
}

export function computeCostProfileFloorBreakdown(input: CostProfileMathInput): CostProfileFloorBreakdown {
  if (input.estimatedMonthlyMiles === 0) {
    return {
      breakEvenRpm: 0,
      survivalFloorRpm: 0,
      totalInsuranceMonthly: getEffectiveTotalInsuranceMonthly(input),
      insuranceCpm: 0,
      otherFixedMonthlyCpm: 0,
      equipmentAndYearlyMonthly: equipmentAndYearlyMonthlyOf(input),
      totalFixedMonthly: 0,
      totalFixedCpm: 0,
      fixedNonInsuranceCpm: 0,
      maintenanceCpm: input.maintenanceReservePerMile || 0,
      tireCpm: input.tireReservePerMile || 0,
      archetype: input.archetype ?? 'solo_owner',
    };
  }
  const miles = input.estimatedMonthlyMiles;
  const totalInsuranceMonthly = getEffectiveTotalInsuranceMonthly(input);
  const otherFixedMonthly = input.otherFixedMonthly ?? 0;
  const equipmentAndYearlyMonthly = equipmentAndYearlyMonthlyOf(input);
  const totalFixedMonthly =
    totalInsuranceMonthly +
    (input.monthlyAuthority || 0) +
    (input.monthlyPhoneSubscriptions || 0) +
    (input.monthlyLoanPayment || 0) +
    otherFixedMonthly +
    equipmentAndYearlyMonthly;
  const totalFixedCpm = totalFixedMonthly / miles;
  const maintenanceCpm = input.maintenanceReservePerMile || 0;
  const tireCpm = input.tireReservePerMile || 0;
  const breakEvenRpm = totalFixedCpm + maintenanceCpm + tireCpm;
  const insuranceCpm = totalInsuranceMonthly / miles;
  const otherFixedMonthlyCpm = otherFixedMonthly / miles;
  // `selfEmploymentTaxPct` is intentionally excluded from breakEvenRpm / survivalFloorRpm.
  // The floor models CASH survival (what must be paid this month to keep the truck
  // running), not after-tax profitability. SE tax is a quarterly/annual obligation, not
  // a per-mile cost of hauling this load. Do not fold it into the floor, and never label
  // the floor "net profit after tax" — it is a pre-tax cash floor.
  return {
    breakEvenRpm,
    survivalFloorRpm: totalFixedCpm,
    totalInsuranceMonthly,
    insuranceCpm,
    otherFixedMonthlyCpm,
    equipmentAndYearlyMonthly,
    totalFixedMonthly,
    totalFixedCpm,
    fixedNonInsuranceCpm: totalFixedCpm - insuranceCpm,
    maintenanceCpm,
    tireCpm,
    archetype: input.archetype ?? 'solo_owner',
  };
}

/** @deprecated Use computeCostProfileFloorBreakdown() */
export function computeBreakEvenRpm(profile: BreakEvenInput): number {
  if (profile.estimatedMonthlyMiles === 0) return 0;
  return computeCostProfileFloorBreakdown(profile).breakEvenRpm;
}

/** @deprecated Use computeCostProfileFloorBreakdown() */
export function computeSurvivalFloorRpm(profile: BreakEvenInput): number {
  if (profile.estimatedMonthlyMiles === 0) return 0;
  return computeCostProfileFloorBreakdown(profile).survivalFloorRpm;
}

/**
 * Net pay for decision math — the cash that reaches the driver, in the order it happens:
 * 1. Leased-on: the carrier keeps its cut of the load's gross; the settlement is gross × (1 − cut).
 * 2. Factoring is charged on what is factored — the driver's settlement (the whole gross when not
 *    leased-on): settlement × (1 − factoring).
 * 3. The flat per-load insurance rider comes off last.
 * net = gross × (1 − cut) × (1 − factoring) − rider, floored at zero.
 *
 * M6 (math audit, decided): factoring used to be taken on the full gross even when leased-on, which
 * charged the driver a fee on the carrier's share too (2,000 at 25% cut + 3% factoring netted 1,440;
 * it is 1,455). With no carrier cut, or no factoring, nothing changes.
 */
export function computeDecisionRevenue(
  quotedRevenue: number,
  factoringFeePct: number = 0,
  insuranceRiderFlat: number = 0,
  carrierCutPct: number = 0
): number {
  return computeDecisionRevenueBreakdown(quotedRevenue, factoringFeePct, insuranceRiderFlat, carrierCutPct).net;
}

/** Each deduction between gross and net pay, so a fee breakdown on screen always adds up to `net`. */
export type DecisionRevenueBreakdown = {
  gross: number;
  factoringDollars: number;
  carrierDollars: number;
  riderDollars: number;
  /** gross − factoring − carrier − rider, floored at zero. */
  net: number;
};

export function computeDecisionRevenueBreakdown(
  quotedRevenue: number,
  factoringFeePct: number = 0,
  insuranceRiderFlat: number = 0,
  carrierCutPct: number = 0
): DecisionRevenueBreakdown {
  // All of it is treated as cut-bearing linehaul — the rule for every caller that has only a gross.
  const s = computeSettlement({
    linehaul: quotedRevenue,
    fuelSurcharge: 0,
    layoverPay: 0,
    carrierCutPct,
    cutAppliesToFsc: true,
    factoringFeePct,
    insuranceRiderFlat,
  });
  return { gross: s.gross, factoringDollars: s.factoringDollars, carrierDollars: s.carrierDollars, riderDollars: s.riderDollars, net: s.net };
}

export type SettlementInput = {
  /** Linehaul: the agreed rate on Calculate; paid (else agreed) after the trip. */
  linehaul: number;
  fuelSurcharge: number;
  /** Layover pay (0 on Calculate — it isn't known until the trip). */
  layoverPay: number;
  /** The carrier's cut that applies (0–1; effectiveCarrierCutPct). */
  carrierCutPct: number;
  /**
   * Leased-on: does the carrier take its cut from fuel surcharge (V-04)? 'no' in the Cost profile =
   * false; 'yes', 'not_sure' and unanswered = true (never overstates net pay).
   */
  cutAppliesToFsc: boolean;
  factoringFeePct: number;
  insuranceRiderFlat: number;
};

export type Settlement = DecisionRevenueBreakdown & {
  /** What the cut is taken from: linehaul + layover (+ fuel surcharge when the cut applies to it). */
  cutBase: number;
};

/**
 * The driver's settlement — one rule for Calculate, History, Trip complete and Tax (math review round 6):
 *   carrier $  = cut × (linehaul + layover + (cut applies to FSC ? FSC : 0))
 *   factoring $ = (gross − carrier $) × factoring   (charged on what the driver factors, M6)
 *   net        = gross − carrier $ − factoring $ − rider, floored at 0
 * Layover carries the cut (conservative — never overstates net pay; confirm on a real settlement).
 * Non-finite inputs count as 0, so no fee line can read NaN.
 */
export function computeSettlement(input: SettlementInput): Settlement {
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const pos = (v: number) => Math.max(0, finite(v));
  const factorPct = Math.max(0, Math.min(finite(input.factoringFeePct), 1));
  const carrierPct = Math.max(0, Math.min(finite(input.carrierCutPct), 1));
  const linehaul = pos(input.linehaul);
  const fsc = pos(input.fuelSurcharge);
  const layover = pos(input.layoverPay);
  const gross = linehaul + fsc + layover;
  // Only an explicit false keeps FSC out of the cut — a missing flag is the conservative case.
  const cutBase = linehaul + layover + (input.cutAppliesToFsc !== false ? fsc : 0);
  const carrierDollars = cutBase * carrierPct;
  const factoringDollars = (gross - carrierDollars) * factorPct;
  const riderDollars = pos(input.insuranceRiderFlat);
  const net = gross - factoringDollars - carrierDollars - riderDollars;
  return { gross, cutBase, factoringDollars, carrierDollars, riderDollars, net: net > 0 ? net : 0 };
}

/**
 * Inverse of computeSettlement on Calculate: the OFFER whose net pay equals targetNet, with the fuel
 * surcharge following the offer by its unit (percent of the offer, or $ per loaded mile). With
 * p = FSC percent (0 for per-mile), F = per-mile FSC dollars, a = 1 when the cut applies to FSC:
 *   net = ((1 + p − c(1 + a·p))·offer + F(1 − c·a))(1 − f) − rider
 * Null when there's no positive target or no answer (a 100 % fee). Never negative.
 */
export function offerForTargetNet(
  targetNet: number,
  opts: {
    fuelSurchargeUnit: 'percent' | 'per_mile';
    fuelSurchargeAmount: number;
    loadedMiles: number;
    carrierCutPct: number;
    cutAppliesToFsc: boolean;
    factoringFeePct: number;
    insuranceRiderFlat: number;
  }
): number | null {
  if (!(targetNet > 0)) return null;
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const f = Math.max(0, Math.min(finite(opts.factoringFeePct), 1));
  const c = Math.max(0, Math.min(finite(opts.carrierCutPct), 1));
  const rider = Math.max(0, finite(opts.insuranceRiderFlat));
  const amount = Math.max(0, finite(opts.fuelSurchargeAmount));
  const p = opts.fuelSurchargeUnit === 'per_mile' ? 0 : amount / 100;
  const F = opts.fuelSurchargeUnit === 'per_mile' ? Math.max(0, finite(opts.loadedMiles)) * amount : 0;
  const a = opts.cutAppliesToFsc !== false ? 1 : 0;
  if (1 - f <= 1e-6) return null;
  const k = 1 + p - c * (1 + a * p);
  if (k <= 1e-6) return null;
  const offer = ((targetNet + rider) / (1 - f) - F * (1 - c * a)) / k;
  return Number.isFinite(offer) ? Math.max(0, offer) : null;
}

/**
 * Inverse of computeDecisionRevenue for positive net: the gross whose net pay (carrier cut, then
 * factoring on the settlement, then the flat rider) equals `targetNet`.
 * gross = (targetNet + rider) / ((1 − carrierCutPct) × (1 − factoringFeePct)) when that is > 0.
 */
export function grossForTargetDecisionRevenue(
  targetNet: number,
  factoringFeePct: number = 0,
  insuranceRiderFlat: number = 0,
  carrierCutPct: number = 0
): number | null {
  if (!(targetNet > 0)) return null;
  const finite = (v: number) => (Number.isFinite(v) ? v : 0);
  const f = Math.max(0, Math.min(finite(factoringFeePct), 1));
  const c = Math.max(0, Math.min(finite(carrierCutPct), 1));
  const rider = Math.max(0, finite(insuranceRiderFlat));
  const denom = (1 - c) * (1 - f);
  if (denom <= 1e-6) return null;
  const gross = (targetNet + rider) / denom;
  return Number.isFinite(gross) && gross > 0 ? gross : null;
}

export function computeTripLaborCPM(
  tripHours: number,
  tripMiles: number,
  hiredDriverHourlyRate: number,
  archetype: string,
  /** Payroll burden (0–1). Default 0.15 matches pre-parameterized behavior. */
  laborBurdenPct: number = 0.15,
  /** Driver-pay kind for the hired_driver archetype: 'hourly' (wage × hours) or 'cpm' (rate × miles). */
  payKind: string = 'hourly',
  /** Per-mile driver pay ($/mi), used only when payKind === 'cpm'. */
  ratePerMile: number = 0
): number {
  if (archetype === 'solo_owner' || archetype === 'leased_on') return 0;
  const burden = Math.max(0, Math.min(laborBurdenPct, 1));
  // Per-mile driver pay: the labor CPM IS the rate (already $/mi), scaled by payroll burden — no hours.
  if (payKind === 'cpm') {
    return ratePerMile > 0 ? ratePerMile * (1 + burden) : 0;
  }
  // Hourly (default): convert wage × hours into $/mi.
  if (tripMiles <= 0 || hiredDriverHourlyRate <= 0 || tripHours <= 0) return 0;
  return (hiredDriverHourlyRate * tripHours / tripMiles) * (1 + burden);
}

export function computeTotalOperatingCostRPM(
  breakEvenRpm: number,
  fuelCpm: number,
  laborCpm: number = 0
): number {
  return breakEvenRpm + fuelCpm + laborCpm;
}

export function computeAllInTripRpm(
  breakdown: CostProfileFloorBreakdown,
  tripFuelCpm: number,
  tripLaborCpm: number = 0,
  /**
   * Trip-level break-even including towing adjustment when applicable.
   * When omitted, uses `breakdown.breakEvenRpm` (profile base floor only).
   */
  effectiveBreakEvenRpm?: number | null
): number {
  const base = effectiveBreakEvenRpm ?? breakdown.breakEvenRpm;
  return base + tripFuelCpm + tripLaborCpm;
}

export type CoverageFlags = { requiresCargo: boolean; requiresGL: boolean };

export function getCoverageFlagsForLoadType(
  loadType: string | null,
  overrideFlags?: Partial<CoverageFlags> | null
): CoverageFlags {
  const normalized = (loadType ?? '').toLowerCase();
  const base: CoverageFlags =
    normalized === 'medical'
      ? { requiresCargo: true, requiresGL: true }
      : normalized === 'parcel' || normalized === 'expedite'
        ? { requiresCargo: true, requiresGL: false }
        : { requiresCargo: false, requiresGL: false };
  return {
    requiresCargo: overrideFlags?.requiresCargo ?? base.requiresCargo,
    requiresGL: overrideFlags?.requiresGL ?? base.requiresGL,
  };
}

// ----- Segments (TripSegment) -----

export type SegmentData = {
  miles: number;
  isManualOverride?: boolean;
};

export function computeBoundaryPositions(segments: SegmentData[]): number[] {
  if (segments.length <= 1) return [];
  const total = segments.reduce((s, seg) => s + seg.miles, 0);
  if (total === 0) return new Array(segments.length - 1).fill(0);
  const positions: number[] = [];
  let cum = 0;
  for (let i = 0; i < segments.length - 1; i++) {
    cum += segments[i]!.miles;
    positions.push(cum / total);
  }
  return positions;
}

export function applyBoundaryPositions(
  totalMiles: number,
  positions: number[]
): number[] {
  if (positions.length === 0) return totalMiles > 0 ? [totalMiles] : [0];
  const miles: number[] = [];
  miles.push(totalMiles * positions[0]!);
  for (let i = 1; i < positions.length; i++) {
    miles.push(totalMiles * (positions[i]! - positions[i - 1]!));
  }
  miles.push(totalMiles * (1 - positions[positions.length - 1]!));
  return miles;
}

export function computeOverrideSummary(segments: SegmentData[]): {
  autoDetectedPct: number;
  manualPct: number;
} {
  if (segments.length === 0) return { autoDetectedPct: 0, manualPct: 0 };
  const manual = segments.filter((s) => s.isManualOverride).length;
  const manualPct = (manual / segments.length) * 100;
  const autoDetectedPct = 100 - manualPct;
  return { autoDetectedPct, manualPct };
}

export type SegmentMilesInput = { segmentType: string; miles?: number };

export function sumSegmentMilesByType(
  segments: SegmentMilesInput[]
): { pickupDh: number; loaded: number; deliveryDh: number; returnDh: number } {
  let pickupDh = 0;
  let loaded = 0;
  let deliveryDh = 0;
  let returnDh = 0;
  for (const seg of segments) {
    const m = seg.miles ?? 0;
    if (seg.segmentType === 'pickup_dh') pickupDh += m;
    else if (seg.segmentType === 'loaded') loaded += m;
    else if (seg.segmentType === 'delivery_dh') deliveryDh += m;
    else if (seg.segmentType === 'return_dh') returnDh += m;
  }
  return { pickupDh, loaded, deliveryDh, returnDh };
}

// ----- Trip next action (stall detection) -----

export type TripSegmentLike = { segmentType: string; endedAt: number | null };

export type NextTripAction =
  | 'start'
  | 'stalled'
  | 'mark_loaded'
  | 'mark_delivered'
  | 'end_trip'
  | 'done';

/**
 * Pure: next action for trip logger. Returns 'stalled' when load is in_progress but has no segments (e.g. app killed after status flip, before segment write).
 */
export function getTripNextAction(
  loadStatus: string,
  segments: TripSegmentLike[]
): NextTripAction {
  if (loadStatus === 'in_progress' && segments.length === 0) return 'stalled';
  const last = segments[segments.length - 1];
  if (!last) return 'start';
  if (last.endedAt != null) {
    if (last.segmentType === 'return_dh') return 'done';
    return last.segmentType === 'pickup_dh'
      ? 'mark_loaded'
      : last.segmentType === 'loaded'
        ? 'mark_delivered'
        : 'end_trip';
  }
  if (last.segmentType === 'pickup_dh') return 'mark_loaded';
  if (last.segmentType === 'loaded') return 'mark_delivered';
  if (last.segmentType === 'delivery_dh') return 'end_trip';
  return 'end_trip';
}

// ----- Capacity warnings (vehicle vs load) -----

export interface CapacityLimits {
  payloadLbs: number | null;
  maxLengthFt: number | null;
  maxWidthFt: number | null;
  maxHeightIn: number | null;
}

export interface LoadDimensions {
  weightLbs: number | null;
  lengthFt: number | null;
  widthFt: number | null;
}

/**
 * Pure: returns human-readable warning strings when load dimensions exceed vehicle limits. Empty array = no warnings. Advisory only.
 */
export function computeCapacityWarnings(
  load: LoadDimensions,
  vehicle: CapacityLimits
): string[] {
  const out: string[] = [];
  if (
    vehicle.payloadLbs != null &&
    load.weightLbs != null &&
    load.weightLbs > vehicle.payloadLbs
  ) {
    out.push(
      `Load weight (${load.weightLbs} lbs) may exceed vehicle payload (${vehicle.payloadLbs} lbs)`
    );
  }
  if (
    vehicle.maxLengthFt != null &&
    load.lengthFt != null &&
    load.lengthFt > vehicle.maxLengthFt
  ) {
    out.push(
      `Load length (${load.lengthFt} ft) may exceed vehicle max length (${vehicle.maxLengthFt} ft)`
    );
  }
  if (
    vehicle.maxWidthFt != null &&
    load.widthFt != null &&
    load.widthFt > vehicle.maxWidthFt
  ) {
    out.push(
      `Load width (${load.widthFt} ft) may exceed vehicle max width (${vehicle.maxWidthFt} ft)`
    );
  }
  return out;
}
