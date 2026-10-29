// VENDORED from TrueLane lib/domain/evaluateLoad.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * The Calculate screen's math in one pure function — the screen, the math parity test and the formula-map
 * generator (scripts/formula-map) all call this, so the numbers an outside verifier checks are the numbers
 * the screen shows (math review round 6, N-1). No React, no I/O.
 *
 * Order (see docs/tabs/calculate/math/TrueLane_Math_Formula_Map.xlsx, Formulas sheet):
 *   miles → truck cost this load → fuel surcharge → gross → net pay → trip hours → fuel → driver pay
 *   → all trip costs → rates + verdict → route minimum → market → "pay needed" / market $ / hours of service.
 */
import {
  computeAllInTripRpm,
  computeFuelCost,
  computeOnlyIfGap,
  computeRates,
  computeRouteMinimumGate,
  computeSettlement,
  computeTotalOperatingCostRPM,
  computeTowingAdjustedBreakEven,
  computeTripLaborCPM,
  offerForTargetNet,
  type CostProfileFloorBreakdown,
  type FuelCostResult,
  type LoadVerdict,
  type RateResult,
  type RouteMinimumResult,
  type VerdictFloorName,
  verdictFloorNameOf,
} from '@/truelane/lib/domain/calculators';
import { onDutyHours } from '@/truelane/lib/domain/tripHours';
import { computeHosLayover, type HosLayover } from '@/truelane/lib/domain/hos';
import { marketVariancePct as computeMarketVariancePct } from '@/truelane/lib/domain/marketVariance';
import { computeMarketVerdict, isBelowFloorForVerdict, type MarketVerdict } from '@/truelane/lib/domain/marketVerdict';
import { fuelSurchargeDollars, type FuelSurchargeUnit } from '@/truelane/lib/fuelSurcharge';
import { clampFraction } from '@/truelane/lib/formatNumbers';

export type EvaluateLoadInput = {
  // ── The truck's Cost profile (already resolved for this truck) ──
  /** Truck cost per mile (computeCostProfileFloorBreakdown().breakEvenRpm). */
  truckCostPerMile: number;
  floorBreakdown: CostProfileFloorBreakdown | null;
  archetype: string;
  /** The carrier cut that applies to this setup (effectiveCarrierCutPct), 0–1. */
  carrierCutPct: number;
  /**
   * Leased-on: whether the cut comes off fuel surcharge (fscCutAppliesFor(profile answer)) — V-04. Only
   * a "No" is false; Yes / Not sure / unanswered are true. No effect without a cut.
   */
  fscCutApplies: boolean;
  laborBurdenPct: number;
  hiredDriverHourlyRate: number;
  hiredDriverPayKind: string;
  hiredDriverRatePerMile: number;
  driverHourlyTarget: number;
  routeBaseMinimum: number | null;
  routeIncludedMiles: number | null;
  routeIncludedStops: number | null;
  routeOveragePerMile: number | null;
  routeOveragePerStop: number | null;
  // ── The truck and the fuel price ──
  vehicleMpg: number | null;
  fuelPricePerGallon: number | null;
  /** Display band half-width (MARKET_BAND_FRACTION); the accept gate always uses the default ±10%. */
  marketBandFraction: number;
  // ── The load as typed (already parsed to numbers) ──
  offer: number;
  fuelSurchargeAmount: number;
  fuelSurchargeUnit: FuelSurchargeUnit;
  /** Fraction 0–1 (parsePercentInput). */
  factoringFeePct: number;
  insuranceRiderFlat: number;
  pickupDeadheadMiles: number;
  loadedMiles: number;
  returnDeadheadMiles: number;
  isBackhaul: boolean;
  /** Drive time (hours) for every mile. */
  driveHours: number;
  dockWaitMinutes: number;
  isTowing: boolean;
  towingCpmAdjustment: number;
  permitEscortCost: number;
  stopsCount: number;
  /** Market rate the driver typed: a TOTAL $ for the load. 0 = none. */
  marketTotal: number;
};

export type ResultCardFigures = {
  /**
   * The $/mi floor the verdict used: all trip costs when fuel was priced, else truck cost + driver pay
   * (every cost but fuel).
   */
  verdictFloor: number;
  verdictFloorName: VerdictFloorName;
  /** "Pay needed to cover your …" — offer + FSC whose net pay covers the floor (the offer when no answer). */
  payNeeded: number;
  /** payNeeded rounded UP to the whole dollar, as the card shows it — never a cent short of the floor (V-08). */
  payNeededRoundedUp: number;
  /** Pay (offer + FSC) − market total; null without a market rate. */
  marketVarianceDollars: number | null;
  payNeededIncludesFsc: boolean;
  hos: HosLayover;
  /** Net pay ÷ elapsed hours incl. rests; only when a 10-hour rest is needed. */
  hosTrueRph: number | null;
};

export type LoadEvaluation = ResultCardFigures & {
  totalMiles: number;
  returnDeadheadMiles: number;
  fuelSurchargeDollars: number;
  /** Offer + fuel surcharge. */
  effectiveGross: number;
  factoringFeePct: number;
  insuranceRiderFlat: number;
  carrierCutPct: number;
  /** Whether the carrier's cut was taken from the fuel surcharge (V-04). */
  cutAppliesToFsc: boolean;
  laborBurdenPct: number;
  permitEscortCpm: number;
  /** Truck cost per mile for this load (towing + permit included). */
  effectiveBreakEven: number;
  fuelCost: FuelCostResult | null;
  tripHours: number;
  tripLaborCpm: number;
  allInTripFloorRpm: number | null;
  verdictFloorRpm: number;
  result: RateResult;
  routeResult: RouteMinimumResult | null;
  routeModelOn: boolean;
  finalDecision: LoadVerdict;
  rejectReason: string | null;
  marketVariancePct: number | null;
  marketVerdict: MarketVerdict;
  onlyIfGap: number;
  /**
   * Profit per trip hour: profit per mile after all trip costs × miles ÷ on-duty hours (V-01). Null when
   * fuel can't be priced or there are no hours. The time trap compares this with the hourly target.
   */
  profitPerHour: number | null;
};

/**
 * Calculate's note "Assuming your carrier's cut includes fuel surcharge — change in Cost profile." (V-04):
 * a leased-on driver with a cut who hasn't answered, or answered Not sure, on a load with fuel surcharge.
 */
export function showFscCutAssumption(input: {
  archetype: string | null | undefined;
  carrierCutPct: number;
  fscCutAnswer: string | null | undefined;
  fuelSurchargeDollars: number;
}): boolean {
  const answer = input.fscCutAnswer;
  return (
    input.archetype === 'leased_on' &&
    input.carrierCutPct > 0 &&
    input.fuelSurchargeDollars > 0 &&
    answer !== 'yes' &&
    answer !== 'no'
  );
}

/** The figures the result card derives from the verdict — shared by the card and evaluateLoad. */
export function resultCardFigures(input: {
  result: RateResult;
  onlyIfGap: number;
  offer: number;
  allInPay: number;
  marketVariancePct: number | null;
  factoringFeePct: number;
  insuranceRiderFlat: number;
  carrierCutPct: number;
  /** Fuel surcharge as typed — it follows the offer when "pay needed" solves for a new offer. */
  fuelSurchargeAmount: number;
  fuelSurchargeUnit: FuelSurchargeUnit;
  loadedMiles: number;
  cutAppliesToFsc: boolean;
  driveHours: number;
  dockWaitMinutes: number;
}): ResultCardFigures {
  const { result } = input;
  const netAboveAllIn = result.netAboveAllInPerMi;
  const fullCost = result.verdictBasis === 'full_cost';
  const verdictFloor =
    fullCost && result.allInRpm != null && netAboveAllIn != null
      ? result.allInRpm - netAboveAllIn
      : result.fuelFreeFloorRpm;
  // Solves the settlement for the OFFER whose net pay exactly covers the verdict floor, with the fuel
  // surcharge following that offer by its unit, then shows offer + FSC (M-09). The settlement rule is
  // the same one the verdict used (cut on FSC or not). No answer (a 100 % fee) → the offer (N-12).
  let payNeeded = input.offer;
  if (input.onlyIfGap > 0) {
    const offerNeeded = offerForTargetNet(result.decisionRevenue + input.onlyIfGap, {
      fuelSurchargeUnit: input.fuelSurchargeUnit,
      fuelSurchargeAmount: input.fuelSurchargeAmount,
      loadedMiles: input.loadedMiles,
      carrierCutPct: input.carrierCutPct,
      cutAppliesToFsc: input.cutAppliesToFsc,
      factoringFeePct: input.factoringFeePct,
      insuranceRiderFlat: input.insuranceRiderFlat,
    });
    if (offerNeeded != null) {
      payNeeded =
        offerNeeded +
        fuelSurchargeDollars({
          offerDollars: offerNeeded,
          loadedMiles: input.loadedMiles,
          amount: input.fuelSurchargeAmount,
          unit: input.fuelSurchargeUnit,
        });
    }
  }
  // Same pay as the % (offer + fuel surcharge): pay − market total (F1).
  const pct = input.marketVariancePct;
  const marketVarianceDollars =
    pct != null && pct !== -1 && input.allInPay > 0 ? input.allInPay - input.allInPay / (1 + pct) : null;
  const hos = computeHosLayover({ drivingHours: input.driveHours, dockWaitHours: input.dockWaitMinutes / 60 });
  const hosTrueRph =
    hos.requiredRests > 0 && hos.elapsedHours > 0 && result.decisionRevenue > 0
      ? result.decisionRevenue / hos.elapsedHours
      : null;
  return {
    verdictFloor,
    verdictFloorName: verdictFloorNameOf(result),
    payNeeded,
    // Up, never to the nearest dollar: $1,145.38 needed shows $1,146, not a dollar short (V-08). The
    // 1e-9 keeps an exact whole dollar carrying float noise (1146.0000000001) from rounding up again.
    payNeededRoundedUp: Math.ceil(payNeeded - 1e-9),
    marketVarianceDollars,
    payNeededIncludesFsc: input.allInPay > input.offer + 0.005,
    hos,
    hosTrueRph,
  };
}

export function evaluateLoad(input: EvaluateLoadInput): LoadEvaluation {
  const pickupDh = input.pickupDeadheadMiles;
  const loadedMi = input.loadedMiles;
  // A backhaul's return is covered, so it isn't part of this load's miles.
  const returnDh = input.isBackhaul ? 0 : input.returnDeadheadMiles;
  const totalMiles = pickupDh + loadedMi + returnDh;

  // Oversize permit + escort is a per-load flat cost spread over the load's miles, added with towing.
  const permitEscortCpm = totalMiles > 0 ? (input.permitEscortCost || 0) / totalMiles : 0;
  const effectiveBreakEven =
    computeTowingAdjustedBreakEven(input.truckCostPerMile, input.isTowing, input.towingCpmAdjustment || null) +
    permitEscortCpm;

  const fsc = fuelSurchargeDollars({
    offerDollars: input.offer,
    loadedMiles: input.loadedMiles,
    amount: input.fuelSurchargeAmount,
    unit: input.fuelSurchargeUnit,
  });
  const effectiveGross = input.offer + fsc;
  const factoringFeePct = input.factoringFeePct;
  const insuranceRiderFlat = Math.max(0, input.insuranceRiderFlat);
  const carrierCutPct = clampFraction(input.carrierCutPct);
  const laborBurdenPct = clampFraction(input.laborBurdenPct);
  // Only an explicit false (a "No" in the Cost profile) keeps FSC out of the cut.
  const cutAppliesToFsc = input.fscCutApplies !== false;
  // Net pay: the settlement rule (lib/domain/calculators computeSettlement) — cut on the offer, and on
  // the fuel surcharge unless the driver said the carrier doesn't take it from FSC (V-04).
  const decisionRevenuePre = computeSettlement({
    linehaul: input.offer,
    fuelSurcharge: fsc,
    layoverPay: 0,
    carrierCutPct,
    cutAppliesToFsc,
    factoringFeePct,
    insuranceRiderFlat,
  }).net;
  const fuelCost = computeFuelCost(totalMiles, input.vehicleMpg, input.fuelPricePerGallon, decisionRevenuePre, effectiveBreakEven);
  // On the clock for the whole trip: drive time for every mile + dock wait (lib/domain/tripHours).
  const tripHours = onDutyHours(input.driveHours, input.dockWaitMinutes);
  const tripLaborCpm = computeTripLaborCPM(
    tripHours,
    totalMiles,
    input.hiredDriverHourlyRate,
    input.archetype,
    laborBurdenPct,
    input.hiredDriverPayKind,
    input.hiredDriverRatePerMile
  );
  // The full trip floor exists only when fuel was priced — never truck cost + $0 fuel.
  const allInTripFloorRpm =
    fuelCost == null
      ? null
      : input.floorBreakdown != null
        ? computeAllInTripRpm(input.floorBreakdown, fuelCost.fuelCostPerMile, tripLaborCpm, effectiveBreakEven)
        : computeTotalOperatingCostRPM(effectiveBreakEven, fuelCost.fuelCostPerMile, tripLaborCpm);

  const result = computeRates({
    quotedRevenue: effectiveGross,
    fuelSurcharge: fsc,
    cutAppliesToFsc,
    factoringFeePct,
    carrierCutPct,
    insuranceRiderFlat,
    pickupDeadheadMiles: pickupDh,
    loadedMiles: loadedMi,
    returnDeadheadMiles: returnDh,
    // RPH and the time-trap use the same on-duty hours as driver pay.
    estimatedTotalHours: tripHours > 0 ? tripHours : null,
    breakEvenRpm: effectiveBreakEven,
    allInTripFloorRpm,
    // Driver pay is known without fuel: it judges the load when fuel can't be priced (V-02).
    tripLaborCpm,
  });
  // The floor the verdict used: all trip costs, else every cost but fuel (truck cost + driver pay).
  const verdictFloorRpm = allInTripFloorRpm ?? result.fuelFreeFloorRpm;
  const { routeResult, routeModelOn, finalDecision, rejectReason } = computeRouteMinimumGate({
    routeBaseMinimum: input.routeBaseMinimum,
    routeIncludedMiles: input.routeIncludedMiles,
    routeIncludedStops: input.routeIncludedStops,
    routeOveragePerMile: input.routeOveragePerMile,
    routeOveragePerStop: input.routeOveragePerStop,
    totalMiles,
    stopsCount: input.stopsCount || 0,
    decisionRevenue: result.decisionRevenue,
    result,
  });

  // Market: all-in pay (offer + FSC) vs the market total (lib/domain/marketVariance). Zero miles → the
  // reject means "floor unknown", not below floor.
  const belowFloor = isBelowFloorForVerdict(finalDecision, totalMiles);
  const thinMargin = totalMiles > 0 && finalDecision === 'caution';
  const marketVariancePct =
    input.offer > 0
      ? computeMarketVariancePct(effectiveGross, input.marketTotal > 0 ? input.marketTotal : null)
      : null;
  const needsFuel = finalDecision === 'needs_fuel';
  // V-01: the time trap compares PROFIT per trip hour (after fuel, truck cost and driver pay) with the
  // hourly target — not revenue per hour, which is before every cost. Only when fuel is priced.
  const profitPerHour =
    result.verdictBasis === 'full_cost' && result.netAboveAllInPerMi != null && tripHours > 0
      ? (result.netAboveAllInPerMi * totalMiles) / tripHours
      : null;
  const belowHourlyTarget =
    profitPerHour != null && input.driverHourlyTarget > 0 && profitPerHour < input.driverHourlyTarget;
  // Display band uses the driver preset; acceptGate stays on the fixed ±10% default band.
  const displayVerdict = computeMarketVerdict({
    belowFloor,
    thinMargin,
    needsFuel,
    variancePct: marketVariancePct,
    belowHourlyTarget,
    band: input.marketBandFraction,
  });
  const gateVerdict = computeMarketVerdict({ belowFloor, thinMargin, needsFuel, variancePct: marketVariancePct, belowHourlyTarget });
  const marketVerdict: MarketVerdict = { ...displayVerdict, acceptGate: gateVerdict.acceptGate };

  const onlyIfGap =
    result.decision === 'reject' ? computeOnlyIfGap(result.decisionRevenue, totalMiles, verdictFloorRpm) : 0;

  const card = resultCardFigures({
    result,
    onlyIfGap,
    offer: input.offer,
    allInPay: effectiveGross,
    marketVariancePct,
    factoringFeePct,
    insuranceRiderFlat,
    carrierCutPct,
    fuelSurchargeAmount: input.fuelSurchargeAmount,
    fuelSurchargeUnit: input.fuelSurchargeUnit,
    loadedMiles: loadedMi,
    cutAppliesToFsc,
    driveHours: input.driveHours,
    dockWaitMinutes: input.dockWaitMinutes,
  });

  return {
    ...card,
    totalMiles,
    returnDeadheadMiles: returnDh,
    fuelSurchargeDollars: fsc,
    effectiveGross,
    factoringFeePct,
    insuranceRiderFlat,
    carrierCutPct,
    cutAppliesToFsc,
    laborBurdenPct,
    permitEscortCpm,
    effectiveBreakEven,
    fuelCost,
    tripHours,
    tripLaborCpm,
    allInTripFloorRpm,
    verdictFloorRpm,
    result,
    routeResult,
    routeModelOn,
    finalDecision,
    rejectReason,
    marketVariancePct,
    marketVerdict,
    onlyIfGap,
    profitPerHour,
  };
}
