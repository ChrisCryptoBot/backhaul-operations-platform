import { summarizeCustomerPay, type CustomerSlowPay } from "@/lib/customer-pay";
import type { OpenPickupCandidate } from "@/lib/backhaul-detect";
import { Prisma, type Load } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { fuelKindOf } from "@/lib/eia";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
import { truckBodyNote } from "@/lib/load-fit";
import { truckFit, type TruckLimits } from "@/lib/load-fit";
import { missingTimes, OVERRIDE_REASONS, PASS_REASONS, surchargeDollars, validateQuote, type QuoteErrors, type QuoteInput, type QuoteValues } from "@/lib/quote";
import { notQuote, QUOTE_STATUS } from "@/lib/quote-status";
import { loadWindow } from "@/lib/schedule";
import { toCentralLocal } from "@/lib/zoned";
import { acceptGateFor } from "@/truelane/lib/calculate/acceptGate";
import type { AcceptGate, MarketBand } from "@/truelane/lib/domain/marketVerdict";
import { fuelSurchargePercentFromDollars, fuelSurchargePerMileFromDollars } from "@/truelane/lib/fuelSurcharge";
import { cityState } from "@/lib/city-state";
import { recordAudit } from "./audit";
import { num, numOrNull } from "./convert";
import { assignDriver, DispatchError, driverClashesIn, findTruckClash, truckClashesIn, windowText } from "./dispatch";
import { duplicateMessage, findTwinLoad } from "./twins";
import type { PayKind } from "@/lib/pay";
import { saveStopCoordinates } from "@/server/geo/persist";
import { evaluateTlLoad, resolveLabour, type EvaluateLoadRow } from "./evaluate";
import { computeSettlement } from "@/truelane/lib/domain/calculators";
import { freezeLoadSnapshot } from "./snapshot";
import { currentWorkspaceId } from "./workspace";
import { lockWorkspace } from "./plan";
import { currentTerminal } from "./terminal";
import { currentActor } from "./identity";
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
  /** Whose pay is in the verdict, in a sentence. */
  labourNote: string;
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
  /** The hours the truck's driver has left on the clock as the ELD last said (null when no ELD is linked), when that was, and how the trip compares. A caution only: nothing in the verdict reads it. */
  hos: { availableHours: number | null; syncedAt: string | null; caution: HosCaution };
  /** When the driver works, and a caution when the typed appointments fall outside it. Beside the hours-left note; nothing in the verdict, the ranking or booking reads it. */
  shift?: QuoteShift;
  detail: FitDetail;
};

/** `rows` are the best ways to run it (at most MAX_FIT_ROWS); `total` is how many there are in all. */
/** `trailersAvailable`: trailers of the kind the offer needs (any kind when none is stated) that are in service, available, with no date lapsed and not on an open load; null when the desk keeps no trailers. */
/** `lane`: the desk's own record, when it stood in for a market rate nobody typed. */
export type FitResult = { rows: FitRow[]; total: number; skipped: Array<{ truck: string; why: string }>; trailersAvailable: number | null; lane: LaneBenchmark | null };
export const MAX_FIT_ROWS = 50;

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
const windowOf = (input: QuoteInput) => {
  const first = input.stops[0]?.appointment;
  const last = input.stops[input.stops.length - 1]?.appointment;
  if (first == null || last == null) return null;
  const driveMs = (input.loadedHours ?? input.loadedMiles / 50) * HOUR;
  return loadWindow([{ timeWindowEarliest: new Date(first - (input.emptyToPickup / 50) * HOUR), timeWindowLatest: new Date(Math.max(last, first + driveMs)) }]);
};

type TruckForFit = Prisma.VehicleGetPayload<{ include: { costProfile: true; drivers: true } }>;

/** What a truck holds and carries, as the load check reads it. */
export const truckLimits = (t: { payloadLbs: number | null; maxLengthFt: Prisma.Decimal | null; maxWidthFt: Prisma.Decimal | null; maxHeightIn: Prisma.Decimal | null; hasLiftgate: boolean; hasRamp: boolean; hasPalletJack: boolean }): TruckLimits => ({
  payloadLbs: t.payloadLbs,
  maxLengthFt: numOrNull(t.maxLengthFt),
  maxWidthFt: numOrNull(t.maxWidthFt),
  maxHeightIn: numOrNull(t.maxHeightIn),
  hasLiftgate: t.hasLiftgate,
  hasRamp: t.hasRamp,
  hasPalletJack: t.hasPalletJack
});

function fitFor(input: QuoteInput, truck: TruckForFit, driver: TruckForFit["drivers"][number] | null, blocked: string | null, shift: QuoteShift = NO_QUOTE_SHIFT): FitRow | null {
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
  // Hours left on the clock are a note beside the verdict, never an input to it (the vendored rules and the verdict are untouched).
  const available = numOrNull(truck.hosAvailableHours);
  // The ELD's hours left are as of now: they say something about a pickup in the next day, and nothing about one next week.
  const pickupAt = input.stops[0]?.appointment ?? null;
  const soon = pickupAt == null || pickupAt - Date.now() < 24 * 3_600_000;
  const hos = { availableHours: available, syncedAt: truck.hosSyncedAt ? truck.hosSyncedAt.toISOString() : null, caution: soon ? hosCaution(e.tripHours, available) : hosCaution(null, null) };
  const body = truckBodyNote(input.trailer, truck.type, truck.name ?? "Truck");
  return {
    key: `${truck.id}:${driver?.id ?? "none"}`,
    truckId: truck.id,
    truckName: truck.name ?? "Truck",
    driverId: driver?.id ?? null,
    driverName: driver?.name ?? null,
    labourNote: labour.note,
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
    warnings: [...forLoad.warnings, ...(body ? [body] : []), ...(hos.caution.message ? [hos.caution.message] : [])],
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

/** The offer priced for each truck and each driver who runs it, best first. A truck with no cost profile has no floor and is listed apart. */
/** `terminal`: price only that terminal's trucks (the dispatcher's slice); null prices the whole fleet. */
export async function fitQuote(input: QuoteInput, workspaceId = currentWorkspaceId(), now = new Date(), terminal: string | null = null): Promise<FitResult> {
  const lane = await laneBenchmark(input, workspaceId, now);
  const judged = judgedBy(input, lane);
  const trucks = await prisma.vehicle.findMany({
    where: { workspaceId, archivedAt: null, ...(terminal ? { terminal } : {}) },
    include: { costProfile: true, drivers: { where: { active: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" }
  });
  const win = windowOf(input);
  const rows: FitRow[] = [];
  const skipped: FitResult["skipped"] = [];
  // Who is already on another load at that time, for every driver at once (one query), not one query per driver.
  const clashes = await driverClashesIn(trucks.flatMap((t) => t.drivers.map((d) => d.id)), "", win);
  const truckClashes = await truckClashesIn(trucks.map((t) => t.id), "", win, workspaceId);
  // A card that lapses before the pickup is as good as lapsed for this load.
  const pickupAt = input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null;
  // Each driver's shift on the carrier's clock, from one batched read (a caution beside the hours-left one).
  const tz = await workspaceTimezone(workspaceId);
  const times = input.stops.map((s) => s.appointment).filter((t): t is number => t != null);
  const anchor = times.length > 0 ? times : [now.getTime()];
  const schedules = await loadSchedules(workspaceId, trucks.flatMap((t) => t.drivers.map((d) => d.id)), dateKeyOf(Math.min(...anchor), tz), dateKeyOf(Math.max(...anchor), tz));
  const shiftOf = (driverId: string | undefined) => (driverId ? quoteShift(schedules.get(driverId) ?? null, input.stops, now.getTime(), tz) : NO_QUOTE_SHIFT);
  for (const t of trucks) {
    if (!t.costProfile) {
      skipped.push({ truck: t.name ?? "Truck", why: "No cost profile, so no floor to price against." });
      continue;
    }
    const drivers: Array<TruckForFit["drivers"][number] | null> = t.drivers.length > 0 ? t.drivers : [null];
    const truckBusy = truckClashes.has(t.id) ? `${t.name ?? "The truck"} is already on ${truckClashes.get(t.id) ?? "another load"} at that time` : null;
    let driversAllBlocked = t.drivers.length > 0;
    for (const d of drivers) {
      let blocked: string | null = truckBusy;
      let ownBlock: string | null = null;
      if (d) {
        ownBlock = driverBlocker(d, now) ?? (pickupAt ? (driverBlocker(d, pickupAt) ? `${driverBlocker(d, pickupAt)!.replace(/ expired$/, "")} expires before the pickup` : null) : null);
        if (!ownBlock && clashes.has(d.id)) ownBlock = `Already on ${clashes.get(d.id) ?? "another load"} at that time`;
        blocked = blocked ?? ownBlock;
      }
      if (!ownBlock) driversAllBlocked = false;
      const r = fitFor(judged, t, d, blocked, shiftOf(d?.id));
      if (r) rows.push(r);
    }
    // Every driver of this truck is out (a lapsed card, another load): the truck can still be booked now and a driver put on it from the load.
    if (driversAllBlocked) {
      const r = fitFor(judged, t, null, truckBusy);
      if (r) {
        r.warnings = [`No driver of ${t.name ?? "this truck"} can take it at that time. Book the truck and assign a driver from the load.`, ...r.warnings];
        rows.push(r);
      }
    }
  }
  rows.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || (b.marginPerMile ?? -Infinity) - (a.marginPerMile ?? -Infinity));
  const kept = await prisma.trailer.count({ where: { workspaceId, archivedAt: null } });
  const trailersAvailable = kept === 0 ? null : await countTrailersAvailable(input.trailer, terminal, now, workspaceId);
  return { rows: rows.slice(0, MAX_FIT_ROWS), total: rows.length, skipped, trailersAvailable, lane };
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

export async function quoteContext(input: QuoteInput, workspaceId = currentWorkspaceId()): Promise<QuoteContext> {
  const from = cityStateOf(input.stops[0]?.address);
  const to = cityStateOf(input.stops[input.stops.length - 1]?.address);
  let lane: QuoteContext["lane"] = null;
  if (from.length >= 2 && to.length >= 2) {
    const where = laneWhere(from, to, workspaceId);
    const [count, recent] = await Promise.all([prisma.load.count({ where }), prisma.load.findMany({ where, orderBy: { completedAt: "desc" }, take: LANE_SAMPLE })]);
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
    const theirs = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { equals: input.broker, mode: "insensitive" } }, orderBy: { createdAt: "desc" }, take: BROKER_SAMPLE });
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
  const passedWhere = { workspaceId, status: QUOTE_STATUS, deletedAt: null, decisions: { some: { decisionType: PASSED } } };
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
    stopType: s.role,
    stopRole: s.role,
    addressString: s.address,
    timeWindowEarliest: s.appointment != null ? new Date(s.appointment) : null,
    timeWindowLatest: s.appointment != null ? new Date(s.appointment) : null,
    referenceNumbers: [] as string[]
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
    originAddress: cityState(input.stops[0]!.address) ?? input.stops[0]!.address,
    destinationAddress: cityState(input.stops[input.stops.length - 1]!.address) ?? input.stops[input.stops.length - 1]!.address,
    trailerType: input.trailer,
    weightLbs: input.specs.weightLbs,
    lengthFt: input.specs.lengthFt,
    widthFt: input.specs.widthFt,
    loadHeightIn: input.specs.heightIn,
    hazmatClass: input.specs.hazmatClass,
    requiresLiftgate: input.specs.requiresLiftgate || null,
    requiresRamp: input.specs.requiresRamp || null,
    requiresPalletJack: input.specs.requiresPalletJack || null,
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

export type QuoteSave = { ok: true; id: string } | { ok: false; errors?: QuoteErrors; error?: string };

/** Save the form as a quote (or update the one it came from). It is not a load anyone can see on the board until it is booked. */
export async function saveQuote(values: QuoteValues, quoteId: string | null, vehicleId: string | null, workspaceId = currentWorkspaceId(), now = new Date()): Promise<QuoteSave> {
  const check = validateQuote(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const input = check.input;
  const truck = vehicleId ? await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId, archivedAt: null } }) : null;
  const data = { ...loadFields(input, truck?.id ?? null, input.offer), vehicleId: truck?.id ?? null };
  if (quoteId) {
    const existing = await prisma.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
    if (!existing) return { ok: false, error: "That quote is gone." };
    // A quote that was passed on stays as it was said: start a new one from it ("Quote like this") rather than rewrite it.
    if (existing.decisions[0]?.decisionType === PASSED) return { ok: false, error: "That quote was passed on. Start a new quote from it instead." };
    // A typed load number that has since been cleared goes back to the desk's own number.
    // The first offer stays what it was when the quote was first saved.
    const firstOffer = extrasOf(existing.quoteExtras).firstOffer ?? num(existing.quotedRevenue);
    const keep = { quoteExtras: { ...quoteExtrasOf(input), firstOffer } };
    const number = !input.loadNumber && existing.loadNumber && !/^QT-/.test(existing.loadNumber) ? { loadNumber: quoteNumber(now) } : {};
    const saved = await prisma.$transaction(async (tx) => {
      // Only while it is still a quote: a booking that got there first is not overwritten.
      const claimed = await tx.load.updateMany({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, data: { ...data, ...keep, ...number } });
      if (claimed.count !== 1) return false;
      await tx.stop.deleteMany({ where: { loadId: quoteId } });
      await tx.stop.createMany({ data: stopRows(input).map((s) => ({ ...s, loadId: quoteId })) });
      await recordAudit({ entity: "load", entityId: quoteId, action: "quote_saved", loadId: null, loadNumber: existing.loadNumber, workspaceId, summary: `Quote updated: ${quoteLane(input)}, $${input.offer.toLocaleString("en-US")}`, before: null, after: null, at: now }, tx);
      return true;
    });
    if (!saved) return { ok: false, error: "That quote was booked or thrown away while you were editing it." };
    return { ok: true, id: quoteId };
  }
  const created = await prisma.$transaction(async (tx) => {
    const l = await tx.load.create({ data: { workspaceId, status: QUOTE_STATUS, channel: "quote", loadNumber: quoteNumber(now), ...data, stops: { create: stopRows(input) } } });
    await recordAudit({ entity: "load", entityId: l.id, action: "quote_saved", loadId: null, loadNumber: l.loadNumber, workspaceId, summary: `Quote saved: ${quoteLane(input)}, $${input.offer.toLocaleString("en-US")}${input.broker ? ` for ${input.broker}` : ""}`, before: null, after: null, at: now }, tx);
    return l;
  });
  return { ok: true, id: created.id };
}

/** A customer the desk keeps a record of, as the quote form fills from it. */
export type CustomerOption = { name: string; mc: string | null; phone: string | null; email: string | null; payTermsDays: number | null; slowPay?: CustomerSlowPay | null };

/**
 * The form's suggestions for the customer box: every customer record, then any name only the loads carry (a spelling that differs only in capitals is one customer, and the record's
 * spelling wins). Computes customer payment performance (days to pay, overdue invoices) to surface slow-pay warnings.
 */
export async function brokerNames(workspaceId = currentWorkspaceId()): Promise<CustomerOption[]> {
  const [records, rows, invoicedLoads] = await Promise.all([
    prisma.customer.findMany({ where: { workspaceId }, orderBy: { name: "asc" }, take: 2000 }),
    prisma.load.groupBy({ by: ["brokerName"], where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { not: null } }, orderBy: { brokerName: "asc" } }),
    prisma.load.findMany({
      where: {
        workspaceId,
        deletedAt: null,
        ...notQuote,
        brokerName: { not: null },
        invoicedAt: { not: null }
      },
      select: {
        brokerName: true,
        paymentStatus: true,
        invoicedAt: true,
        paidAt: true,
        invoicedAmount: true,
        payTermsDays: true
      },
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
export async function listOpenPickups(workspaceId = currentWorkspaceId()): Promise<OpenPickupCandidate[]> {
  const loads = await prisma.load.findMany({
    where: {
      workspaceId,
      deletedAt: null,
      status: "draft"
    },
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

export type QuoteListRow = { id: string; lane: string; broker: string | null; offer: number; loadedMiles: number; savedAt: Date; truck: string | null; /** Why it was passed on, or null while it is still open. */ passedFor: string | null };
export type QuoteListFilter = { q?: string; status?: "open" | "passed" | "all"; offset?: number };
export const QUOTE_PAGE = 20;

/** Saved quotes, newest first, a page at a time. `q` matches the lane, the customer, the load number or the truck; `status` keeps open ones, passed ones, or both. */
export async function listQuotes(workspaceId = currentWorkspaceId(), filter: QuoteListFilter = {}): Promise<{ rows: QuoteListRow[]; total: number }> {
  const q = (filter.q ?? "").trim();
  const words = q.split(/\s+/).filter(Boolean).slice(0, 5);
  const where: Prisma.LoadWhereInput = {
    workspaceId,
    status: QUOTE_STATUS,
    deletedAt: null,
    AND: [
      ...words.map((w) => ({ OR: [{ originAddress: { contains: w, mode: "insensitive" as const } }, { destinationAddress: { contains: w, mode: "insensitive" as const } }, { brokerName: { contains: w, mode: "insensitive" as const } }, { loadNumber: { contains: w, mode: "insensitive" as const } }, { vehicle: { name: { contains: w, mode: "insensitive" as const } } }] })),
      ...(filter.status === "passed" ? [{ decisions: { some: { decisionType: PASSED } } }] : filter.status === "open" ? [{ decisions: { none: { decisionType: PASSED } } }] : [])
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
      passedFor: l.decisions[0]?.decisionType === PASSED ? (l.decisions[0].overrideReason ?? "Passed") : null
    }))
  };
}

type LoadWithStops = Prisma.LoadGetPayload<{ include: { stops: true } }>;

/** A load as the form's values. The surcharge goes back to the unit it was typed in, as the phone does. */
export function quoteValuesFromLoad(l: LoadWithStops): QuoteValues {
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
    stops: stops.map((s) => ({ role: (s.stopRole ?? s.stopType) === "delivery" ? "delivery" : "pickup", address: s.addressString, appointment: s.timeWindowEarliest ? toCentralLocal(s.timeWindowEarliest.getTime()) : "" })),
    broker: l.brokerName ?? "",
    brokerMc: l.brokerMcNumber ?? "",
    // A QT- number is the desk's own, not the broker's: it is not offered back as one to type over.
    loadNumber: l.loadNumber && !/^QT-/.test(l.loadNumber) ? l.loadNumber : "",
    poNumber: l.poNumber ?? "",
    brokerPhone: l.brokerPhone ?? "",
    brokerEmail: l.brokerEmail ?? "",
    trailer: l.trailerType ?? "",
    weightLbs: l.weightLbs == null ? "" : String(l.weightLbs),
    lengthFt: dec(numOrNull(l.lengthFt), 2),
    widthFt: dec(numOrNull(l.widthFt), 2),
    heightIn: dec(numOrNull(l.loadHeightIn), 2),
    hazmatClass: l.hazmatClass ?? "",
    requiresLiftgate: l.requiresLiftgate === true,
    requiresRamp: l.requiresRamp === true,
    requiresPalletJack: l.requiresPalletJack === true,
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
export async function getQuote(id: string, workspaceId = currentWorkspaceId()): Promise<{ values: QuoteValues; vehicleId: string | null; passedFor: string | null } | null> {
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } }, decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (!l) return null;
  const passed = l.decisions[0]?.decisionType === PASSED ? (l.decisions[0].overrideReason ?? "Passed") : null;
  return { vehicleId: l.vehicleId, values: quoteValuesFromLoad(l), passedFor: passed };
}

/**
 * "Quote like this": any load (booked, finished or a saved quote) as the start of a new quote. The lane, broker, trailer, size and miles carry over;
 * the load number, PO and both times do not, because they belong to that one load. Nothing is written until the new quote is saved or booked.
 */
export async function getQuoteLike(id: string, workspaceId = currentWorkspaceId()): Promise<QuoteValues | null> {
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l || l.stops.length < 2) return null;
  const v = quoteValuesFromLoad(l);
  return { ...v, loadNumber: "", poNumber: "", stops: v.stops.map((st) => ({ ...st, appointment: "" })) };
}

// -- Passing on a quote ---------------------------------------------------------------------------

/** A pass is a decision on the quote; the quote stays a quote, so it stays out of every list of loads. */
export const PASSED = "passed";

export async function passQuote(id: string, reason: string, notes: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(PASS_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "Pick a reason." };
  if (reason === "Other" && notes.trim().length < 3) return { ok: false, error: "Say what the reason is when you pick Other." };
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 }, stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l) return { ok: false, error: "That quote is gone." };
  if (l.decisions[0]?.decisionType === PASSED) return { ok: false, error: "That quote was already passed on." };
  // What it was worth when it was passed on: priced again as it stands, for the record. Never stops the pass.
  let details: DecisionDetails | null = null;
  try {
    const check = validateQuote(quoteValuesFromLoad(l));
    if (check.ok) {
      const [fit, laneRecord] = await Promise.all([fitQuote(check.input, workspaceId, now), laneBenchmark(check.input, workspaceId, now)]);
      const row = fit.rows.find((r) => r.truckId === l.vehicleId && !r.blocked) ?? fit.rows.find((r) => !r.blocked) ?? fit.rows[0] ?? null;
      details = decisionDetails(check.input, row, laneRecord, extrasOf(l.quoteExtras).firstOffer ?? num(l.quotedRevenue));
    }
  } catch {
    details = null;
  }
  const lane = `${cityState(l.originAddress) ?? "?"} to ${cityState(l.destinationAddress) ?? "?"}`;
  await prisma.$transaction(async (tx) => {
    await tx.loadDecision.create({ data: { loadId: id, decisionType: PASSED, overrideReason: reason, overrideNotes: notes.trim() || null, decidedAt: now, decidedBy: currentActor(), ...(details ? { details: details as unknown as Prisma.InputJsonObject } : {}) } });
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
  });
  return { ok: true };
}

/** Throw a saved quote away. It is written to the audit trail (a quote was priced for a customer; its being thrown away is part of that customer's record). */
export async function discardQuote(id: string, workspaceId = currentWorkspaceId(), now = new Date()): Promise<boolean> {
  const q = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null } });
  if (!q) return false;
  const lane = `${cityState(q.originAddress) ?? "?"} to ${cityState(q.destinationAddress) ?? "?"}`;
  return prisma.$transaction(async (tx) => {
    const out = await tx.load.updateMany({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, data: { deletedAt: now } });
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
  | { ok: false; errors?: QuoteErrors; error?: string; gate?: AcceptGate };

export type Override = { reason: string; notes: string };

/**
 * Book a quote on a truck, and optionally with its driver. The verdict is worked out again here, never taken from the browser: a load that
 * needs a reason (below its cost, no fuel price, well under the market or its own lane) is refused without one, and the reason is kept with the
 * decision. Both ends need a time, because the desk cannot yet edit a stop and a load with no times cannot be planned or chased.
 */
export async function bookQuote(
  values: QuoteValues,
  pick: { vehicleId: string; driverId: string | null },
  override: Override | null,
  quoteId: string | null,
  workspaceId = currentWorkspaceId(),
  now = new Date()
): Promise<BookResult> {
  const check = validateQuote(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const input = check.input;
  const last = input.stops.length - 1;
  const missing = missingTimes(input.stops);
  if (Object.keys(missing).length > 0) return { ok: false, errors: missing };

  const truck = await prisma.vehicle.findFirst({ where: { id: pick.vehicleId, workspaceId, archivedAt: null }, include: { costProfile: true, drivers: { where: { active: true } } } });
  if (!truck) return { ok: false, error: "That truck is not available." };
  if (!truck.costProfile) return { ok: false, error: `${truck.name} has no cost profile yet. Set it up on the truck's page, then book.` };
  // The truck is in the terminal being worked, and the driver runs that truck: the browser's word is not taken for either.
  const terminal = await currentTerminal(workspaceId);
  if (terminal && truck.terminal !== terminal) return { ok: false, error: `${truck.name} is outside the ${terminal} terminal you are working in. Switch terminals, or pick a truck from this one.` };
  const driver = pick.driverId ? (truck.drivers.find((d) => d.id === pick.driverId) ?? null) : null;
  if (pick.driverId && !driver) return { ok: false, error: "That driver is not available on this truck." };

  // The customer record, when there is one: the load carries its spelling, and an MC typed against a different one is refused (a name used with someone else's authority is the double-brokering trap).
  const record = await customerNamed(input.broker, workspaceId);
  if (record?.mcNumber && input.brokerMc && record.mcNumber.replace(/\D/g, "") !== input.brokerMc.replace(/\D/g, "")) {
    const msg = `${record.name} is on your customers with MC ${record.mcNumber}, not MC ${input.brokerMc}. Check who this load is really from before you book it.`;
    return { ok: false, errors: { brokerMc: msg }, error: msg };
  }
  if (record) input.broker = record.name;

  const laneRecord = await laneBenchmark(input, workspaceId, now);
  const fit = fitFor(judgedBy(input, laneRecord), { ...truck, drivers: driver ? [driver] : [] } as TruckForFit, driver, null)!;
  const forLoad = truckFit(input.specs, truckLimits(truck));
  if (forLoad.blocker) return { ok: false, error: `${truck.name} cannot take this load. ${forLoad.blocker}` };
  if (fit.gate) {
    const reason = override?.reason ?? "";
    const valid = (OVERRIDE_REASONS as readonly string[]).includes(reason) && (reason !== "Other" || (override?.notes ?? "").trim().length >= 3);
    if (!valid) return { ok: false, gate: fit.gate, error: reason === "Other" ? "Say what the reason is when you pick Other." : "This one needs a reason before it is booked." };
  }

  // What the quote first said (when it was saved from a quote), so the raise to the booked offer is on the record.
  const prior = quoteId ? await prisma.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, select: { quoteExtras: true, quotedRevenue: true } }) : null;
  const firstOffer = prior ? (extrasOf(prior.quoteExtras).firstOffer ?? num(prior.quotedRevenue)) : null;
  const fields = loadFields(input, truck.id, firstOffer);
  // What the load was priced on: the miles the verdict used, so what happens on the road can be compared with it later.
  const data = { ...fields, vehicleId: truck.id, status: "draft", channel: "dispatch", quotedPickupDhMiles: fields.pickupDeadheadMiles, quotedLoadedMiles: fields.loadedMiles, quotedReturnDhMiles: input.loadBack ? 0 : fields.returnDeadheadMiles };
  const lane = `${cityState(input.stops[0]!.address)} to ${cityState(input.stops[last]!.address)}`;
  let saved: { loadId: string; loadNumber: string | null; same?: true };
  try {
    saved = await prisma.$transaction(async (tx) => {
      // One booking at a time per desk: the checks below and the write are not interleaved with another dispatcher's.
      await lockWorkspace(tx, workspaceId);
      // The broker's load number is the same load as another on the desk with that number from that customer: refuse, rather than book it twice.
      const twin = await findTwinLoad(workspaceId, input.loadNumber, input.broker, quoteId ?? undefined);
      if (twin) throw new DispatchError("load_not_assignable", `${duplicateMessage(twin)} Open it, or type another number.`);
      // Booked twice in a moment (a double click, a retry) with nothing to tell the two apart: the load that was just made is the answer, not a second one.
      if (!quoteId && !input.loadNumber) {
        const just = await prisma.load.findFirst({ where: { workspaceId, deletedAt: null, vehicleId: truck.id, channel: "dispatch", status: "draft", createdAt: { gte: new Date(now.getTime() - 30_000) }, scheduledDate: input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null, originAddress: cityState(input.stops[0]!.address) ?? input.stops[0]!.address, destinationAddress: cityState(input.stops[last]!.address) ?? input.stops[last]!.address, quotedRevenue: input.offer } });
        if (just) return { loadId: just.id, loadNumber: just.loadNumber, same: true as const };
      }
      // A truck is on one load at a time.
      const busy = await findTruckClash(truck.id, quoteId ?? "", windowOf(input), workspaceId);
      if (busy) throw new DispatchError("load_not_assignable", `${truck.name} is already on ${busy.loadNumber ?? "another load"} (${windowText(busy.window)}). Pick another truck, or move that load first.`);

      let loadId: string;
      let loadNumber: string | null;
      if (quoteId) {
        // Booked once: the claim only succeeds while it is still a quote, so a second booking of the same quote (another tab, a retry) finds nothing to claim.
        const claimed = await tx.load.updateMany({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null }, data });
        if (claimed.count !== 1) throw new DispatchError("load_not_found", "That quote was already booked or thrown away. Look for it on the board.");
        await tx.stop.deleteMany({ where: { loadId: quoteId } });
        await tx.stop.createMany({ data: stopRows(input).map((st) => ({ ...st, loadId: quoteId })) });
        const l = await tx.load.findUniqueOrThrow({ where: { id: quoteId } });
        loadId = l.id;
        loadNumber = l.loadNumber;
      } else {
        const l = await tx.load.create({ data: { workspaceId, loadNumber: quoteNumber(now), ...data, stops: { create: stopRows(input) } } });
        loadId = l.id;
        loadNumber = l.loadNumber;
      }
      await tx.loadDecision.create({
        data: { loadId, decisionType: fit.gate ? "overridden" : "accepted", overrideReason: fit.gate ? (override?.reason ?? null) : null, overrideNotes: fit.gate && override?.notes?.trim() ? override.notes.trim() : null, decidedAt: now, decidedBy: currentActor(), details: decisionDetails(input, fit, laneRecord, firstOffer) as unknown as Prisma.InputJsonObject }
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
            "Judged against": input.marketTotal != null ? "The market rate typed" : laneRecord ? `Your ${laneRecord.loads} loads on this lane, $${laneRecord.perMile.toFixed(2)}/mi` : "Cost alone (no market rate, no lane record)"
          },
          at: now
        },
        tx
      );
      return { loadId, loadNumber };
    });
  } catch (e) {
    // A quote that was booked or discarded since the page opened, a clash another dispatcher just made: say so rather than fail.
    if (e instanceof DispatchError) return { ok: false, error: e.message };
    throw e;
  }
  if (saved.same) return { ok: true, loadId: saved.loadId, loadNumber: saved.loadNumber, assigned: false, note: "This was booked a moment ago; it is the same load." };

  // The stops' coordinates come after the booking has committed, and can fail without undoing it.
  await saveStopCoordinates(saved.loadId);

  // The driver comes last and can fail on its own (a lapsed card, another load at that time) without undoing the booking.
  let assigned = false;
  let note: string | null = null;
  if (driver) {
    if (driver.defaultPayKind && driver.defaultPayRate != null) {
      try {
        await assignDriver({ loadId: saved.loadId, driverId: driver.id, pay: { kind: driver.defaultPayKind as PayKind, rate: num(driver.defaultPayRate) } }, now);
        assigned = true;
      } catch (e) {
        note = e instanceof DispatchError ? `Booked, but ${driver.name} could not be assigned: ${e.message}` : `Booked, but ${driver.name} could not be assigned.`;
      }
    } else {
      note = `Booked. ${driver.name} has no usual pay yet, so assign them from the load.`;
    }
  }
  return { ok: true, loadId: saved.loadId, loadNumber: saved.loadNumber, assigned, note };
}
