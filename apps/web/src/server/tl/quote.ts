import { Prisma } from "@prisma/client";
import { fuelKindOf } from "@/lib/eia";
import { prisma } from "@/lib/db";
import { driverBlocker } from "@/lib/clearance";
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
import { assignDriver, DispatchError, findDriverClash } from "./dispatch";
import type { PayKind } from "@/lib/pay";
import { saveStopCoordinates } from "@/server/geo/persist";
import { evaluateTlLoad, resolveLabour, type EvaluateLoadRow } from "./evaluate";
import { freezeLoadSnapshot } from "./snapshot";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * The Calculate tab for a dispatcher. An offer is priced with TrueLane's own verdict (evaluateTlLoad) against every truck that has a cost
 * profile, once for each driver who runs it, with that driver's usual pay as the labour, so the question the phone answers for one truck
 * ("does this clear my cost?") is answered for the whole fleet at once. Nothing is written until a quote is saved or booked. A quote is a
 * load with status `quote` (lib/quote-status.ts); booking it makes it a load that needs a driver, writes the decision (accepted, or
 * overridden with the reason given), freezes the truck's floor and dock terms on it, and can put the chosen driver on it.
 */

export type FitDetail = {
  effectiveGross: number;
  surcharge: number;
  /** What the offer plus surcharge would have to be to cover the floor, rounded up to the dollar. */
  payNeeded: number;
  marketVariancePct: number | null;
  marketVarianceDollars: number | null;
  thinMargin: boolean;
  timeTrap: boolean;
  profitPerHour: number | null;
  hourlyTarget: number;
  tripHours: number;
  tripLaborCpm: number;
  fuelPerMile: number | null;
  requiredRests: number;
  elapsedHours: number;
  rejectReason: string | null;
  routeMinimum: { expected: number; meets: boolean } | null;
  floorName: string;
};

export type FitRow = {
  key: string;
  truckId: string;
  truckName: string;
  truckType: string | null;
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
  /** Things to know that do not stop it: equipment the truck is not marked as carrying, oversize freight, hazmat. */
  warnings: string[];
  detail: FitDetail;
};

export type FitResult = { rows: FitRow[]; skipped: Array<{ truck: string; why: string }> };

const D = 86_400_000;

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
    insuranceRiderFlat: null,
    dockWaitMinutes: 0,
    stopsCount: input.stops.length,
    assignment: pay ? { payKind: pay.kind, payRate: pay.rate } : null
  };
}

const windowOf = (input: QuoteInput) => {
  const first = input.stops[0]?.appointment;
  const last = input.stops[input.stops.length - 1]?.appointment;
  if (first == null || last == null) return null;
  return loadWindow([{ timeWindowEarliest: new Date(first), timeWindowLatest: new Date(Math.max(first, last)) }]);
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

function fitFor(input: QuoteInput, truck: TruckForFit, driver: TruckForFit["drivers"][number] | null, blocked: string | null): FitRow | null {
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
  return {
    key: `${truck.id}:${driver?.id ?? "none"}`,
    truckId: truck.id,
    truckName: truck.name ?? "Truck",
    truckType: truck.type,
    driverId: driver?.id ?? null,
    driverName: driver?.name ?? null,
    labourNote: labour.note,
    emptyToPickup,
    totalMiles: e.totalMiles,
    band: e.marketVerdict.band,
    decision: e.finalDecision,
    gate: acceptGateFor({ marketGate: e.marketVerdict.acceptGate, decision: e.finalDecision }),
    allInPerMile: e.result.allInRpm,
    floorPerMile: e.verdictFloorRpm,
    marginPerMile: margin,
    leftOver: margin == null ? null : margin * e.totalMiles,
    blocked: blocked ?? forLoad.blocker,
    warnings: forLoad.warnings,
    detail: {
      effectiveGross: e.effectiveGross,
      surcharge: e.fuelSurchargeDollars,
      payNeeded: e.payNeededRoundedUp,
      marketVariancePct: e.marketVariancePct,
      marketVarianceDollars: e.marketVarianceDollars,
      thinMargin: e.marketVerdict.thinMargin,
      timeTrap: e.marketVerdict.timeTrap,
      profitPerHour: e.profitPerHour,
      hourlyTarget: num(profile.driverHourlyTarget),
      tripHours: e.tripHours,
      tripLaborCpm: e.tripLaborCpm,
      fuelPerMile: e.fuelCost?.fuelCostPerMile ?? null,
      requiredRests: e.hos.requiredRests,
      elapsedHours: e.hos.elapsedHours,
      rejectReason: e.rejectReason,
      routeMinimum: e.routeResult ? { expected: e.routeResult.expectedMinimum, meets: e.routeResult.meetsMinimum } : null,
      floorName: e.verdictFloorName
    }
  };
}

/** The offer priced for each truck and each driver who runs it, best first. A truck with no cost profile has no floor and is listed apart. */
export async function fitQuote(input: QuoteInput, workspaceId = DEMO_WORKSPACE_ID, now = new Date()): Promise<FitResult> {
  const trucks = await prisma.vehicle.findMany({
    where: { workspaceId, archivedAt: null },
    include: { costProfile: true, drivers: { where: { active: true }, orderBy: { name: "asc" } } },
    orderBy: { name: "asc" }
  });
  const win = windowOf(input);
  const rows: FitRow[] = [];
  const skipped: FitResult["skipped"] = [];
  for (const t of trucks) {
    if (!t.costProfile) {
      skipped.push({ truck: t.name ?? "Truck", why: "No cost profile, so no floor to price against." });
      continue;
    }
    const drivers: Array<TruckForFit["drivers"][number] | null> = t.drivers.length > 0 ? t.drivers : [null];
    for (const d of drivers) {
      let blocked: string | null = null;
      if (d) {
        blocked = driverBlocker(d, now);
        if (!blocked) {
          const clash = await findDriverClash(d.id, "", win);
          if (clash) blocked = `Already on ${clash.loadNumber ?? "another load"} at that time`;
        }
      }
      const r = fitFor(input, t, d, blocked);
      if (r) rows.push(r);
    }
  }
  rows.sort((a, b) => (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) || (b.marginPerMile ?? -Infinity) - (a.marginPerMile ?? -Infinity));
  return { rows, skipped };
}

// ── What the desk already knows about this lane and this broker ───────────────────────────────

export type QuoteContext = {
  lane: { from: string; to: string; count: number; averagePerMile: number | null; recent: Array<{ id: string; loadNumber: string | null; on: Date | null; gross: number; perMile: number | null; broker: string | null }> } | null;
  broker: { name: string; loads: number; finished: number; fellThrough: number; averagePerMile: number | null; averageDaysToPay: number | null } | null;
};

const cityOf = (address: string | undefined) => (cityState(address ?? "") ?? "").split(",")[0]!.trim();

export async function quoteContext(input: QuoteInput, workspaceId = DEMO_WORKSPACE_ID): Promise<QuoteContext> {
  const from = cityOf(input.stops[0]?.address);
  const to = cityOf(input.stops[input.stops.length - 1]?.address);
  let lane: QuoteContext["lane"] = null;
  if (from.length >= 2 && to.length >= 2) {
    const where = { workspaceId, deletedAt: null, ...notQuote, status: "completed", originAddress: { contains: from, mode: "insensitive" as const }, destinationAddress: { contains: to, mode: "insensitive" as const } };
    const [count, recent] = await Promise.all([prisma.load.count({ where }), prisma.load.findMany({ where, orderBy: { completedAt: "desc" }, take: 5 })]);
    if (count > 0) {
      const rows = recent.map((l) => {
        const gross = (numOrNull(l.actualRevenue) ?? num(l.quotedRevenue)) + (numOrNull(l.fuelSurcharge) ?? 0);
        const miles = num(l.loadedMiles);
        return { id: l.id, loadNumber: l.loadNumber, on: l.completedAt, gross, perMile: miles > 0 ? gross / miles : null, broker: l.brokerName };
      });
      const rated = rows.filter((r) => r.perMile != null);
      lane = { from: cityState(input.stops[0]!.address) ?? from, to: cityState(input.stops[input.stops.length - 1]!.address) ?? to, count, averagePerMile: rated.length > 0 ? rated.reduce((s, r) => s + r.perMile!, 0) / rated.length : null, recent: rows };
    }
  }
  let broker: QuoteContext["broker"] = null;
  if (input.broker) {
    const theirs = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { equals: input.broker, mode: "insensitive" } } });
    if (theirs.length > 0) {
      const done = theirs.filter((l) => l.status === "completed");
      const rated = done.map((l) => ({ gross: (numOrNull(l.actualRevenue) ?? num(l.quotedRevenue)) + (numOrNull(l.fuelSurcharge) ?? 0), miles: num(l.loadedMiles) })).filter((r) => r.miles > 0);
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
  return { lane, broker };
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

/** The load's own columns for a quote (everything the form holds that a load keeps). */
function loadFields(input: QuoteInput, truckId: string | null) {
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
    isBackhaul: input.loadBack,
    marketBenchmark: input.marketTotal != null && allMiles > 0 ? new Prisma.Decimal(input.marketTotal).div(allMiles).toDecimalPlaces(4) : null,
    payTermsDays: input.payTermsDays,
    factoringFeePct: input.factoringFraction,
    stopsCount: input.stops.length,
    scheduledDate: input.stops[0]?.appointment != null ? new Date(input.stops[0].appointment) : null
  };
}

const quoteNumber = (now: Date) => `QT-${new Prisma.Decimal(now.getTime()).div(1000).toDecimalPlaces(0, Prisma.Decimal.ROUND_DOWN).toNumber().toString(36).toUpperCase()}`;

export type QuoteSave = { ok: true; id: string } | { ok: false; errors?: QuoteErrors; error?: string };

/** Save the form as a quote (or update the one it came from). It is not a load anyone can see on the board until it is booked. */
export async function saveQuote(values: QuoteValues, quoteId: string | null, vehicleId: string | null, workspaceId = DEMO_WORKSPACE_ID, now = new Date()): Promise<QuoteSave> {
  const check = validateQuote(values);
  if (!check.ok) return { ok: false, errors: check.errors };
  const input = check.input;
  const truck = vehicleId ? await prisma.vehicle.findFirst({ where: { id: vehicleId, workspaceId, archivedAt: null } }) : null;
  const data = { ...loadFields(input, truck?.id ?? null), vehicleId: truck?.id ?? null };
  if (quoteId) {
    const existing = await prisma.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null } });
    if (!existing) return { ok: false, error: "That quote is gone." };
    await prisma.$transaction(async (tx) => {
      await tx.stop.deleteMany({ where: { loadId: quoteId } });
      await tx.load.update({ where: { id: quoteId }, data: { ...data, stops: { create: stopRows(input) } } });
    });
    return { ok: true, id: quoteId };
  }
  const created = await prisma.load.create({ data: { workspaceId, status: QUOTE_STATUS, channel: "quote", loadNumber: quoteNumber(now), ...data, stops: { create: stopRows(input) } } });
  return { ok: true, id: created.id };
}

/** The brokers the desk has loads with, for the form's suggestions. */
export async function brokerNames(workspaceId = DEMO_WORKSPACE_ID): Promise<string[]> {
  const rows = await prisma.load.groupBy({ by: ["brokerName"], where: { workspaceId, deletedAt: null, ...notQuote, brokerName: { not: null } }, orderBy: { brokerName: "asc" } });
  return rows.map((r) => r.brokerName).filter((b): b is string => !!b);
}

export type QuoteListRow = { id: string; lane: string; broker: string | null; offer: number; loadedMiles: number; savedAt: Date; truck: string | null; /** Why it was passed on, or null while it is still open. */ passedFor: string | null };

export async function listQuotes(workspaceId = DEMO_WORKSPACE_ID): Promise<QuoteListRow[]> {
  const rows = await prisma.load.findMany({ where: { workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { vehicle: true, decisions: { orderBy: { decidedAt: "desc" }, take: 1 } }, orderBy: { updatedAt: "desc" }, take: 12 });
  return rows.map((l) => ({
    id: l.id,
    lane: `${cityState(l.originAddress) ?? "?"} to ${cityState(l.destinationAddress) ?? "?"}`,
    broker: l.brokerName,
    offer: num(l.quotedRevenue),
    loadedMiles: num(l.loadedMiles),
    savedAt: l.updatedAt,
    truck: l.vehicle?.name ?? null,
    passedFor: l.decisions[0]?.decisionType === PASSED ? (l.decisions[0].overrideReason ?? "Passed") : null
  }));
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
  const stops = [...l.stops].sort((a, b) => a.stopSequence - b.stopSequence);
  return {
    stops: stops.map((s) => ({ role: s.stopRole === "delivery" ? "delivery" : "pickup", address: s.addressString, appointment: s.timeWindowEarliest ? toCentralLocal(s.timeWindowEarliest.getTime()) : "" })),
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
    marketRate: bench != null && allMiles > 0 ? dec(bench * allMiles, 0) : "",
    loadedMiles: dec(loaded),
    emptyToPickup: num(l.pickupDeadheadMiles) > 0 ? dec(num(l.pickupDeadheadMiles)) : "",
    emptyHome: num(l.returnDeadheadMiles) > 0 ? dec(num(l.returnDeadheadMiles)) : "",
    loadBack: l.isBackhaul,
    payTermsDays: l.payTermsDays == null ? "" : String(l.payTermsDays),
    factoringPct: factoring != null && factoring > 0 ? dec(factoring * 100) : "",
    emptyByTruck: {},
    emptyHomeByTruck: {},
    loadedHours: l.estimatedLoadedHours == null ? "" : dec(num(l.estimatedLoadedHours), 2),
    // A fuel price is typed for one price check and is not kept: a reopened quote prices with each truck's own.
    fuelPrice: ""
  };
}

/** A saved quote as the form's values, to reopen it. */
export async function getQuote(id: string, workspaceId = DEMO_WORKSPACE_ID): Promise<{ values: QuoteValues; vehicleId: string | null } | null> {
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l) return null;
  return { vehicleId: l.vehicleId, values: quoteValuesFromLoad(l) };
}

/**
 * "Quote like this": any load (booked, finished or a saved quote) as the start of a new quote. The lane, broker, trailer, size and miles carry over;
 * the load number, PO and both times do not, because they belong to that one load. Nothing is written until the new quote is saved or booked.
 */
export async function getQuoteLike(id: string, workspaceId = DEMO_WORKSPACE_ID): Promise<QuoteValues | null> {
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null }, include: { stops: { orderBy: { stopSequence: "asc" } } } });
  if (!l || l.stops.length < 2) return null;
  const v = quoteValuesFromLoad(l);
  return { ...v, loadNumber: "", poNumber: "", stops: v.stops.map((st) => ({ ...st, appointment: "" })) };
}

// -- Passing on a quote ---------------------------------------------------------------------------

/** A pass is a decision on the quote; the quote stays a quote, so it stays out of every list of loads. */
export const PASSED = "passed";

export async function passQuote(id: string, reason: string, notes: string, workspaceId = DEMO_WORKSPACE_ID, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!(PASS_REASONS as readonly string[]).includes(reason)) return { ok: false, error: "Pick a reason." };
  if (reason === "Other" && notes.trim().length < 3) return { ok: false, error: "Say what the reason is when you pick Other." };
  const l = await prisma.load.findFirst({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, include: { decisions: { orderBy: { decidedAt: "desc" }, take: 1 } } });
  if (!l) return { ok: false, error: "That quote is gone." };
  if (l.decisions[0]?.decisionType === PASSED) return { ok: false, error: "That quote was already passed on." };
  const lane = `${cityState(l.originAddress) ?? "?"} to ${cityState(l.destinationAddress) ?? "?"}`;
  await prisma.$transaction(async (tx) => {
    await tx.loadDecision.create({ data: { loadId: id, decisionType: PASSED, overrideReason: reason, overrideNotes: notes.trim() || null, decidedAt: now } });
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

export async function discardQuote(id: string, workspaceId = DEMO_WORKSPACE_ID, now = new Date()): Promise<boolean> {
  const out = await prisma.load.updateMany({ where: { id, workspaceId, status: QUOTE_STATUS, deletedAt: null }, data: { deletedAt: now } });
  return out.count > 0;
}

// ── Booking ───────────────────────────────────────────────────────────────────────────────────

export type BookResult =
  | { ok: true; loadId: string; loadNumber: string | null; assigned: boolean; note: string | null }
  | { ok: false; errors?: QuoteErrors; error?: string; gate?: AcceptGate };

export type Override = { reason: string; notes: string };

/**
 * Book a quote on a truck, and optionally with its driver. The verdict is worked out again here, never taken from the browser: a load that
 * needs a reason (below its cost, no fuel price, below the market, no market rate) is refused without one, and the reason is kept with the
 * decision. Both ends need a time, because the desk cannot yet edit a stop and a load with no times cannot be planned or chased.
 */
export async function bookQuote(
  values: QuoteValues,
  pick: { vehicleId: string; driverId: string | null },
  override: Override | null,
  quoteId: string | null,
  workspaceId = DEMO_WORKSPACE_ID,
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
  const driver = pick.driverId ? await prisma.driver.findFirst({ where: { id: pick.driverId, workspaceId, active: true } }) : null;
  if (pick.driverId && !driver) return { ok: false, error: "That driver is not available." };

  const fit = fitFor(input, { ...truck, drivers: driver ? [driver] : [] } as TruckForFit, driver, null)!;
  const forLoad = truckFit(input.specs, truckLimits(truck));
  if (forLoad.blocker) return { ok: false, error: `${truck.name} cannot take this load. ${forLoad.blocker}` };
  if (fit.gate) {
    const reason = override?.reason ?? "";
    const valid = (OVERRIDE_REASONS as readonly string[]).includes(reason) && (reason !== "Other" || (override?.notes ?? "").trim().length >= 3);
    if (!valid) return { ok: false, gate: fit.gate, error: reason === "Other" ? "Say what the reason is when you pick Other." : "This one needs a reason before it is booked." };
  }

  const data = { ...loadFields(input, truck.id), vehicleId: truck.id, status: "draft", channel: "dispatch" };
  const lane = `${cityState(input.stops[0]!.address)} to ${cityState(input.stops[last]!.address)}`;
  let saved: { loadId: string; loadNumber: string | null };
  try {
    saved = await prisma.$transaction(async (tx) => {
    let loadId: string;
    let loadNumber: string | null;
    if (quoteId) {
      const existing = await tx.load.findFirst({ where: { id: quoteId, workspaceId, status: QUOTE_STATUS, deletedAt: null } });
      if (!existing) throw new DispatchError("load_not_found", "That quote is gone.");
      await tx.stop.deleteMany({ where: { loadId: quoteId } });
      const l = await tx.load.update({ where: { id: quoteId }, data: { ...data, stops: { create: stopRows(input) } } });
      loadId = l.id;
      loadNumber = l.loadNumber;
    } else {
      const l = await tx.load.create({ data: { workspaceId, loadNumber: quoteNumber(now), ...data, stops: { create: stopRows(input) } } });
      loadId = l.id;
      loadNumber = l.loadNumber;
    }
    await tx.loadDecision.create({
      data: { loadId, decisionType: fit.gate ? "overridden" : "accepted", overrideReason: fit.gate ? (override?.reason ?? null) : null, overrideNotes: fit.gate && override?.notes?.trim() ? override.notes.trim() : null, decidedAt: now }
    });
    await freezeLoadSnapshot(tx, loadId, { labour: false });
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
        after: { Lane: lane, Offer: `$${input.offer.toLocaleString("en-US")}`, Truck: truck.name, Verdict: fit.decision, "Per mile, every mile": fit.allInPerMile == null ? null : `$${fit.allInPerMile.toFixed(2)}` },
        at: now
      },
      tx
    );
    return { loadId, loadNumber };
    });
  } catch (e) {
    // A quote that was booked or discarded since the page opened: say so rather than fail.
    if (e instanceof DispatchError) return { ok: false, error: e.message };
    throw e;
  }

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
