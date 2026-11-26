import { driveHoursForAllMiles } from "@/truelane/lib/domain/tripHours";
import { percentText } from "@/lib/pay";
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

/** Drive time for every mile of a load: the measured loaded-leg hours spread over all the miles at the same speed, else a flat 50 mph. */
export function driveHoursFor(load: { estimatedLoadedHours?: Dec | null; loadedMiles: Dec }, totalMiles: number): number {
  const measured = numOrNull((load.estimatedLoadedHours ?? null) as never);
  const loaded = num(load.loadedMiles as never);
  return measured != null && measured > 0 && loaded > 0 ? driveHoursForAllMiles(measured, loaded, totalMiles) : totalMiles / ASSUMED_AVG_MPH;
}

export type EvaluateLoadRow = LoadRow & {
  fuelSurcharge: Dec;
  fuelSurchargeUnit: string | null;
  factoringFeePct: Dec;
  insuranceRiderFlat: Dec;
  dockWaitMinutes: number | null;
  stopsCount: number | null;
  /** Drive hours for the loaded miles, measured on the road when it was quoted. Absent or blank: 50 mph over every mile. */
  estimatedLoadedHours?: Dec | null;
  /** The driver's pay on this load, when one is assigned. It is the labour in the verdict (see resolveLabour). */
  assignment?: { payKind: string; payRate: Dec } | null;
  /** Costs the verdict also counts (see the phone's Calculate): dollars a mile added while towing, a permit or escort for the load, and how wide "at market" is drawn. A load that came from a quote carries them in `quoteExtras`. */
  towingCpmAdjustment?: number;
  permitEscortCost?: number;
  marketBandFraction?: number;
};

/** A fuel purchase tied to the load, as the fuel card or its file reported it (`FuelTransaction`): the receipt. */
export type LoadFuelPurchase = { gallons: unknown; pricePerGallon: unknown; amount: unknown };

/** Where the fuel price a load is judged on came from: its receipts, the price its quote was judged on, or the truck's own. */
export type FuelBasis = { price: number | null; source: "receipts" | "quote" | "truck" };

/** A believable price a gallon (the cost profile and the quote allow $0.50 to $25), else none. */
const believable = (n: number | null): number | null => (n != null && Number.isFinite(n) && n >= 0.5 && n <= 25 ? n : null);

/**
 * The fuel price a booked load is judged on (Chris, 2026-11-25): fuel is volatile, so the decision is made on the fuel index (the price the quote was judged on, kept in `quoteExtras`) and the
 * load keeps that price until the actual fuel comes in on receipts (fuel purchases tied to the load); from then on the receipts' price, gallon for gallon. A load with neither is judged on the
 * truck's own price, as before. The quote's price was only ever used for a diesel truck, so a truck known to burn something else keeps its own. No figure here is new: it is the price a gallon
 * the audited rules already take.
 */
export function fuelBasisOf(load: { quoteExtras?: unknown; fuelTransactions?: readonly LoadFuelPurchase[] | null }, profile: { lastFuelPricePerGallon?: unknown }, vehicle: { fuelType?: string | null } | null): FuelBasis {
  let gallons = 0;
  let paid = 0;
  for (const f of load.fuelTransactions ?? []) {
    const g = numOrNull(f.gallons as never);
    if (g == null || !(g > 0)) continue;
    const ppg = numOrNull(f.pricePerGallon as never);
    const amount = numOrNull(f.amount as never);
    const cost = ppg != null && ppg > 0 ? ppg * g : amount != null && amount > 0 ? amount : null;
    if (cost == null) continue;
    gallons += g;
    paid += cost;
  }
  const fromReceipts = gallons > 0 ? believable(paid / gallons) : null;
  if (fromReceipts != null) return { price: fromReceipts, source: "receipts" };
  const x = load.quoteExtras && typeof load.quoteExtras === "object" && !Array.isArray(load.quoteExtras) ? (load.quoteExtras as { fuelPrice?: unknown }) : {};
  const quoted = typeof x.fuelPrice === "number" ? believable(x.fuelPrice) : null;
  const fuel = (vehicle?.fuelType ?? "").trim().toLowerCase();
  if (quoted != null && (fuel === "" || fuel === "diesel")) return { price: quoted, source: "quote" };
  return { price: numOrNull(profile.lastFuelPricePerGallon as never), source: "truck" };
}

/** What a booked load kept of the quote's extra costs (`Load.quoteExtras`), for a row that did not come straight from the form. */
function advancedOf(load: EvaluateLoadRow): { towing: number; permit: number; band: number } {
  const raw = (load as { quoteExtras?: unknown }).quoteExtras;
  const x = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { towingPerMile?: unknown; permitEscort?: unknown; marketBandFraction?: unknown }) : {};
  const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    towing: load.towingCpmAdjustment ?? pos(x.towingPerMile),
    permit: load.permitEscortCost ?? pos(x.permitEscort),
    band: load.marketBandFraction ?? (typeof x.marketBandFraction === "number" && x.marketBandFraction > 0 ? x.marketBandFraction : 0.1)
  };
}

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
 * models as they are, and a flat pay becomes a per-mile rate over every mile of the trip (the way home counts unless a load covers it). A
 * percent of the rate is a flat pay once it is worked out on the rate confirmation's total, so it reads the same way.
 * Payroll burden is the truck's, or the phone's 18% start when the truck has none. A leased-on truck keeps its own model: the carrier's cut,
 * not a wage. With nobody assigned the truck's profile decides, as before.
 */
export function resolveLabour(profile: CostProfileRow, assignment: EvaluateLoadRow["assignment"], tripMiles: number, rateConTotal: number): Labour {
  const truck = normalizeArchetype(profile.archetype);
  const pay = assignment && n(assignment.payRate) > 0 ? { kind: assignment.payKind, rate: n(assignment.payRate) } : null;
  const percentAmount = pay?.kind === "percent" ? (pay.rate / 100) * rateConTotal : 0;
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
  const setAmount = pay.kind === "percent" ? percentAmount : pay.rate;
  const ratePerMile = pay.kind === "cpm" ? pay.rate : tripMiles > 0 ? setAmount / tripMiles : 0;
  const text =
    pay.kind === "cpm"
      ? perMileText(pay.rate)
      : pay.kind === "percent"
        ? `${percentText(pay.rate)} ($${percentAmount.toFixed(2)}), which is ${perMileText(ratePerMile)} over every mile of the trip`
        : `$${pay.rate.toFixed(2)} flat, which is ${perMileText(ratePerMile)} over every mile of the trip`;
  return { source: "assignment", archetype: "hired_driver", payKind: "cpm", hourlyRate: 0, ratePerMile, burden, note: `Driver pay from this assignment: ${text}, plus ${burdenText}.` };
}

export function evaluateTlLoad(
  load: EvaluateLoadRow,
  profile: CostProfileRow,
  vehicle: { mpg: Dec; fuelType?: string | null } | null
): LoadEvaluation & { fuelBasis: FuelBasis } {
  const breakdown = computeCostProfileFloorBreakdown(profileMathInput(profile));
  const pickupDh = n(load.pickupDeadheadMiles);
  const loaded = n(load.loadedMiles);
  const returnDh = n(load.returnDeadheadMiles);
  const totalMiles = pickupDh + loaded + (load.isBackhaul ? 0 : returnDh);
  const labour = resolveLabour(profile, load.assignment, totalMiles, n(load.quotedRevenue) + n(load.fuelSurcharge));
  const adv = advancedOf(load);
  const fuelBasis = fuelBasisOf(load as { quoteExtras?: unknown; fuelTransactions?: readonly LoadFuelPurchase[] | null }, profile as { lastFuelPricePerGallon?: unknown }, vehicle);
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
    fuelPricePerGallon: fuelBasis.price,
    marketBandFraction: adv.band,
    offer: n(load.quotedRevenue),
    fuelSurchargeAmount: fscAmount,
    fuelSurchargeUnit: fscUnit,
    factoringFeePct: clampFraction(numOrNull((load.factoringFeePct ?? profile.factoringFeePct) as never)),
    insuranceRiderFlat: n(load.insuranceRiderFlat),
    pickupDeadheadMiles: pickupDh,
    loadedMiles: loaded,
    returnDeadheadMiles: returnDh,
    isBackhaul: load.isBackhaul,
    driveHours: driveHoursFor(load, totalMiles),
    dockWaitMinutes: load.dockWaitMinutes ?? 0,
    isTowing: adv.towing > 0,
    towingCpmAdjustment: adv.towing,
    permitEscortCost: adv.permit,
    stopsCount: load.stopsCount ?? 2,
    marketTotal
  };
  return { ...evaluateLoad(input), fuelBasis };
}
