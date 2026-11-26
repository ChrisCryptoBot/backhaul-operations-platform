import { terminalFilter, inScope, scopeWords, type Terminals } from "@/lib/scope";
import { summarizeCustomerPay, type CustomerSlowPay } from "@/lib/customer-pay";
import type { OpenPickupCandidate } from "@/lib/backhaul-detect";
import { Prisma, type Load } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { fuelKindOf } from "@/lib/eia";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
import { truckBodyNote } from "@/lib/load-fit";
import { OWN_BODY, truckFit, type TruckLimits } from "@/lib/load-fit";
import { trailerFit } from "@/lib/trailer-fit";
import { alertThresholds } from "@/lib/thresholds";
import { asLimit, nearestTrucks, NEAREST_DEFAULT } from "@/lib/quote-nearest";
import { missingTimes, OVERRIDE_REASONS, PASS_REASONS, surchargeDollars, validateQuote, type QuoteErrors, type QuoteInput, type QuoteValues } from "@/lib/quote";
import { notQuote, QUOTE_STATUS } from "@/lib/quote-status";
import { loadWindow } from "@/lib/schedule";
import { toCentralLocal } from "@/lib/zoned";
import { stopZoneOf } from "@/server/geo/stop-zone";
import { DEFAULT_TZ } from "@/lib/tz";
import { acceptGateFor } from "@/truelane/lib/calculate/acceptGate";
import type { AcceptGate, MarketBand } from "@/truelane/lib/domain/marketVerdict";
import { fuelSurchargePercentFromDollars, fuelSurchargePerMileFromDollars } from "@/truelane/lib/fuelSurcharge";
import { cityState } from "@/lib/city-state";
import { CUSTOMER_KINDS, kindLabel, type CustomerKind } from "@/lib/customer";
import { nearNames } from "@/lib/customer-match";
import { noAuthority, normalizeMcNumber, type AuthorityResult, type AuthorityState } from "@/lib/fmcsa";
import { lookupMc } from "@/server/fmcsa/lookup";
import { overBudget } from "./budget";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { assignDriver, DispatchError, driverClashesIn, findTruckClash, tripHoursOf, truckClashesIn, windowText } from "./dispatch";
import { resolveOrCreateCustomer } from "./customers";
import { duplicateMessage, findTwinLoad } from "./twins";
import type { PayKind } from "@/lib/pay";
import { saveStopCoordinates } from "@/server/geo/persist";
import { evaluateTlLoad, resolveLabour, type EvaluateLoadRow } from "./evaluate";
import { computeSettlement } from "@/truelane/lib/domain/calculators";
import { freezeLoadSnapshot } from "./snapshot";
import { currentWorkspaceId } from "./workspace";
import { lockWorkspace } from "./plan";
import { currentTerminal } from "./terminal";
import { allowedFor, currentAllowed } from "./scope";
import { DRIVE_LIMIT_HOURS, hosCheck, type HosState } from "@/lib/hos-check";
import { listCustomerRecordsInScope } from "./customers";
import { inTerminal } from "./terminal-sql";
import { currentActor, currentActorId } from "./identity";
import { verdictState } from "@/lib/verdict";
import { getThresholds } from "./thresholds";
import { countTrailersAvailable } from "./trailers";
import { hosCaution, type HosCaution } from "@/truelane/partners/contract";
import { NO_QUOTE_SHIFT, dateKeyOf, quoteShift, type QuoteShift } from "@/lib/shifts";
import { loadSchedules } from "./shifts";
import { workspaceTimezone } from "./zone";

/**
 * The Calculate tab for a dispatcher. An offer is priced with TrueLane's own verdict (evaluateTlLoad) against every truck that has a cost
 * profile, once for each driver who runs it, with that driver's usual pay as the labour, so the question the phone answers for one truck
 * ("does this clear my cost?") is answered for the whole fleet at once. Nothing is written until a quote is saved or booked. A quote is a
 * load with status `quote` (lib/quote-status.ts); booking it makes it a load that needs a driver, writes the decision (accepted, or
 * overridden with the reason given), freezes the truck's floor and dock terms on it, and can put the chosen driver on it.
 */

/**
 * The form's values with each stop's clock worked out here, from where the stop is (its measured point, else its state, else the carrier's clock): a stop's time is the dock's time, as
 * everywhere else on the desk (src/lib/tz.ts). Whatever zone the browser sent is replaced, never trusted.
 */
export function zonedValues(values: QuoteValues, carrier: string): QuoteValues {
  return { ...values, stops: values.stops.map((s) => ({ ...s, zone: stopZoneOf({ lat: typeof s.lat === "number" ? s.lat : null, lng: typeof s.lng === "number" ? s.lng : null, addressString: s.address }, carrier) })) };
}

export type FitDetail = {
  effectiveGross: number;
  /** What the offer plus surcharge would have to be to cover the floor, rounded up to the dollar. */
  payNeeded: number;
  marketVariancePct: number | null;
  marketVarianceDollars: number | null;
  thinMargin: boolean;
  timeTrap: boolean;
  profitPerHour: number | null;
  hourlyTarget: number;
  fuelPerMile: number | null;
  requiredRests: number;
  elapsedHours: number;
  rejectReason: string | null;
  routeMinimum: { expected: number; meets: boolean } | null;
  /** The working behind the verdict, for "See all the figures". */
  metrics: { loadRpm: number | null; pickupRpm: number | null; rph: number | null; profitPerMile: number | null; marginAfterFuelPct: number | null; fuelTotal: number | null; tripHours: number; truckCostPerMile: number };
  /** What the pay becomes, step by step: the carrier's cut, then the factoring fee on what is left, then the rider. */
  fees: { gross: number; carrier: number; carrierPct: number; factoring: number; factoringPct: number; rider: number; net: number };
};

export type FitRow = {
  key: string;
  truckId: string;
  truckName: string;
  driverId: string | null;
  driverName: string | null;
  /** Whose pay is in the verdict, in a sentence. For someone who may not see driver pay, it says whose pay without the figure. */
  labourNote: string;
  /** Whose pay the verdict counts: the driver's own usual pay, the truck's profile, or none (the owner drives, or a leased-on truck). */
  labourFrom: "driver" | "truck" | "none";
  emptyToPickup: number;
  totalMiles: number;
  band: MarketBand;
  decision: "accept" | "caution" | "reject" | "needs_fuel";
  gate: AcceptGate;
  allInPerMile: number | null;
  floorPerMile: number;
  /** What each mile clears over the floor the verdict used (negative: it loses that much a mile). */
  marginPerMile: number | null;
  /** The margin over every mile, in dollars. */
  leftOver: number | null;
  /** A reason this truck or driver cannot take it: a load over the truck's limits, a lapsed card, or another load at that time. */
  blocked: string | null;
  /** Things to know that do not stop it: equipment the truck is not marked as carrying, oversize freight, hazmat, hours left on the clock. */
  warnings: string[];
  /**
   * The hours the driver has left as their ELD last said (the driver's own clocks, as assigning reads them; the truck's reading only when the driver has none), when that was, and how the trip
   * compares. A caution only: nothing in the verdict reads it. `needsReason`: assigning this driver needs an hours reason (short or stale clocks, src/lib/hos-check.ts), so booking with them asks for one.
   */
  hos: { availableHours: number | null; syncedAt: string | null; caution: HosCaution; state: HosState; needsReason: boolean };
  /** When the driver works, and a caution when the typed appointments fall outside it. Beside the hours-left note; nothing in the verdict, the ranking or booking reads it. */
  shift?: QuoteShift;
  detail: FitDetail;
  /** For the chips above the table: where the truck is based, its terminal, and whether it suits this load. `trailerFits` is null when it cannot be told (a tractor with no trailer hooked); `onShift` is null when the driver has no schedule. */
  homeBase: string | null;
  terminal: string | null;
  trailerFits: boolean | null;
  onShift: boolean | null;
  /** Nothing stops it: no clash, no lapsed card, nothing over the truck's limits. */
  available: boolean;
};

/**
 * `rows` are the nearest trucks priced, best way to run it first; `total` is how many rows that is. `scope` says how many trucks the terminals in view hold, how many could be priced, how many were, and what the
 * order is (by empty miles to the pickup, or by name when nothing was measured).
 */
/** `trailersAvailable`: trailers of the kind the offer needs (any kind when none is stated) that are in service, available, with no date lapsed and not on an open load; null when the desk keeps no trailers. */
/** `lane`: the desk's own record, when it stood in for a market rate nobody typed. */
export type FitScope = { inScope: number; available: number; priced: number; limit: number; ranked: "distance" | "name"; measured: number };
export type FitResult = { rows: FitRow[]; total: number; scope: FitScope; skipped: Array<{ truck: string; why: string }>; /** How many trucks have no cost profile (the list above shows only a few). */ skippedTotal: number; trailersAvailable: number | null; lane: LaneBenchmark | null };
/** How many trucks without a cost profile are named in the answer (the rest are counted). */
const SKIPPED_NAMED = 10;

const D = 86_400_000;
/** Minutes at the dock as a whole number, for the load's integer column. */
const wholeMinutes = (m: number) => new Prisma.Decimal(m).toDecimalPlaces(0).toNumber();

/** The quote as the load row the verdict reads: an unbooked draft, with its empty miles and the driver's pay when one is being tried. */
export function quoteLoadRow(input: QuoteInput, emptyToPickup: number, pay: { kind: string; rate: number } | null, emptyHome: number = input.emptyHome): EvaluateLoadRow {
  const allMiles = emptyToPickup + input.loadedMiles + emptyHome;
  return {
    status: "draft",
    updatedAt: new Date(),
    completedAt: null,
    cancelledAt: null,
    actualRevenue: null,
    quotedRevenue: input.offer,
    fuelSurcharge: surchargeDollars(input),
    fuelSurchargeUnit: input.fscUnit,
    layoverPay: null,
    tonuRevenue: null,
    expenseFuelActual: 0,
    expenseTolls: 0,
    expenseMisc: 0,
    pickupDeadheadMiles: emptyToPickup,
    loadedMiles: input.loadedMiles,
    returnDeadheadMiles: emptyHome,
    estimatedLoadedHours: input.loadedHours,
    quotedPickupDhMiles: null,
    quotedLoadedMiles: null,
    quotedReturnDhMiles: null,
    isBackhaul: input.loadBack,
    brokerName: input.broker,
    originAddress: input.stops[0]?.address ?? null,
    destinationAddress: input.stops[input.stops.length - 1]?.address ?? null,
    // The market rate is typed as a total for the load; the verdict wants it per mile over every planned mile.
    marketBenchmark: input.marketTotal != null && allMiles > 0 ? input.marketTotal / allMiles : null,
    paymentStatus: null,
    invoicedAt: null,
    payTermsDays: input.payTermsDays,
    invoicedAmount: null,
    factoringFeePct: input.factoringFraction,
    insuranceRiderFlat: input.insuranceRider > 0 ? input.insuranceRider : null,
    dockWaitMinutes: input.dockWaitMinutes > 0 ? wholeMinutes(input.dockWaitMinutes) : 0,
    towingCpmAdjustment: input.towingPerMile,
    permitEscortCost: input.permitEscort,
    marketBandFraction: input.marketBandFraction,
    // The phone counts deliveries only (a route minimum is per stop made), so a second pickup does not make the load look bigger.
    stopsCount: input.stops.filter((s) => s.role === "delivery").length,
    assignment: pay ? { payKind: pay.kind, payRate: pay.rate } : null
  };
}

const HOUR = 3_600_000;
/**
 * When the truck and driver are committed: from the time it takes to reach the pickup to the later of the last appointment and the pickup plus the loaded drive. A load whose
 * delivery time is early on paper but whose road takes longer is not "free" at that time.
 */
const windowOf = (input: QuoteInput, truckId?: string | null) => {
  const first = input.stops[0]?.appointment;
  if (first == null) return null;
  const lastStop = input.stops[input.stops.length - 1];
  // The delivery window's close when one is typed, else its time; with no delivery time yet, the pickup plus the loaded drive, so a clash shows while the quote is still being typed.
  const last = lastStop?.appointmentEnd ?? lastStop?.appointment ?? null;
  const driveMs = (input.loadedHours ?? input.loadedMiles / 50) * HOUR;
  // The truck leaves from where it is: its own empty miles to the pickup (measured from its base, or typed for it), not the miles between stops. They are driven at the loaded leg's measured
  // pace when the road gave one, else 50 mph.
  const empty = (truckId ? input.emptyByTruck[truckId] : undefined) ?? input.emptyToPickup;
  const mph = input.loadedHours != null && input.loadedHours > 0 ? input.loadedMiles / input.loadedHours : 50;
  return loadWindow([{ timeWindowEarliest: new Date(first - (empty / mph) * HOUR), timeWindowLatest: new Date(Math.max(last ?? first, first + driveMs)) }]);
};

type TruckForFit = Prisma.VehicleGetPayload<{ include: { costProfile: true; drivers: true; trailers: true } }>;

/**
 * Hours on the clock, read the way assigning reads them (server/tl/dispatch.ts assignDriver): the driver's own ELD clocks against the trip's drive time, the first day against the 11-hour limit
 * and the whole trip against the cycle (src/lib/hos-check.ts). A driver with no clocks falls back to the truck's last reading as a caution only, for a pickup within the next day (hours left now
 * say nothing about next week). Never an input to the verdict.
 */
function hoursOf(row: EvaluateLoadRow, truck: TruckForFit, driver: TruckForFit["drivers"][number] | null, now: Date, pickupAt: number | null): FitRow["hos"] {
  const tripHours = tripHoursOf(row);
  if (driver) {
    const check = hosCheck({ hosDriveMinutes: driver.hosDriveMinutes, hosShiftMinutes: driver.hosShiftMinutes, hosCycleMinutes: driver.hosCycleMinutes, hosSyncedAt: driver.hosSyncedAt }, tripHours, now);
    if (check.state !== "none") {
      const needsReason = check.state === "short" || check.state === "stale";
      const left = driver.hosDriveMinutes != null ? new Prisma.Decimal(driver.hosDriveMinutes).div(60).toDecimalPlaces(1).toNumber() : null;
      return {
        availableHours: left,
        syncedAt: driver.hosSyncedAt ? driver.hosSyncedAt.toISOString() : null,
        caution: { level: check.state === "short" ? "short" : check.state === "stale" ? "caution" : "none", message: needsReason ? `${driver.name}: ${check.note}. Booking with them asks for a reason.` : null },
        state: check.state,
        needsReason
      };
    }
  }
  const available = numOrNull(truck.hosAvailableHours);
  const soon = pickupAt == null || pickupAt - now.getTime() < 24 * HOUR;
  return { availableHours: available, syncedAt: truck.hosSyncedAt ? truck.hosSyncedAt.toISOString() : null, caution: soon ? hosCaution(Math.min(tripHours, DRIVE_LIMIT_HOURS), available) : hosCaution(null, null), state: "none", needsReason: false };
}

/** What a truck holds and carries, as the load check reads it (moved to truck-fit.ts so dispatch.ts can use it too). */
export { truckLimits } from "./truck-fit";
import { truckLimits } from "./truck-fit";

function fitFor(input: QuoteInput, truck: TruckForFit, driver: TruckForFit["drivers"][number] | null, blocked: string | null, shift: QuoteShift = NO_QUOTE_SHIFT, now: Date = new Date(), soonDays = 30, seesPay = true): FitRow | null {
  const profile = truck.costProfile;
  if (!profile) return null;
  const emptyToPickup = input.emptyByTruck[truck.id] ?? input.emptyToPickup;
  const usual = driver?.defaultPayKind && driver.defaultPayRate != null ? { kind: driver.defaultPayKind, rate: num(driver.defaultPayRate) } : null;
  const emptyHome = input.emptyHomeByTruck[truck.id] ?? input.emptyHome;
  const row = quoteLoadRow(input, emptyToPickup, usual, emptyHome);
  // A fuel price typed for this check stands in for the truck's own on diesel trucks. It is the same price the booking gate uses (bookQuote
  // comes through here), and it is never saved: the profile and the booked load keep the truck's own.
  const priced = input.fuelPrice != null && fuelKindOf(truck.fuelType) === "diesel" ? { ...profile, lastFuelPricePerGallon: input.fuelPrice } : profile;
  const e = evaluateTlLoad(row, priced as never, { mpg: truck.mpg });
  const labour = resolveLabour(profile as never, row.assignment, e.totalMiles, num(row.quotedRevenue) + num(row.fuelSurcharge));
  const margin = e.result.verdictMarginPerMi;
  const forLoad = truckFit(input.specs, truckLimits(truck));
  const hos = hoursOf(row, truck, driver, now, input.stops[0]?.appointment ?? null);
  const body = truckBodyNote(input.trailer, truck.type, truck.name ?? "Truck");
  // Does the equipment suit the load: the trailer hooked to the truck against the kind and length the load needs (a longer trailer takes a shorter load), else the truck's own body. Unknown is not "no".
  const hooked = truck.trailers.find((t) => t.status === "available") ?? truck.trailers[0] ?? null;
  const trailerFits: boolean | null = hooked
    ? trailerFit(
        { trailerType: input.trailer, weightLbs: input.specs.weightLbs, lengthFt: input.specs.lengthFt, vehicleId: truck.id },
        { number: hooked.number, type: hooked.type, maxPayloadLbs: hooked.maxPayloadLbs, lengthFt: numOrNull(hooked.lengthFt), currentVehicleId: hooked.currentVehicleId, status: hooked.status, registrationExpiry: hooked.registrationExpiry, inspectionExpiry: hooked.inspectionExpiry },
        now,
        soonDays
      ).blocker == null
    : OWN_BODY.has((truck.type ?? "").trim())
      ? body == null
      : null;
  return {
    key: `${truck.id}:${driver?.id ?? "none"}`,
    truckId: truck.id,
    truckName: truck.name ?? "Truck",
    driverId: driver?.id ?? null,
    driverName: driver?.name ?? null,
    labourNote: seesPay || labour.source === "truck" && !/Driver pay/.test(labour.note) ? labour.note : labour.source === "assignment" ? "Priced with this driver's usual pay." : "Priced with the driver pay on the truck's cost profile.",
    labourFrom: labour.source === "assignment" ? "driver" : /Driver pay/.test(labour.note) ? "truck" : "none",
    emptyToPickup,
    totalMiles: e.totalMiles,
    band: e.marketVerdict.band,
    decision: e.finalDecision,
    // The rules' own gate. With a market rate typed, or enough of the desk's own loads on the lane to stand in for one, the load is judged against that; with neither, booking asks for a reason, as the phone does.
    gate: acceptGateFor({ marketGate: e.marketVerdict.acceptGate, decision: e.finalDecision }),
    allInPerMile: e.result.allInRpm,
    floorPerMile: e.verdictFloorRpm,
    marginPerMile: margin,
    leftOver: margin == null ? null : margin * e.totalMiles,
    blocked: blocked ?? forLoad.blocker,
    homeBase: truck.homeBaseAddress,
    terminal: truck.terminal,
    trailerFits,
    onShift: shift.tag == null ? null : shift.tag !== "Off duty" && shift.warn == null,
    available: (blocked ?? forLoad.blocker) == null,
    // A placarded hazmat load needs a driver with the H (or X) endorsement (49 CFR 383.93). The desk keeps no endorsements yet, so it says so for every driver: a caution until the
    // Drivers module carries them (Chris, 2026-11-25), then a block.
    warnings: [...forLoad.warnings, ...(body ? [body] : []), ...(hos.caution.message ? [hos.caution.message] : []), ...(input.specs.hazmatClass && driver ? [`Hazmat: ${driver.name}'s H endorsement is not on file. Check their CDL before you book (49 CFR 383.93).`] : [])],
    hos,
    shift,
    detail: {
      effectiveGross: e.effectiveGross,
      payNeeded: e.payNeededRoundedUp,
      marketVariancePct: e.marketVariancePct,
      marketVarianceDollars: e.marketVarianceDollars,
      thinMargin: e.marketVerdict.thinMargin,
      timeTrap: e.marketVerdict.timeTrap,
      profitPerHour: e.profitPerHour,
      hourlyTarget: num(profile.driverHourlyTarget),
      fuelPerMile: e.fuelCost?.fuelCostPerMile ?? null,
      requiredRests: e.hos.requiredRests,
      elapsedHours: e.hos.elapsedHours,
      rejectReason: e.rejectReason,
      routeMinimum: e.routeResult ? { expected: e.routeResult.expectedMinimum, meets: e.routeResult.meetsMinimum } : null,
      metrics: {
        loadRpm: e.result.loadRpm,
        pickupRpm: e.result.pickupRpm,
        rph: e.result.rph,
        profitPerMile: e.result.netAboveAllInPerMi,
        marginAfterFuelPct: e.fuelCost?.netMarginPct ?? null,
        fuelTotal: e.fuelCost?.totalFuelCost ?? null,
        tripHours: e.tripHours,
        truckCostPerMile: e.effectiveBreakEven
      },
      fees: (() => {
        const s = computeSettlement({ linehaul: input.offer, fuelSurcharge: e.fuelSurchargeDollars, layoverPay: 0, carrierCutPct: e.carrierCutPct, cutAppliesToFsc: e.cutAppliesToFsc, factoringFeePct: e.factoringFeePct, insuranceRiderFlat: e.insuranceRiderFlat });
        return { gross: s.gross, carrier: s.carrierDollars, carrierPct: e.carrierCutPct, factoring: s.factoringDollars, factoringPct: e.factoringFeePct, rider: s.riderDollars, net: s.net };
      })()
    }
  };
}

/**
 * The offer priced for the nearest trucks and each driver who runs them, best first. A big fleet has far more trucks than anyone can read, so the desk prices the `limit` nearest to the pickup (lib/quote-nearest.ts:
 * the ones whose empty miles are measured or typed, nearest first), each with its own empty miles, and ranks those by what each mile clears over the floor. A truck with a cost profile missing has no floor and is
 * counted apart. `terminal` is the scope in view: only its trucks are priced; null is the whole fleet. `keep` names trucks that are priced whatever their distance (the truck a saved quote is on).
 */
/** `seesPay`: false for someone who may not see driver pay (no billing capability): every row is still priced with the driver's usual pay, and no pay figure is in the answer. */
export async function fitQuote(input: QuoteInput, workspaceId = currentWorkspaceId(), now = new Date(), terminal: Terminals = null, limit: number = NEAREST_DEFAULT, keep: readonly string[] = [], opts: { seesPay?: boolean } = {}): Promise<FitResult> {
  const seesPay = opts.seesPay ?? true;
  const lane = await laneBenchmark(input, workspaceId, now);
  const judged = judgedBy(input, lane);
  const here = { workspaceId, archivedAt: null, ...(terminal != null ? { terminal: terminalFilter(terminal) } : {}) };
  // A light read of every truck in the scope (a name and whether it has a base), so the nearest can be chosen before anything is priced; only those are read in full.
  const [inScope, priceable, unpriced, soonDays] = await Promise.all([
    prisma.vehicle.count({ where: here }),
    prisma.vehicle.findMany({ where: { ...here, costProfile: { isNot: null } }, select: { id: true, name: true, homeBaseLat: true } }),
    prisma.vehicle.findMany({ where: { ...here, costProfile: null }, select: { name: true }, orderBy: { name: "asc" }, take: SKIPPED_NAMED }),
    getThresholds(workspaceId).then((t) => alertThresholds(t).clearanceDays)
  ]);
  const pick = nearestTrucks(priceable.map((v) => ({ id: v.id, name: v.name, located: v.homeBaseLat != null })), input.emptyByTruck, asLimit(limit));
  const priceableIds = new Set(priceable.map((v) => v.id));
  const ids = [...pick.ids, ...keep.filter((id) => priceableIds.has(id) && !pick.ids.includes(id))];
  const byId = new Map(
    (ids.length === 0
      ? []
      : await prisma.vehicle.findMany({
          where: { id: { in: ids }, ...here },
          include: { costProfile: true, drivers: { where: { active: true }, orderBy: { name: "asc" } }, trailers: { orderBy: { number: "asc" }, take: 3 } }
        })
    ).map((t) => [t.id, t] as const)
  );
  const trucks = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  // Each truck is committed from the time it has to leave its own base, so each has its own window; a driver's is their truck's.
  const winByTruck = new Map(trucks.map((t) => [t.id, windowOf(input, t.id)] as const));
  const truckOfDriver = new Map(trucks.flatMap((t) => t.drivers.map((d) => [d.id, t.id] as const)));
  const rows: FitRow[] = [];
  const skipped: FitResult["skipped"] = unpriced.map((v) => ({ truck: v.name ?? "Truck", why: "No cost profile, so no floor to price against." }));
  // Who is already on another load at that time, for the drivers of the trucks priced (one query), not one query per driver.
  const clashes = await driverClashesIn(trucks.flatMap((t) => t.drivers.map((d) => d.id)), "", (id) => winByTruck.get(truckOfDriver.get(id) ?? "") ?? null);
  const truckClashes = await truckClashesIn(trucks.map((t) => t.id), "", (id) => winByTruck.get(id) ?? null, workspaceId);
  // A card that lapses before the pickup is as good as lapsed for this load.
  const pickupAt = input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null;
  // Each driver's shift on the carrier's clock, from one batched read (a caution beside the hours-left one).
  const tz = await workspaceTimezone(workspaceId);
  const times = input.stops.map((s) => s.appointment).filter((t): t is number => t != null);
  const anchor = times.length > 0 ? times : [now.getTime()];
  const schedules = await loadSchedules(workspaceId, trucks.flatMap((t) => t.drivers.map((d) => d.id)), dateKeyOf(Math.min(...anchor), tz), dateKeyOf(Math.max(...anchor), tz));
  const shiftOf = (driverId: string | undefined) => (driverId ? quoteShift(schedules.get(driverId) ?? null, input.stops, now.getTime(), tz) : NO_QUOTE_SHIFT);
  for (const t of trucks) {
    if (!t.costProfile) continue;
    const drivers: Array<TruckForFit["drivers"][number] | null> = t.drivers.length > 0 ? t.drivers : [null];
    const truckBusy = truckClashes.has(t.id) ? `${t.name ?? "The truck"} is already on ${truckClashes.get(t.id) ?? "another load"} at that time` : null;
    let driversAllBlocked = t.drivers.length > 0;
    for (const d of drivers) {
      let blocked: string | null = truckBusy;
      let ownBlock: string | null = null;
      if (d) {
        // Good for the whole trip, as assigning asks (dispatch.ts): a card that lapses before the last delivery closes blocks, not only one that lapses before the pickup.
        ownBlock = driverBlocker(d, now, winByTruck.get(t.id)?.end ?? pickupAt);
        if (!ownBlock && clashes.has(d.id)) ownBlock = `Already on ${clashes.get(d.id) ?? "another load"} at that time`;
        blocked = blocked ?? ownBlock;
      }
      if (!ownBlock) driversAllBlocked = false;
      const r = fitFor(judged, t, d, blocked, shiftOf(d?.id), now, soonDays, seesPay);
      if (r) rows.push(r);
    }
    // Every driver of this truck is out (a lapsed card, another load): the truck can still be booked now and a driver put on it from the load.
    if (driversAllBlocked) {
      const r = fitFor(judged, t, null, truckBusy, NO_QUOTE_SHIFT, now, soonDays, seesPay);
      if (r) {
        r.warnings = [`No driver of ${t.name ?? "this truck"} can take it at that time. Book the truck and assign a driver from the load.`, ...r.warnings];
        rows.push(r);
      }
    }
  }
  rows.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || (b.marginPerMile ?? -Infinity) - (a.marginPerMile ?? -Infinity));
  const kept = await prisma.trailer.count({ where: { workspaceId, archivedAt: null } });
  const trailersAvailable = kept === 0 ? null : await countTrailersAvailable(input.trailer, terminal, now, workspaceId);
  const noProfile = inScope - priceable.length;
  return { rows, total: rows.length, scope: { inScope, available: pick.available, priced: trucks.length, limit: asLimit(limit), ranked: pick.ranked, measured: pick.measured }, skipped, skippedTotal: noProfile > 0 ? noProfile : 0, trailersAvailable, lane };
}

// ── What the desk already knows about this lane and this broker ───────────────────────────────

export type QuoteContext = {
  lane: { from: string; to: string; count: number; averagePerMile: number | null; recent: Array<{ id: string; loadNumber: string | null; on: Date | null; gross: number; perMile: number | null; broker: string | null }> } | null;
  broker: { name: string; loads: number; finished: number; fellThrough: number; averagePerMile: number | null; averageDaysToPay: number | null } | null;
  /** Quotes this desk passed on, on this lane and for this customer: a pass is a signal even though it is no load. */
  passed: { lane: number; broker: number };
};

/** "Dallas, TX" for an address (the city and the state: Springfield IL and Springfield MO are two lanes), or just the city when no state was typed. */
const cityStateOf = (address: string | undefined) => (cityState(address ?? "") ?? "").trim();
/** How many of the lane's most recent finished loads the average is taken over. */
const LANE_SAMPLE = 25;
const BROKER_SAMPLE = 1000;

/** A place that names its state ("Rome, GA") matches exactly, so Rome is not Jerome; a bare city (no state typed) is matched as part of an address. */
const placeMatch = (place: string) => (/,\s*[A-Za-z]{2}$/.test(place) ? { equals: place, mode: "insensitive" as const } : { contains: place, mode: "insensitive" as const });
const laneWhere = (from: string, to: string, workspaceId: string) => ({ workspaceId, deletedAt: null, ...notQuote, status: "completed", originAddress: placeMatch(from), destinationAddress: placeMatch(to) });
/** What a finished load paid in all, with its surcharge: the same footing as an offer. */
const paidOn = (l: Pick<Load, "actualRevenue" | "quotedRevenue" | "fuelSurcharge">) => (numOrNull(l.actualRevenue) ?? num(l.quotedRevenue)) + (numOrNull(l.fuelSurcharge) ?? 0);

async function laneLines(workspaceId: string): Promise<{ minLoads: number; days: number }> {
  const t = await getThresholds(workspaceId);
  return { minLoads: t.laneMinLoads, days: t.laneDays };
}

/** Over the loaded miles, as a market rate per loaded mile is quoted. */
export type LaneBenchmark = { perMile: number; loads: number; /** How far back the loads were counted. */ days: number };

/**
 * The desk's own record on this lane, for a quote with no market rate typed: enough recent finished loads of the same kind, or nothing. Most small fleets have no market feed; what
 * this lane has been paying them is the honest number they do have. It is not a market rate, and the card says whose it is.
 */
export async function laneBenchmark(input: QuoteInput, workspaceId: string, now: Date, lines?: { minLoads: number; days: number }): Promise<LaneBenchmark | null> {
  if (input.marketTotal != null) return null;
  const from = cityStateOf(input.stops[0]?.address);
  const to = cityStateOf(input.stops[input.stops.length - 1]?.address);
  if (from.length < 2 || to.length < 2) return null;
  // The workspace's own two thresholds (Settings), unless a caller names them.
  const { minLoads, days } = lines ?? (await laneLines(workspaceId));
  const recent = await prisma.load.findMany({
    where: { ...laneWhere(from, to, workspaceId), completedAt: { gte: new Date(now.getTime() - days * D) }, ...(input.trailer ? { trailerType: input.trailer } : {}) },
    orderBy: { completedAt: "desc" },
    take: LANE_SAMPLE,
    select: { actualRevenue: true, quotedRevenue: true, fuelSurcharge: true, loadedMiles: true }
  });
  const rates = recent.filter((l) => num(l.loadedMiles) > 0).map((l) => paidOn(l) / num(l.loadedMiles));
  return rates.length < minLoads ? null : { perMile: rates.reduce((s, r) => s + r, 0) / rates.length, loads: rates.length, days };
}

/**
 * The quote as the verdict reads it, with the lane's record in the market rate's place, so the same audited rules say what it means. For judging only: a saved or booked load keeps
 * what was typed, or nothing would tell a market rate somebody checked from a figure the desk worked out.
 */
const judgedBy = (input: QuoteInput, lane: LaneBenchmark | null): QuoteInput => (lane ? { ...input, marketTotal: lane.perMile * input.loadedMiles } : input);

/**
 * What the desk knows about the lane and the customer, for the terminals in view (`terminals`, null for everything): the history shown follows the scope, as the Lanes and Customers screens do.
 * The lane record that stands in for a market rate (laneBenchmark) is the whole company's on purpose (Chris, 2026-11-25), so every dispatcher gets the same verdict.
 */
export async function quoteContext(input: QuoteInput, workspaceId = currentWorkspaceId(), terminals: Terminals = null): Promise<QuoteContext> {
  const from = cityStateOf(input.stops[0]?.address);
  const to = cityStateOf(input.stops[input.stops.length - 1]?.address);
  const here = inTerminal(terminals);
  let lane: QuoteContext["lane"] = null;
  if (from.length >= 2 && to.length >= 2) {
    const where = { ...laneWhere(from, to, workspaceId), AND: [here] };
    const [count, recent] = await Promise.all([
      prisma.load.count({ where }),
      // The columns the lane box shows and averages, and no more: this runs on every price.
      prisma.load.findMany({ where, orderBy: { completedAt: "desc" }, take: LANE_SAMPLE, select: { id: true, loadNumber: true, completedAt: true, brokerName: true, actualRevenue: true, quotedRevenue: true, fuelSurcharge: true, loadedMiles: true } })
    ]);
    if (count > 0) {
      // The average is over the most recent LANE_SAMPLE finished loads; the list shows the latest five of them.
      const rows = recent.map((l) => {
        const gross = paidOn(l);
        const miles = num(l.loadedMiles);
        return { id: l.id, loadNumber: l.loadNumber, on: l.completedAt, gross, perMile: miles > 0 ? gross / miles : null, broker: l.brokerName };
      });
      const rated = rows.filter((r) => r.perMile != null);
      lane = { from: cityState(input.stops[0]!.address) ?? from, to: cityState(input.stops[input.stops.length - 1]!.address) ?? to, count, averagePerMile: rated.length > 0 ? rated.reduce((s, r) => s + r.perMile!, 0) / rated.length : null, recent: rows.slice(0, 5) };
    }
  }
  let broker: QuoteContext["broker"] = null;
  if (input.broker) {
    // The customer's most recent loads (a customer a desk has worked with for years has thousands; the record is read over the latest BROKER_SAMPLE).
    // The customer's latest BROKER_SAMPLE loads, only the columns the record reads: this runs on every price, and a customer of years holds thousands of loads.
    const theirs = await prisma.load.findMany({
      where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { equals: input.broker, mode: "insensitive" }, AND: [here] },
      orderBy: { createdAt: "desc" },
      take: BROKER_SAMPLE,
      select: { brokerName: true, status: true, actualRevenue: true, quotedRevenue: true, fuelSurcharge: true, loadedMiles: true, paymentStatus: true, invoicedAt: true, paidAt: true }
    });
    if (theirs.length > 0) {
      const done = theirs.filter((l) => l.status === "completed");
      const rated = done.map((l) => ({ gross: paidOn(l), miles: num(l.loadedMiles) })).filter((r) => r.miles > 0);
      const paid = theirs.filter((l) => l.paymentStatus === "paid" && l.invoicedAt && l.paidAt);
      broker = {
        name: theirs[0]!.brokerName ?? input.broker,
        loads: theirs.length,
        finished: done.length,
        fellThrough: theirs.filter((l) => l.status === "cancelled" || l.status === "tonu").length,
        averagePerMile: rated.length > 0 ? rated.reduce((s, r) => s + r.gross / r.miles, 0) / rated.length : null,
        averageDaysToPay: paid.length > 0 ? paid.reduce((s, l) => s + (l.paidAt!.getTime() - l.invoicedAt!.getTime()) / D, 0) / paid.length : null
      };
    }
  }
  const passedWhere = { workspaceId, status: QUOTE_STATUS, deletedAt: null, decisions: { some: { decisionType: PASSED } }, AND: [here] };
  const [passedLane, passedBroker] = await Promise.all([
    from.length >= 2 && to.length >= 2 ? prisma.load.count({ where: { ...passedWhere, originAddress: placeMatch(from), destinationAddress: placeMatch(to) } }) : 0,
    input.broker ? prisma.load.count({ where: { ...passedWhere, brokerName: { equals: input.broker, mode: "insensitive" } } }) : 0
  ]);
  return { lane, broker, passed: { lane: passedLane, broker: passedBroker } };
}

// ── Saving, listing and reopening quotes ──────────────────────────────────────────────────────

function stopRows(input: QuoteInput) {
  return input.stops.map((s, i) => ({
    stopSequence: i + 1,
    ...(s.lat != null && s.lng != null ? { lat: new Prisma.Decimal(s.lat).toDecimalPlaces(6), lng: new Prisma.Decimal(s.lng).toDecimalPlaces(6) } : {}),
    stopType: s.role,
    stopRole: s.role,
    addressString: s.address,
    facilityName: s.facility,
    contactName: s.contactName,
    contactPhone: s.contactPhone,
    stopNotes: s.notes,
    timeWindowEarliest: s.appointment != null ? new Date(s.appointment) : null,
    timeWindowLatest: s.appointmentEnd != null ? new Date(s.appointmentEnd) : s.appointment != null ? new Date(s.appointment) : null,
    referenceNumbers: s.refs
  }));
}

const quoteLane = (input: QuoteInput) => `${cityState(input.stops[0]!.address) ?? input.stops[0]!.address} to ${cityState(input.stops[input.stops.length - 1]!.address) ?? input.stops[input.stops.length - 1]!.address}`;

/** What a quote keeps that a load has no column for (see `Load.quoteExtras`). */
export type QuoteExtras = { fuelPrice: number | null; fuelSource: "typed" | "regional" | null; emptyByTruck: Record<string, number>; emptyHomeByTruck: Record<string, number>; manual: string[]; driverId: string | null; towingPerMile: number; permitEscort: number; marketBandFraction: number; /** What the quote first said, so a raise between that and the booking can be counted. */ firstOffer?: number | null };
const quoteExtrasOf = (input: QuoteInput): QuoteExtras => ({ fuelPrice: input.fuelPrice, fuelSource: input.fuelSource, emptyByTruck: input.emptyByTruck, emptyHomeByTruck: input.emptyHomeByTruck, manual: input.manual, driverId: input.driverId, towingPerMile: input.towingPerMile, permitEscort: input.permitEscort, marketBandFraction: input.marketBandFraction });
const extrasOf = (raw: unknown): Partial<QuoteExtras> => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Partial<QuoteExtras>) : {});

/** The load's own columns for a quote (everything the form holds that a load keeps). */
function loadFields(input: QuoteInput, truckId: string | null, firstOffer: number | null = null) {
  // The empty miles belong to the truck the load is on: its own measured or typed figures, else the form's.
  const emptyToPickup = (truckId ? input.emptyByTruck[truckId] : undefined) ?? input.emptyToPickup;
  const emptyHome = (truckId ? input.emptyHomeByTruck[truckId] : undefined) ?? input.emptyHome;
  const allMiles = emptyToPickup + input.loadedMiles + emptyHome;
  return {
    brokerName: input.broker,
    brokerMcNumber: input.brokerMc,
    poNumber: input.poNumber,
    brokerPhone: input.brokerPhone,
    brokerEmail: input.brokerEmail,
    // The broker's own load number replaces the desk's QT- number when one was typed; otherwise the QT- number stays.
    ...(input.loadNumber ? { loadNumber: input.loadNumber } : {}),
    rateConNumber: input.rateConNumber,
    proNumber: input.proNumber,
    bolNumber: input.bolNumber,
    originAddress: cityState(input.stops[0]!.address) ?? input.stops[0]!.address,
    destinationAddress: cityState(input.stops[input.stops.length - 1]!.address) ?? input.stops[input.stops.length - 1]!.address,
    trailerType: input.trailer,
    commodity: input.commodity,
    pieceCount: input.pieceCount != null ? new Prisma.Decimal(input.pieceCount).toDecimalPlaces(0).toNumber() : null,
    palletCount: input.palletCount != null ? new Prisma.Decimal(input.palletCount).toDecimalPlaces(0).toNumber() : null,
    weightLbs: input.specs.weightLbs,
    lengthFt: input.specs.lengthFt,
    widthFt: input.specs.widthFt,
    loadHeightIn: input.specs.heightIn,
    reeferSetTempF: input.reeferSetTempF != null ? new Prisma.Decimal(input.reeferSetTempF).toDecimalPlaces(1) : null,
    reeferMinF: input.reeferMinF != null ? new Prisma.Decimal(input.reeferMinF).toDecimalPlaces(1) : null,
    reeferMaxF: input.reeferMaxF != null ? new Prisma.Decimal(input.reeferMaxF).toDecimalPlaces(1) : null,
    reeferMode: input.reeferMode,
    hazmatClass: input.specs.hazmatClass,
    hazmatUnNumber: input.hazmatUnNumber,
    hazmatPackingGroup: input.hazmatPackingGroup,
    hazmatEmergencyPhone: input.hazmatEmergencyPhone,
    requiresLiftgate: input.specs.requiresLiftgate || null,
    requiresRamp: input.specs.requiresRamp || null,
    requiresPalletJack: input.specs.requiresPalletJack || null,
    notes: input.notes,
    paymentTerms: input.paymentTerms,
    rateConPath: input.rateConPath,
    pickupNumbers: input.stops.filter((s) => s.role === "pickup").flatMap((s) => s.refs),
    deliveryNumbers: input.stops.filter((s) => s.role === "delivery").flatMap((s) => s.refs),
    snapshotFreeGraceMinutes: input.detentionFreeMinutes,
    snapshotDetentionRate: input.detentionHourlyRate != null ? new Prisma.Decimal(input.detentionHourlyRate).toDecimalPlaces(2) : null,
    quotedRevenue: input.offer,
    fuelSurcharge: surchargeDollars(input),
    fuelSurchargeUnit: input.fscUnit,
    loadedMiles: input.loadedMiles,
    pickupDeadheadMiles: emptyToPickup,
    returnDeadheadMiles: emptyHome,
    estimatedLoadedHours: input.loadedHours,
    dockWaitMinutes: input.dockWaitMinutes > 0 ? wholeMinutes(input.dockWaitMinutes) : null,
    insuranceRiderFlat: input.insuranceRider > 0 ? input.insuranceRider : null,
    isBackhaul: input.loadBack,
    marketBenchmark: input.marketTotal != null && allMiles > 0 ? new Prisma.Decimal(input.marketTotal).div(allMiles).toDecimalPlaces(4) : null,
    payTermsDays: input.payTermsDays,
    factoringFeePct: input.factoringFraction,
    stopsCount: input.stops.filter((s) => s.role === "delivery").length,
    scheduledDate: input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null,
    quoteExtras: { ...quoteExtrasOf(input), firstOffer }
  };
}

/** The desk's own number for a quote: the time in seconds, and four random characters so two saved in the same second are not the same number. */
const quoteNumber = (now: Date) => `QT-${new Prisma.Decimal(now.getTime()).div(1000).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toNumber().toString(36).toUpperCase()}${randomBytes(2).toString("hex").toUpperCase()}`;

/** `version`: the quote's last change as the form last saw it (its `updatedAt`), so a save over someone else's newer change is refused rather than written over. */
export type QuoteSave = { ok: true; id: string; version: string } | { ok: false; errors?: QuoteErrors; error?: string; stale?: true };
/** What a write to a quote also carries: the person's limit (read from the request when left out; tests stand in for one) and the version the form holds. */
export type QuoteWriteOpts = { allowed?: Terminals; version?: string | null };
export const STALE_QUOTE = "Someone changed this quote since you opened it. Reload to see their version; what you typed stays here.";
/** Whether the quote has changed since the form's version (to the millisecond, which is what the column keeps). No version: a form from before versions, not refused. */
const movedSince = (updatedAt: Date, version: string | null | undefined) => version != null && version !== "" && updatedAt.getTime() !== Date.parse(version);

/** Save the form as a quote (or update the one it came from). It is not a load anyone can see on the board until it is booked. */
export async function saveQuote(raw: QuoteValues, quoteId: string | null, vehicleId: string | null, workspaceId = currentWorkspaceId(), now = new Date(), opts: QuoteWriteOpts = {}): Promise<QuoteSave> {
  const values = zonedValues(raw, await workspaceTimezone(workspaceId));
  const check = validateQuote(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const input = check.input;
  // The person's limit holds for the quote and for the truck it is saved on, whatever ids arrive.
  const allowed = await allowedFor(workspaceId, opts.allowed);
  const truck = vehicleId ? await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId, archivedAt: null } }) : null;
  if (truck && !inScope(allowed, truck.terminal)) return { ok: false, error: `${truck.name ?? "That truck"} is based outside the terminals you work. Pick a truck from them.` };
  const data = { ...loadFields(input, truck?.id ?? null, input.offer), vehicleId: truck?.id ?? null };
  if (quoteId) {
    const existing = await prisma.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(allowed) }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
    if (!existing) return { ok: false, error: "That quote is gone." };
    if (movedSince(existing.updatedAt, opts.version)) return { ok: false, error: STALE_QUOTE, stale: true };
    // A quote that was passed on stays as it was said: start a new one from it ("Quote like this") rather than rewrite it.
    if (existing.decisions[0]?.decisionType === PASSED) return { ok: false, error: "That quote was passed on. Start a new quote from it instead." };
    // A typed load number that has since been cleared goes back to the desk's own number.
    // The first offer stays what it was when the quote was first saved.
    const firstOffer = extrasOf(existing.quoteExtras).firstOffer ?? num(existing.quotedRevenue);
    const keep = { quoteExtras: { ...quoteExtrasOf(input), firstOffer } };
    const number = !input.loadNumber && existing.loadNumber && !/^QT-/.test(existing.loadNumber) ? { loadNumber: quoteNumber(now) } : {};
    const saved = await prisma.$transaction(async (tx): Promise<"ok" | "gone" | "stale" | "passed"> => {
      // One write to a quote at a time per desk, so the checks below and the write are not interleaved with a booking, a pass or another save.
      await lockWorkspace(tx, workspaceId);
      const fresh = await tx.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, select: { updatedAt: true, decisions: { where: { decisionType: PASSED }, select: { id: true }, take: 1 } } });
      if (!fresh) return "gone";
      if (fresh.decisions.length > 0) return "passed";
      if (movedSince(fresh.updatedAt, opts.version)) return "stale";
      // Only while it is still a quote: a booking that got there first is not overwritten.
      const claimed = await tx.load.updateMany({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, data: { ...data, ...keep, ...number } });
      if (claimed.count !== 1) return "gone";
      await tx.stop.deleteMany({ where: { loadId: quoteId } });
      await tx.stop.createMany({ data: stopRows(input).map((s) => ({ ...s, loadId: quoteId })) });
      await recordAudit({ entity: "load", entityId: quoteId, action: "quote_saved", loadId: null, loadNumber: existing.loadNumber, workspaceId, summary: `Quote updated: ${quoteLane(input)}, $${input.offer.toLocaleString("en-US")}`, before: null, after: null, at: now }, tx);
      return "ok";
    });
    if (saved === "stale") return { ok: false, error: STALE_QUOTE, stale: true };
    if (saved === "passed") return { ok: false, error: "That quote was passed on. Start a new quote from it instead." };
    if (saved === "gone") return { ok: false, error: "That quote was booked or thrown away while you were editing it." };
    const after = await prisma.load.findUniqueOrThrow({ where: { id: quoteId }, select: { updatedAt: true } });
    return { ok: true, id: quoteId, version: after.updatedAt.toISOString() };
  }
  const created = await prisma.$transaction(async (tx) => {
    const l = await tx.load.create({ data: { workspaceId, status: QUOTE_STATUS, channel: "quote", loadNumber: quoteNumber(now), ...data, stops: { create: stopRows(input) } } });
    await recordAudit({ entity: "load", entityId: l.id, action: "quote_saved", loadId: null, loadNumber: l.loadNumber, workspaceId, summary: `Quote saved: ${quoteLane(input)}, $${input.offer.toLocaleString("en-US")}${input.broker ? ` for ${input.broker}` : ""}`, before: null, after: null, at: now }, tx);
    return l;
  });
  return { ok: true, id: created.id, version: created.updatedAt.toISOString() };
}

/** A customer the desk keeps a record of, as the quote form fills from it. */
export type CustomerOption = { name: string; mc: string | null; phone: string | null; email: string | null; payTermsDays: number | null; slowPay?: CustomerSlowPay | null };

/**
 * The form's suggestions for the customer box: every customer record, then any name only the loads carry (a spelling that differs only in capitals is one customer, and the record's
 * spelling wins). Computes customer payment performance (days to pay, overdue invoices) to surface slow-pay warnings.
 */
/** `terminals`: the customers of the terminals in view (and their payment record from those loads): the customers with loads there, plus the records with no loads yet (the Customers screen's rule). Null is everyone. */
export async function brokerNames(workspaceId = currentWorkspaceId(), terminals: Terminals = null): Promise<CustomerOption[]> {
  const here = inTerminal(terminals);
  const [records, rows, invoicedLoads] = await Promise.all([
    listCustomerRecordsInScope(terminals, workspaceId),
    prisma.load.groupBy({ by: ["brokerName"], where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { not: null }, AND: [here] }, orderBy: { brokerName: "asc" } }),
    prisma.load.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...notQuote,
        brokerName: { not: null },
        invoicedAt: { not: null },
        AND: [here]
      },
      select: {
        brokerName: true,
        paymentStatus: true,
        invoicedAt: true,
        paidAt: true,
        invoicedAmount: true,
        payTermsDays: true
      },
      // The most recent invoices, so the slow-pay warning reads how each customer pays now (it was any 2,000, in no order).
      orderBy: { invoicedAt: "desc" },
      take: 2000
    })
  ]);

  const payMap = summarizeCustomerPay(
    invoicedLoads.map((l) => ({
      brokerName: l.brokerName,
      paymentStatus: l.paymentStatus,
      invoicedAt: l.invoicedAt,
      paidAt: l.paidAt,
      invoicedAmount: numOrNull(l.invoicedAmount),
      payTermsDays: l.payTermsDays
    }))
  );

  const out = new Map<string, CustomerOption>();
  for (const c of records) {
    const key = c.name.trim().toLowerCase();
    out.set(key, {
      name: c.name,
      mc: c.mcNumber,
      phone: c.contactPhone,
      email: c.contactEmail,
      payTermsDays: c.defaultPayTermsDays,
      slowPay: payMap.get(key) ?? null
    });
  }
  for (const r of rows) {
    const name = r.brokerName?.trim();
    if (name) {
      const key = name.toLowerCase();
      if (!out.has(key)) {
        out.set(key, {
          name,
          mc: null,
          phone: null,
          email: null,
          payTermsDays: null,
          slowPay: payMap.get(key) ?? null
        });
      }
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Open loads in need of a driver with an initial pickup stop, for backhaul discovery on quote. */
export async function listOpenPickups(workspaceId = currentWorkspaceId(), terminals: Terminals = null): Promise<OpenPickupCandidate[]> {
  const loads = await prisma.load.findMany({
    // The terminals in view (a booking with no truck yet is everyone's), soonest pickup first so the hundred shown are the ones coming up.
    where: {
      workspaceId,
      deletedAt: null,
      status: "draft",
      AND: [inTerminal(terminals)]
    },
    orderBy: [{ scheduledDate: "asc" }, { createdAt: "desc" }],
    select: {
      id: true,
      loadNumber: true,
      stops: {
        where: {
          OR: [{ stopRole: "pickup" }, { stopSequence: 0 }]
        },
        orderBy: { stopSequence: "asc" },
        take: 1,
        select: {
          addressString: true,
          lat: true,
          lng: true
        }
      }
    },
    take: 100
  });

  const candidates: OpenPickupCandidate[] = [];
  for (const l of loads) {
    const s = l.stops[0];
    if (s && s.addressString) {
      candidates.push({
        loadId: l.id,
        loadNumber: l.loadNumber ?? "Unnumbered",
        address: s.addressString,
        lat: numOrNull(s.lat),
        lng: numOrNull(s.lng)
      });
    }
  }
  return candidates;
}

/** The customer record for a typed name (any capitals), or null. */
async function customerNamed(name: string | null, workspaceId: string) {
  if (!name) return null;
  return prisma.customer.findFirst({ where: { workspaceId, name: { equals: name.trim(), mode: "insensitive" } } });
}

/** `pickupAt`: the first stop's time, so a quote whose pickup has gone by is marked (Chris, 2026-11-25: marked only, never passed on by itself). */
export type QuoteListRow = { id: string; lane: string; broker: string | null; offer: number; loadedMiles: number; savedAt: Date; truck: string | null; /** Why it was passed on, or null while it is still open. */ passedFor: string | null; pickupAt: Date | null };
/** `past`: open quotes whose pickup time has gone by. */
export type QuoteListStatus = "open" | "passed" | "all" | "past";
export type QuoteListFilter = { q?: string; status?: QuoteListStatus; offset?: number; now?: Date };
export const QUOTE_PAGE = 20;

/** Saved quotes, newest first, a page at a time. `q` matches the lane, the customer, the load number or the truck; `status` keeps open ones, passed ones, or both. */
export async function listQuotes(workspaceId = currentWorkspaceId(), filter: QuoteListFilter = {}, terminals: Terminals = null): Promise<{ rows: QuoteListRow[]; total: number }> {
  const q = (filter.q ?? "").trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const where: Prisma.LoadWhereInput = {
    workspaceId,
    status: QUOTE_STATUS,
    deletedAt: null,
    AND: [
      inTerminal(terminals),
      ...words.map((w) => ({ OR: [{ originAddress: { contains: w, mode: "insensitive" as const } }, { destinationAddress: { contains: w, mode: "insensitive" as const } }, { brokerName: { contains: w, mode: "insensitive" as const } }, { loadNumber: { contains: w, mode: "insensitive" as const } }, { vehicle: { name: { contains: w, mode: "insensitive" as const } } }] })),
      ...(filter.status === "passed"
        ? [{ decisions: { some: { decisionType: PASSED } } }]
        : filter.status === "open"
          ? [{ decisions: { none: { decisionType: PASSED } } }]
          : filter.status === "past"
            ? [{ decisions: { none: { decisionType: PASSED } } }, { scheduledDate: { lt: filter.now ?? new Date() } }]
            : [])
    ]
  };
  const [total, rows] = await Promise.all([
    prisma.load.count({ where }),
    prisma.load.findMany({ where, include: { vehicle: true, decisions: { orderBy: { decidedAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, skip: Math.max(0, filter.offset ?? 0), take: QUOTE_PAGE })
  ]);
  return {
    total,
    rows: rows.map((l) => ({
      id: l.id,
      lane: `${cityState(l.originAddress) ?? "?"} to ${cityState(l.destinationAddress) ?? "?"}`,
      broker: l.brokerName,
      offer: num(l.quotedRevenue),
      loadedMiles: num(l.loadedMiles),
      savedAt: l.updatedAt,
      truck: l.vehicle?.name ?? null,
      passedFor: l.decisions[0]?.decisionType === PASSED ? (l.decisions[0].overrideReason ?? "Passed") : null,
      pickupAt: l.scheduledDate
    }))
  };
}

type LoadWithStops = Prisma.LoadGetPayload<{ include: { stops: true } }>;

/** A load as the form's values. The surcharge goes back to the unit it was typed in, as the phone does. */
export function quoteValuesFromLoad(l: LoadWithStops, carrier: string = DEFAULT_TZ): QuoteValues {
  const dec = (n: number | null, places = 4) => (n == null ? "" : new Prisma.Decimal(n).toDecimalPlaces(places).toString());
  const unit = l.fuelSurchargeUnit === "per_mile" ? "per_mile" : "percent";
  const dollars = numOrNull(l.fuelSurcharge) ?? 0;
  const loaded = num(l.loadedMiles);
  const fsc = dollars > 0 ? (unit === "per_mile" ? fuelSurchargePerMileFromDollars(loaded, dollars) : fuelSurchargePercentFromDollars(num(l.quotedRevenue), dollars)) : null;
  const allMiles = num(l.pickupDeadheadMiles) + loaded + num(l.returnDeadheadMiles);
  const bench = numOrNull(l.marketBenchmark);
  const factoring = numOrNull(l.factoringFeePct);
  const extras = extrasOf(l.quoteExtras);
  const asText = (m: Record<string, number> | undefined) => Object.fromEntries(Object.entries(m ?? {}).map(([k, v]) => [k, dec(v)]));
  const stops = [...l.stops].sort((a, b) => a.stopSequence - b.stopSequence);
  return {
    stops: stops.map((s) => {
      // Each time on the clock at its own dock, as it was typed.
      const zone = stopZoneOf(s, carrier);
      const open = s.timeWindowEarliest ? toCentralLocal(s.timeWindowEarliest.getTime(), zone) : "";
      const close = s.timeWindowLatest ? toCentralLocal(s.timeWindowLatest.getTime(), zone) : "";
      const lat = numOrNull(s.lat);
      const lng = numOrNull(s.lng);
      const refs = Array.isArray(s.referenceNumbers) ? (s.referenceNumbers as unknown[]).map(String).join(", ") : "";
      return {
        role: (s.stopRole ?? s.stopType) === "delivery" ? "delivery" : "pickup",
        address: s.addressString,
        zone,
        ...(lat != null && lng != null ? { lat, lng } : {}),
        appointment: open,
        appointmentEnd: close && close !== open ? close : "",
        facility: s.facilityName ?? "",
        contactName: s.contactName ?? "",
        contactPhone: s.contactPhone ?? "",
        notes: s.stopNotes ?? "",
        refs
      };
    }),
    broker: l.brokerName ?? "",
    brokerMc: l.brokerMcNumber ?? "",
    // A QT- number is the desk's own, not the broker's: it is not offered back as one to type over.
    loadNumber: l.loadNumber && !/^QT-/.test(l.loadNumber) ? l.loadNumber : "",
    rateConNumber: l.rateConNumber ?? "",
    proNumber: l.proNumber ?? "",
    bolNumber: l.bolNumber ?? "",
    poNumber: l.poNumber ?? "",
    brokerPhone: l.brokerPhone ?? "",
    brokerEmail: l.brokerEmail ?? "",
    trailer: l.trailerType ?? "",
    commodity: l.commodity ?? "",
    pieceCount: l.pieceCount == null ? "" : String(l.pieceCount),
    palletCount: l.palletCount == null ? "" : String(l.palletCount),
    weightLbs: l.weightLbs == null ? "" : String(l.weightLbs),
    lengthFt: dec(numOrNull(l.lengthFt), 2),
    widthFt: dec(numOrNull(l.widthFt), 2),
    heightIn: dec(numOrNull(l.loadHeightIn), 2),
    reeferSetTempF: dec(numOrNull(l.reeferSetTempF), 1),
    reeferMinF: dec(numOrNull(l.reeferMinF), 1),
    reeferMaxF: dec(numOrNull(l.reeferMaxF), 1),
    reeferMode: l.reeferMode ?? "",
    hazmatClass: l.hazmatClass ?? "",
    hazmatUnNumber: l.hazmatUnNumber ?? "",
    hazmatPackingGroup: l.hazmatPackingGroup ?? "",
    hazmatEmergencyPhone: l.hazmatEmergencyPhone ?? "",
    requiresLiftgate: l.requiresLiftgate === true,
    requiresRamp: l.requiresRamp === true,
    requiresPalletJack: l.requiresPalletJack === true,
    notes: l.notes ?? "",
    paymentTerms: l.paymentTerms ?? "",
    detentionFreeMinutes: l.snapshotFreeGraceMinutes == null ? "" : String(l.snapshotFreeGraceMinutes),
    detentionHourlyRate: dec(numOrNull(l.snapshotDetentionRate), 2),
    rateConPath: l.rateConPath ?? "",
    offer: dec(num(l.quotedRevenue), 2),
    fsc: dec(fsc, 4),
    fscUnit: unit,
    marketRate: bench != null && allMiles > 0 ? dec(bench * allMiles, 2) : "",
    loadedMiles: dec(loaded),
    emptyToPickup: num(l.pickupDeadheadMiles) > 0 ? dec(num(l.pickupDeadheadMiles)) : "",
    emptyHome: num(l.returnDeadheadMiles) > 0 ? dec(num(l.returnDeadheadMiles)) : "",
    loadBack: l.isBackhaul,
    payTermsDays: l.payTermsDays == null ? "" : String(l.payTermsDays),
    // Zero is an answer ("no factoring on this one"), not a blank.
    factoringPct: factoring != null ? dec(factoring * 100) : "",
    emptyByTruck: asText(extras.emptyByTruck),
    emptyHomeByTruck: asText(extras.emptyHomeByTruck),
    loadedHours: l.estimatedLoadedHours == null ? "" : dec(num(l.estimatedLoadedHours), 2),
    // The fuel price a quote was judged on comes back with it, with where it came from, so a reopened quote is not re-priced on today's price.
    fuelPrice: extras.fuelPrice != null ? dec(extras.fuelPrice, 2) : "",
    fuelSource: extras.fuelPrice != null ? (extras.fuelSource === "regional" ? "regional" : "typed") : "",
    dockWaitMinutes: l.dockWaitMinutes != null && l.dockWaitMinutes > 0 ? String(l.dockWaitMinutes) : "",
    towingPerMile: extras.towingPerMile ? dec(extras.towingPerMile, 2) : "",
    permitEscort: extras.permitEscort ? dec(extras.permitEscort, 2) : "",
    insuranceRider: numOrNull(l.insuranceRiderFlat) ? dec(numOrNull(l.insuranceRiderFlat), 2) : "",
    marketBand: extras.marketBandFraction === 0.05 ? "5" : extras.marketBandFraction === 0.15 ? "15" : "",
    driverId: extras.driverId ?? "",
    manual: Array.isArray(extras.manual) ? extras.manual : []
  };
}

/** A saved quote as the form's values, to reopen it. */
export async function getQuote(id: string, workspaceId = currentWorkspaceId()): Promise<{ values: QuoteValues; vehicleId: string | null; passedFor: string | null; version: string } | null> {
  // A quote on a truck outside the person's limit is not found, whatever id the address carries.
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null, AND: [inTerminal(await currentAllowed(workspaceId))] }, include: { stops: { orderBy: { stopSequence: "asc" } }, decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (!l) return null;
  const passed = l.decisions[0]?.decisionType === PASSED ? (l.decisions[0].overrideReason ?? "Passed") : null;
  return { vehicleId: l.vehicleId, values: quoteValuesFromLoad(l, await workspaceTimezone(workspaceId)), passedFor: passed, version: l.updatedAt.toISOString() };
}

/**
 * "Quote like this": any load (booked, finished or a saved quote) as the start of a new quote. The lane, broker, trailer, size and miles carry over;
 * the load number, PO and both times do not, because they belong to that one load. Nothing is written until the new quote is saved or booked.
 */
export async function getQuoteLike(id: string, workspaceId = currentWorkspaceId()): Promise<QuoteValues | null> {
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null, AND: [inTerminal(await currentAllowed(workspaceId))] }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l || l.stops.length < 2) return null;
  const v = quoteValuesFromLoad(l, await workspaceTimezone(workspaceId));
  return { ...v, loadNumber: "", poNumber: "", rateConNumber: "", proNumber: "", bolNumber: "", rateConPath: "", stops: v.stops.map((st) => ({ ...st, appointment: "", appointmentEnd: "", refs: "" })) };
}

// -- Passing on a quote ---------------------------------------------------------------------------

/** A pass is a decision on the quote; the quote stays a quote, so it stays out of every list of loads. */
export const PASSED = "passed";

export async function passQuote(id: string, reason: string, notes: string, workspaceId = currentWorkspaceId(), now = new Date(), allowed?: Terminals): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(PASS_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "Pick a reason." };
  if (reason === "Other" && notes.trim().length < 3) return { ok: false, error: "Say what the reason is when you pick Other." };
  // A quote sitting on a truck outside the person's limit is not theirs to pass (a quote with no truck yet is everyone's).
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(allowed !== undefined ? allowed : await currentAllowed(workspaceId)) }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 }, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l) return { ok: false, error: "That quote is gone." };
  if (l.decisions[0]?.decisionType === PASSED) return { ok: false, error: "That quote was already passed on." };
  // What it was worth when it was passed on: priced again as it stands, for the record. Never stops the pass.
  let details: DecisionDetails | null = null;
  try {
    const check = validateQuote(quoteValuesFromLoad(l, await workspaceTimezone(workspaceId)));
    if (check.ok) {
      const [fit, laneRecord] = await Promise.all([fitQuote(check.input, workspaceId, now, await currentTerminal(workspaceId)), laneBenchmark(check.input, workspaceId, now)]);
      const row = fit.rows.find((r) => r.truckId === l.vehicleId && !r.blocked) ?? fit.rows.find((r) => !r.blocked) ?? fit.rows[0] ?? null;
      details = decisionDetails(check.input, row, laneRecord, extrasOf(l.quoteExtras).firstOffer ?? num(l.quotedRevenue));
    }
  } catch {
    details = null;
  }
  const lane = `${cityState(l.originAddress) ?? "?"} to ${cityState(l.destinationAddress) ?? "?"}`;
  const scope = allowed !== undefined ? allowed : await currentAllowed(workspaceId);
  const outcome = await prisma.$transaction(async (tx): Promise<"ok" | "gone" | "passed"> => {
    // Claimed under the desk's lock: a booking or another pass that got there first since the quote was read wins, and this pass is refused rather than written onto a booked load.
    await lockWorkspace(tx, workspaceId);
    const fresh = await tx.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(scope) }, select: { decisions: { where: { decisionType: PASSED }, select: { id: true }, take: 1 } } });
    if (!fresh) return "gone";
    if (fresh.decisions.length > 0) return "passed";
    await tx.load.update({ where: { id }, data: { updatedAt: now } });
    await tx.loadDecision.create({ data: { loadId: id, decisionType: PASSED, overrideReason: reason, overrideNotes: notes.trim() || null, decidedAt: now, decidedBy: currentActor(), decidedById: currentActorId(), ...(details ? { details: details as unknown as Prisma.InputJsonObject } : {}) } });
    await recordAudit(
      {
        entity: "load",
        action: "quote_passed",
        // The quote is not on the board, so the entry names it and does not link to a page that would not open.
        loadId: null,
        loadNumber: l.loadNumber,
        workspaceId,
        summary: `Passed on a quote: ${lane}, $${num(l.quotedRevenue).toLocaleString("en-US")}. ${reason}`,
        reason: [reason, notes.trim()].filter(Boolean).join(": "),
        before: null,
        after: { Lane: lane, Offer: `$${num(l.quotedRevenue).toLocaleString("en-US")}`, Outcome: "Passed" },
        at: now
      },
      tx
    );
    return "ok";
  });
  if (outcome === "gone") return { ok: false, error: "That quote was booked or thrown away since you opened it. Look for it on the board." };
  if (outcome === "passed") return { ok: false, error: "That quote was already passed on." };
  return { ok: true };
}

/** Throw a saved quote away. It is written to the audit trail (a quote was priced for a customer; its being thrown away is part of that customer's record). */
export async function discardQuote(id: string, workspaceId = currentWorkspaceId(), now = new Date(), allowed?: Terminals): Promise<boolean> {
  // A quote on a truck outside the person's limit is not theirs to throw away (a quote with no truck yet is everyone's).
  const scope = await allowedFor(workspaceId, allowed);
  const q = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(scope) } });
  if (!q) return false;
  const lane = `${cityState(q.originAddress) ?? "?"} to ${cityState(q.destinationAddress) ?? "?"}`;
  return prisma.$transaction(async (tx) => {
    const out = await tx.load.updateMany({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(scope) }, data: { deletedAt: now } });
    if (out.count !== 1) return false;
    await recordAudit({ entity: "load", action: "quote_discarded", loadId: null, loadNumber: q.loadNumber, workspaceId, summary: `Quote thrown away: ${lane}, $${num(q.quotedRevenue).toLocaleString("en-US")}${q.brokerName ? ` for ${q.brokerName}` : ""}`, before: { Lane: lane, Offer: `$${num(q.quotedRevenue).toLocaleString("en-US")}` }, after: null, at: now }, tx);
    return true;
  });
}

// ── What a decision was made on ───────────────────────────────────────────────────────────────

/** What a booking or a pass was decided on, kept with it (`LoadDecision.details`) for the Quote decisions report. */
export type DecisionDetails = {
  verdict: "take" | "think" | "reject" | "unjudged";
  band: string;
  gate: string | null;
  /** What the pay was read against: a market rate typed, the desk's own lane, or nothing. */
  benchmark: "market" | "lane" | "none";
  offer: number;
  firstOffer: number | null;
  gross: number;
  totalMiles: number;
  allInPerMile: number | null;
  floorPerMile: number;
  marginPerMile: number | null;
  leftOver: number | null;
  marketVariancePct: number | null;
  customer: string | null;
  lane: string;
  truck: string | null;
  driver: string | null;
  fuelPrice: number | null;
  fuelSource: "typed" | "regional" | null;
};

export function decisionDetails(input: QuoteInput, row: FitRow | null, lane: LaneBenchmark | null, firstOffer: number | null): DecisionDetails {
  const verdict = row ? verdictState({ band: row.band, gate: row.gate, thinMargin: row.detail.thinMargin, timeTrap: row.detail.timeTrap }) : "unjudged";
  return {
    verdict,
    band: row?.band ?? "no_benchmark",
    gate: row?.gate ?? null,
    benchmark: input.marketTotal != null ? "market" : lane ? "lane" : "none",
    offer: input.offer,
    firstOffer,
    gross: row?.detail.effectiveGross ?? input.offer,
    totalMiles: row?.totalMiles ?? input.emptyToPickup + input.loadedMiles + (input.loadBack ? 0 : input.emptyHome),
    allInPerMile: row?.allInPerMile ?? null,
    floorPerMile: row?.floorPerMile ?? 0,
    marginPerMile: row?.marginPerMile ?? null,
    leftOver: row?.leftOver ?? null,
    marketVariancePct: row?.detail.marketVariancePct ?? null,
    customer: input.broker,
    lane: quoteLane(input),
    truck: row?.truckName ?? null,
    driver: row?.driverName ?? null,
    fuelPrice: input.fuelPrice,
    fuelSource: input.fuelSource
  };
}

// ── Booking ───────────────────────────────────────────────────────────────────────────────────

export type BookResult =
  | { ok: true; loadId: string; loadNumber: string | null; assigned: boolean; note: string | null }
  | {
      ok: false;
      errors?: QuoteErrors;
      error?: string;
      gate?: AcceptGate;
      /** The pickup is more than a day past: booking needs the person to say so (`pastOk`). */
      pastPickup?: true;
      /** The driver's hours need a reason before they are put on it (the hours note). */
      hos?: string;
      /** The customer has no record yet: booking makes one, so it asks what kind it is first, and offers the close spellings already on the desk. */
      newCustomer?: { name: string; near: string[] };
      /** FMCSA found no active authority for the MC, or no one with it: booking it needs a reason (Chris, 2026-11-25: warn with a reason, any dispatcher). */
      authority?: { mc: string; state: AuthorityState; label: string; name: string | null };
      stale?: true;
    };

/** What booking also carries: the version and limit as for a save, a yes to a pickup already past, and the reason for putting a driver on it with the hours they have. */
export type BookOpts = QuoteWriteOpts & {
  pastOk?: boolean;
  hosReason?: string | null;
  /** What a new customer record is (Chris, 2026-11-25: asked every time). */
  customerKind?: CustomerKind | null;
  /** Why it is booked although FMCSA shows no active authority for the MC, or no one with it. */
  authorityReason?: string | null;
  /** The person checked the MC on SAFER themselves while FMCSA's lookup did not answer: on the record beside "not checked". */
  saferChecked?: boolean;
  /** Tests stand in for the FMCSA lookup with this; the desk uses the real one (server/fmcsa/lookup.ts). */
  authorityLookup?: (mc: string) => Promise<AuthorityResult>;
};

/** FMCSA answers that need a reason before the load is booked: no active authority, or no one with that MC. A carrier's own authority with no broker authority is said, not asked about. */
const ASK_ABOUT: readonly AuthorityState[] = ["inactive", "not_found"];
/** How long past a pickup can be before booking asks. A load typed a little late is normal; one a day or more back is usually the wrong date or year. */
const PAST_PICKUP_MS = 24 * 3_600_000;

export type Override = { reason: string; notes: string };

/**
 * Book a quote on a truck, and optionally with its driver. The verdict is worked out again here, never taken from the browser: a load that
 * needs a reason (below its cost, no fuel price, well under the market or its own lane) is refused without one, and the reason is kept with the
 * decision. Both ends need a time, because the desk cannot yet edit a stop and a load with no times cannot be planned or chased.
 */
export async function bookQuote(
  raw: QuoteValues,
  pick: { vehicleId: string; driverId: string | null },
  override: Override | null,
  quoteId: string | null,
  workspaceId = currentWorkspaceId(),
  now = new Date(),
  opts: BookOpts = {}
): Promise<BookResult> {
  const values = zonedValues(raw, await workspaceTimezone(workspaceId));
  const check = validateQuote(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const input = check.input;
  const last = input.stops.length - 1;
  const missing = missingTimes(input.stops);
  if (Object.keys(missing).length > 0) return { ok: false, errors: missing };
  const pickupAt = input.stops[0]?.appointment ?? null;
  if (pickupAt != null && pickupAt < now.getTime() - PAST_PICKUP_MS && !opts.pastOk) {
    return { ok: false, pastPickup: true, error: "The pickup time is more than a day ago. Check the date and the year, or say it is right to book it." };
  }
  const allowed = await allowedFor(workspaceId, opts.allowed);

  const truck = await prisma.vehicle.findFirst({ where: { id: pick.vehicleId, workspaceId, archivedAt: null }, include: { costProfile: true, drivers: { where: { active: true } }, trailers: { take: 3 } } });
  if (!truck) return { ok: false, error: "That truck is not available." };
  if (!truck.costProfile) return { ok: false, error: `${truck.name} has no cost profile yet. Set it up on the truck's page, then book.` };
  // The truck is in the terminal being worked, and the driver runs that truck: the browser's word is not taken for either.
  const terminal = await currentTerminal(workspaceId);
  if (terminal != null && !inScope(terminal, truck.terminal)) return { ok: false, error: `${truck.name} is outside the ${scopeWords(terminal)} you are working in. Switch your scope, or pick a truck from it.` };
  const driver = pick.driverId ? (truck.drivers.find((d) => d.id === pick.driverId) ?? null) : null;
  if (pick.driverId && !driver) return { ok: false, error: "That driver is not available on this truck." };

  // The customer record, when there is one: the load carries its spelling, and an MC typed against a different one is refused (a name used with someone else's authority is the double-brokering trap).
  const record = await customerNamed(input.broker, workspaceId);
  if (record?.mcNumber && input.brokerMc && record.mcNumber.replace(/\D/g, "") !== input.brokerMc.replace(/\D/g, "")) {
    const msg = `${record.name} is on your customers with MC ${record.mcNumber}, not MC ${input.brokerMc}. Check who this load is really from before you book it.`;
    return { ok: false, errors: { brokerMc: msg }, error: msg };
  }
  if (record) input.broker = record.name;
  // A name with no record makes a new customer: asked first, every time, what kind it is, with the close spellings already on the desk (a typo is a second customer whose pay record,
  // MC and terms then follow nothing).
  if (input.broker && !record && !(opts.customerKind && (CUSTOMER_KINDS as readonly { key: string }[]).some((k) => k.key === opts.customerKind))) {
    const names = await prisma.customer.findMany({ where: { workspaceId }, select: { name: true } });
    return { ok: false, newCustomer: { name: input.broker, near: nearNames(input.broker, names.map((c) => c.name)) }, error: `${input.broker} is not on your customers yet. Say what kind it is, or pick the one you meant.` };
  }
  // The same MC on another customer's record: a caution after booking, not a refusal (one company can trade under two names; a borrowed MC is the double-brokering sign).
  const mcDigits = (input.brokerMc ?? "").replace(/\D/g, "");
  const mcTwin = mcDigits ? await prisma.customer.findFirst({ where: { workspaceId, mcNumber: { contains: mcDigits }, ...(record ? { id: { not: record.id } } : {}), NOT: { name: { equals: input.broker ?? "", mode: "insensitive" } } }, select: { name: true, mcNumber: true } }) : null;
  const mcNote = mcTwin && (mcTwin.mcNumber ?? "").replace(/\D/g, "") === mcDigits ? `MC ${mcDigits} is also on ${mcTwin.name}'s record. Check who this load is really from.` : null;

  // The customer's authority, checked at FMCSA when an MC was typed (a shipper has none and is not asked about). Risk control, not a rule the carrier is bound by: no active authority or no
  // one with the MC needs a reason, which is kept with the booking; an outage or a spent daily allowance books with "not checked" on the record (and the person's own SAFER check, if they
  // made one). A carrier's own authority with no broker authority is told after booking, never asked about.
  const mcForAuthority = normalizeMcNumber(input.brokerMc);
  let authority: AuthorityResult | null = null;
  if (mcForAuthority) {
    authority = opts.authorityLookup ? await opts.authorityLookup(mcForAuthority) : overBudget("fmcsa", workspaceId) ? noAuthority("unavailable") : await lookupMc(mcForAuthority);
  }
  const authorityReason = (opts.authorityReason ?? "").trim();
  if (authority && mcForAuthority && ASK_ABOUT.includes(authority.state) && authorityReason.length < 3) {
    return { ok: false, authority: { mc: mcForAuthority, state: authority.state, label: authority.label, name: authority.name }, error: `FMCSA: ${authority.label} for MC ${mcForAuthority}. Say why you are booking it anyway.` };
  }
  const authorityText = !authority
    ? null
    : authority.state === "unavailable"
      ? `Not checked (FMCSA did not answer)${opts.saferChecked ? "; checked on SAFER by hand" : ""}`
      : `${authority.label}${authority.name ? ` (${authority.name})` : ""}${ASK_ABOUT.includes(authority.state) ? `; booked anyway: ${authorityReason}` : ""}`;
  const authorityNote = authority?.state === "carrier" ? `FMCSA: MC ${mcForAuthority} has carrier authority only, not broker authority. Check who this load is really from.` : null;

  const laneRecord = await laneBenchmark(input, workspaceId, now);
  const fit = fitFor(judgedBy(input, laneRecord), { ...truck, drivers: driver ? [driver] : [] } as TruckForFit, driver, null, NO_QUOTE_SHIFT, now)!;
  const forLoad = truckFit(input.specs, truckLimits(truck));
  if (forLoad.blocker) return { ok: false, error: `${truck.name} cannot take this load. ${forLoad.blocker}` };
  // Putting a driver on it whose hours are short or not current needs its own reason, as assigning asks (the evidence the call was made knowingly, 49 CFR 390.6); it goes with the assignment.
  const hosReason = (opts.hosReason ?? "").trim();
  if (driver && fit.hos.needsReason && hosReason.length < 3) return { ok: false, hos: fit.hos.caution.message ?? `${driver.name}'s hours need a look.`, error: "Say why you are putting this driver on it with the hours they have." };
  if (fit.gate) {
    const reason = override?.reason ?? "";
    const valid = (OVERRIDE_REASONS as readonly string[]).includes(reason) && (reason !== "Other" || (override?.notes ?? "").trim().length >= 3);
    if (!valid) return { ok: false, gate: fit.gate, error: reason === "Other" ? "Say what the reason is when you pick Other." : "This one needs a reason before it is booked." };
  }

  // What the quote first said (when it was saved from a quote), so the raise to the booked offer is on the record.
  const prior = quoteId ? await prisma.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(allowed) }, select: { quoteExtras: true, quotedRevenue: true } }) : null;
  // A quote outside the person's limit is not theirs to book, whatever id arrives.
  if (quoteId && !prior) return { ok: false, error: "That quote was already booked or thrown away. Look for it on the board." };
  const firstOffer = prior ? (extrasOf(prior.quoteExtras).firstOffer ?? num(prior.quotedRevenue)) : null;
  const fields = loadFields(input, truck.id, firstOffer);
  // What the load was priced on: the miles the verdict used, so what happens on the road can be compared with it later.
  const channel = input.rateConPath ? "rate_con" : "dispatch";
  const data = { ...fields, vehicleId: truck.id, status: "draft", channel, quotedPickupDhMiles: fields.pickupDeadheadMiles, quotedLoadedMiles: fields.loadedMiles, quotedReturnDhMiles: input.loadBack ? 0 : fields.returnDeadheadMiles };
  const lane = `${cityState(input.stops[0]!.address)} to ${cityState(input.stops[last]!.address)}`;
  let saved: { loadId: string; loadNumber: string | null; same?: true };
  try {
    saved = await prisma.$transaction(async (tx) => {
      // One booking at a time per desk: the checks below and the write are not interleaved with another dispatcher's.
      await lockWorkspace(tx, workspaceId);
      const cust = await resolveOrCreateCustomer(tx, workspaceId, {
        name: input.broker,
        mcNumber: input.brokerMc,
        phone: input.brokerPhone,
        email: input.brokerEmail,
        payTermsDays: input.payTermsDays,
        kind: opts.customerKind ?? null
      });
      // A customer made here is on the trail like one added on the Customers screen.
      if (cust?.created) {
        await recordAudit({ entity: "customer", action: "customer_added", summary: `${cust.name} added as a ${kindLabel(opts.customerKind ?? "broker").toLowerCase()} while booking a quote`, before: null, after: { Name: cust.name, Kind: kindLabel(opts.customerKind ?? "broker"), MC: input.brokerMc ?? null }, at: now, workspaceId }, tx);
      }
      const resolvedData = {
        ...data,
        ...(cust ? { customerId: cust.id, brokerName: cust.name } : {})
      };
      // The broker's load number is the same load as another on the desk with that number from that customer: refuse, rather than book it twice.
      const twin = await findTwinLoad(workspaceId, input.loadNumber, input.broker, quoteId ?? undefined, tx, cust?.id ?? record?.id ?? null, input.rateConNumber);
      if (twin) throw new DispatchError("load_not_assignable", `${duplicateMessage(twin)} Open it, or type another number.`);
      // Booked twice in a moment (a double click, a retry) with nothing to tell the two apart: the load that was just made is the answer, not a second one.
      if (!quoteId && !input.loadNumber) {
        const just = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, vehicleId: truck.id, channel: { in: ["dispatch", "rate_con"] }, status: "draft", createdAt: { gte: new Date(now.getTime() - 30_000) }, scheduledDate: input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null, originAddress: cityState(input.stops[0]!.address) ?? input.stops[0]!.address, destinationAddress: cityState(input.stops[last]!.address) ?? input.stops[last]!.address, quotedRevenue: input.offer } });
        if (just) return { loadId: just.id, loadNumber: just.loadNumber, same: true as const };
      }
      // A truck is on one load at a time.
      const busy = await findTruckClash(truck.id, quoteId ?? "", windowOf(input, truck.id), workspaceId);
      if (busy) throw new DispatchError("load_not_assignable", `${truck.name} is already on ${busy.loadNumber ?? "another load"} (${windowText(busy.window)}). Pick another truck, or move that load first.`);

      let loadId: string;
      let loadNumber: string | null;
      if (quoteId) {
        // Read again under the lock: a quote passed on, changed by someone else, or moved out of reach since the form opened is not booked.
        const fresh = await tx.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null, ...inTerminal(allowed) }, select: { updatedAt: true, decisions: { where: { decisionType: PASSED }, select: { id: true }, take: 1 } } });
        if (!fresh) throw new DispatchError("load_not_found", "That quote was already booked or thrown away. Look for it on the board.");
        if (fresh.decisions.length > 0) throw new DispatchError("load_not_assignable", "That quote was passed on. Start a new quote from it.");
        if (movedSince(fresh.updatedAt, opts.version)) throw new DispatchError("stale", STALE_QUOTE);
        // Booked once: the claim only succeeds while it is still a quote, so a second booking of the same quote (another tab, a retry) finds nothing to claim.
        const claimed = await tx.load.updateMany({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null, decisions: { none: { decisionType: PASSED } } }, data: resolvedData });
        if (claimed.count !== 1) throw new DispatchError("load_not_found", "That quote was already booked or thrown away. Look for it on the board.");
        await tx.stop.deleteMany({ where: { loadId: quoteId } });
        await tx.stop.createMany({ data: stopRows(input).map((st) => ({ ...st, loadId: quoteId })) });
        const l = await tx.load.findUniqueOrThrow({ where: { id: quoteId } });
        loadId = l.id;
        loadNumber = l.loadNumber;
      } else {
        const l = await tx.load.create({ data: { workspaceId, loadNumber: quoteNumber(now), ...resolvedData, stops: { create: stopRows(input) } } });
        loadId = l.id;
        loadNumber = l.loadNumber;
      }
      await tx.loadDecision.create({
        data: { loadId, decisionType: fit.gate ? "overridden" : "accepted", overrideReason: fit.gate ? (override?.reason ?? null) : null, overrideNotes: fit.gate && override?.notes?.trim() ? override.notes.trim() : null, decidedAt: now, decidedBy: currentActor(), decidedById: currentActorId(), details: decisionDetails(input, fit, laneRecord, firstOffer) as unknown as Prisma.InputJsonObject }
      });
      await freezeLoadSnapshot(tx, loadId, { labour: false });
      const fuelNote = input.fuelPrice == null ? "The truck's own" : `$${input.fuelPrice.toFixed(2)} a gallon, ${input.fuelSource === "regional" ? "this week's regional price" : "typed"}`;
      await recordAudit(
        {
          entity: "load",
          action: "booked",
          loadId,
          loadNumber,
          workspaceId,
          summary: `Booked from a quote: ${lane}, $${input.offer.toLocaleString("en-US")} on ${truck.name}${fit.gate ? `, an override (${override!.reason})` : ""}`,
          reason: fit.gate ? [override!.reason, override!.notes.trim()].filter(Boolean).join(": ") : null,
          before: null,
          after: {
            Lane: lane,
            Offer: `$${input.offer.toLocaleString("en-US")}`,
            Truck: truck.name,
            Verdict: fit.decision,
            "Per mile, every mile": fit.allInPerMile == null ? null : `$${fit.allInPerMile.toFixed(2)}`,
            "Fuel priced at": fuelNote,
            "Judged against": input.marketTotal != null ? "The market rate typed" : laneRecord ? `Your ${laneRecord.loads} loads on this lane, $${laneRecord.perMile.toFixed(2)}/mi` : "Cost alone (no market rate, no lane record)",
            ...(authorityText ? { "Customer authority": authorityText } : {})
          },
          at: now
        },
        tx
      );
      return { loadId, loadNumber };
    });
  } catch (e) {
    // A quote that was booked or discarded since the page opened, a clash another dispatcher just made: say so rather than fail.
    if (e instanceof DispatchError) return { ok: false, error: e.message, ...(e.message === STALE_QUOTE ? { stale: true as const } : {}) };
    throw e;
  }
  if (saved.same) return { ok: true, loadId: saved.loadId, loadNumber: saved.loadNumber, assigned: false, note: "This was booked a moment ago; it is the same load." };

  // The stops' coordinates come after the booking has committed, and can fail without undoing it.
  await saveStopCoordinates(saved.loadId);

  // The driver comes last and can fail on its own (a lapsed card, another load at that time) without undoing the booking.
  let assigned = false;
  let note: string | null = [mcNote, authorityNote].filter(Boolean).join(" ") || null;
  if (driver) {
    if (driver.defaultPayKind && driver.defaultPayRate != null) {
      try {
        await assignDriver({ loadId: saved.loadId, driverId: driver.id, pay: { kind: driver.defaultPayKind as PayKind, rate: num(driver.defaultPayRate) }, reasons: hosReason ? { hos_short: hosReason } : undefined, allowed }, now, workspaceId);
        assigned = true;
      } catch (e) {
        note = [mcNote, authorityNote, e instanceof DispatchError ? `Booked, but ${driver.name} could not be assigned: ${e.message}` : `Booked, but ${driver.name} could not be assigned.`].filter(Boolean).join(" ");
      }
    } else {
      note = [mcNote, authorityNote, `Booked. ${driver.name} has no usual pay yet, so assign them from the load.`].filter(Boolean).join(" ");
    }
  }
  return { ok: true, loadId: saved.loadId, loadNumber: saved.loadNumber, assigned, note };
}
