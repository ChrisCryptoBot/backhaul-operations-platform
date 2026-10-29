import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { defaultInvoiceNumber, invoiceReadiness } from "@/lib/invoicing";
import { computeAnalytics, type AnalyticsPeriod } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { evaluateTlLoad, resolveLabour } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { toAgingView, toAnalyticsInput, num, numOrNull } from "./convert";
import { detentionOfLoad } from "./detention";
import { getThresholds } from "./thresholds";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Read model for the dispatcher screens, all computed from the TrueLane-shaped tables with TrueLane's own math.
 * The page layer (stage 3) calls these; nothing here renders anything.
 */
export const loadInclude = {
  vehicle: { include: { costProfile: true } },
  stops: { orderBy: { stopSequence: "asc" as const } },
  assignment: { include: { driver: true } }
};

export type BoardRow = Awaited<ReturnType<typeof listBoardRows>>[number];

/** Every live load with its verdict, newest first. The verdict is TrueLane's finalDecision on the truck's own floor. */
export async function listBoardRows(workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null, ...notQuote },
    include: loadInclude,
    orderBy: [{ scheduledDate: "desc" }, { createdAt: "desc" }]
  });
  return loads.map((l) => {
    const profile = l.vehicle?.costProfile ?? null;
    const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      status: l.status,
      brokerName: l.brokerName,
      origin: l.originAddress,
      destination: l.destinationAddress,
      scheduledDate: l.scheduledDate,
      vehicleName: l.vehicle?.name ?? null,
      quotedRevenue: num(l.quotedRevenue),
      totalMiles: evaluation?.totalMiles ?? null,
      verdict: evaluation?.finalDecision ?? null,
      perMile: evaluation && evaluation.totalMiles > 0 ? evaluation.effectiveGross / evaluation.totalMiles : null,
      floorPerMile: evaluation?.verdictFloorRpm ?? null,
      driverName: l.assignment?.driver.name ?? null,
      assignmentStatus: l.assignment?.status ?? null,
      paymentStatus: l.paymentStatus,
      poNumber: l.poNumber,
      invoiceNumber: l.invoiceNumber,
      brokerMc: l.brokerMcNumber,
      completedAt: l.completedAt,
      cancelledAt: l.cancelledAt,
      cancelReason: l.cancelReason,
      invoicedAt: l.invoicedAt,
      payTermsDays: l.payTermsDays,
      paidAt: l.paidAt,
      invoicedAmount: numOrNull(l.invoicedAmount),
      paidAmount: numOrNull(l.paidAmount)
    };
  });
}

export async function analyticsFor(period: AnalyticsPeriod, now = new Date(), workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote } });
  return computeAnalytics(loads.map(toAnalyticsInput), period, now);
}

export async function agingFor(now = Date.now(), workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.load.findMany({ where: { workspaceId, deletedAt: null, ...notQuote, paymentStatus: "invoiced" } });
  return computeAgingSummary(loads.map(toAgingView), now);
}

// ── Load detail, drivers, trucks, invoices ─────────────────────────────────────────────────────

import { driverBlocker, driverClashNote } from "./dispatch";
import { rateConTotal } from "@/lib/pay";
import { driverFacingPay, projectLoadToSummary, type LoadSummary, type PayKind } from "./projector";

export async function getLoadDetail(id: string, workspaceId = DEMO_WORKSPACE_ID) {
  // The decision is read here only (the board shares loadInclude and does not need it): how the quote became this load.
  const l = await prisma.load.findFirst({ where: { id, workspaceId, deletedAt: null, ...notQuote }, include: { ...loadInclude, decisions: { orderBy: { decidedAt: "desc" as const }, take: 1 } } });
  if (!l) return null;
  const profile = l.vehicle?.costProfile ?? null;
  const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
  // The same offer with the way home flipped: the clip's "what if a load covers the trip back".
  const flipped = profile ? evaluateTlLoad({ ...l, isBackhaul: !l.isBackhaul }, profile, l.vehicle) : null;
  const drivers = await prisma.driver.findMany({ where: { workspaceId, active: true }, orderBy: { name: "asc" } });
  const fleet = await prisma.vehicle.findMany({ where: { workspaceId, archivedAt: null }, include: { costProfile: { select: { id: true } } }, orderBy: { name: "asc" } });
  let driverView: LoadSummary | null = null;
  if (l.assignment) {
    driverView = projectLoadToSummary(
      {
        loadNumber: l.loadNumber,
        poNumber: l.poNumber,
        brokerName: l.brokerName,
        trailerType: l.trailerType,
        originAddress: l.originAddress,
        destinationAddress: l.destinationAddress,
        loadedMiles: num(l.loadedMiles),
        stops: l.stops.map((s) => ({
          stopSequence: s.stopSequence,
          stopType: s.stopType,
          stopRole: s.stopRole,
          addressString: s.addressString,
          timeWindowEarliest: s.timeWindowEarliest,
          timeWindowLatest: s.timeWindowLatest,
          referenceNumbers: s.referenceNumbers,
          stopNotes: s.stopNotes
        }))
      },
      driverFacingPay({ kind: l.assignment.payKind as PayKind, rate: num(l.assignment.payRate) }, rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge)))
    );
  }
  return {
    load: l,
    evaluation,
    flipped,
    /** Where the driver pay in the verdict came from (this assignment, or the truck's profile), in a sentence. */
    labourNote: profile && evaluation ? resolveLabour(profile, l.assignment, evaluation.totalMiles, rateConTotal(num(l.quotedRevenue), num(l.fuelSurcharge))).note : null,
    driverView,
    /** The trucks a load can be moved to. A truck with no cost profile has no floor to judge the load against. */
    trucks: fleet.map((t) => ({ id: t.id, name: t.name ?? "Unnamed truck", ready: t.costProfile != null })),
    // Who can take this load: a lapsed card blocks outright; being on another load at the same time is a note the dispatcher can override with a reason.
    drivers: await Promise.all(drivers.map(async (d) => ({ id: d.id, name: d.name, blocker: driverBlocker(d), busy: await driverClashNote(d.id, l.id, l.stops), payKind: d.defaultPayKind, payRate: numOrNull(d.defaultPayRate) })))
  };
}

export async function listDrivers(workspaceId = DEMO_WORKSPACE_ID) {
  const drivers = await prisma.driver.findMany({
    where: { workspaceId },
    include: { assignedVehicle: true, assignments: { include: { load: true }, orderBy: { updatedAt: "desc" } } },
    orderBy: { name: "asc" }
  });
  return drivers.map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    email: d.email,
    cdlClass: d.cdlClass,
    cdlExpiry: d.cdlExpiry,
    medicalCardExpiry: d.medicalCardExpiry,
    blocker: driverBlocker(d),
    truck: d.assignedVehicle?.name ?? null,
    active: d.active,
    current: d.assignments.filter((a) => ["dispatched", "accepted", "in_progress"].includes(a.status)).map((a) => ({ loadId: a.loadId, loadNumber: a.load.loadNumber, status: a.status })),
    delivered: d.assignments.filter((a) => a.status === "completed").length,
    truckId: d.assignedVehicleId,
    payKind: d.defaultPayKind,
    payRate: numOrNull(d.defaultPayRate),
    /** Open loads this driver holds (assigned, sent, accepted or on the road): what stops them being taken out of service. */
    openLoadNumbers: d.assignments.filter((a) => ["draft", "dispatched", "accepted", "in_progress"].includes(a.status) && ["draft", "accepted", "in_progress"].includes(a.load.status)).map((a) => a.load.loadNumber ?? "a load")
  }));
}

export async function listTrucks(workspaceId = DEMO_WORKSPACE_ID) {
  const trucks = await prisma.vehicle.findMany({ where: { workspaceId }, include: { costProfile: true, loads: { where: { deletedAt: null, ...notQuote } } }, orderBy: { name: "asc" } });
  return trucks.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    make: t.make,
    model: t.model,
    year: t.year,
    mpg: numOrNull(t.mpg),
    fuelPrice: numOrNull(t.costProfile?.lastFuelPricePerGallon),
    breakEvenRpm: numOrNull(t.costProfile?.breakEvenRpm),
    survivalFloorRpm: numOrNull(t.costProfile?.survivalFloorRpm),
    monthlyMiles: numOrNull(t.costProfile?.estimatedMonthlyMiles),
    archetype: t.costProfile?.archetype ?? null,
    archived: t.archivedAt != null,
    homeBase: t.homeBaseAddress,
    fuelType: t.fuelType,
    detentionRate: numOrNull(t.costProfile?.detentionHourlyRate),
    loads: t.loads.length,
    open: t.loads.filter((l) => ["draft", "accepted", "in_progress"].includes(l.status)).length
  }));
}

export async function listInvoiceRows(workspaceId = DEMO_WORKSPACE_ID) {
  const [loads, thresholds] = await Promise.all([
    prisma.load.findMany({
      where: { workspaceId, deletedAt: null, status: "completed" },
      include: { stops: true, vehicle: { include: { costProfile: true } } },
      orderBy: [{ invoicedAt: "desc" }, { completedAt: "desc" }]
    }),
    getThresholds(workspaceId)
  ]);
  return loads.map((l) => {
    const rate = num(l.quotedRevenue);
    const billable = detentionOfLoad(l, thresholds.detentionGraceMinutes).billable;
    const billed = num(l.invoicedAmount ?? l.actualRevenue ?? l.quotedRevenue);
    const paidAmount = numOrNull(l.paidAmount);
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      poNumber: l.poNumber,
      broker: l.brokerName,
      origin: l.originAddress,
      destination: l.destinationAddress,
      lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
      completedAt: l.completedAt,
      invoiceNumber: l.invoiceNumber,
      invoicedAt: l.invoicedAt,
      paidAt: l.paidAt,
      payTermsDays: l.payTermsDays,
      status: l.paymentStatus,
      amount: billed,
      paidAmount,
      /** Negative when the broker paid less than the invoice. */
      paidDifference: l.paymentStatus === "paid" && paidAmount != null ? new Prisma.Decimal(paidAmount).minus(billed).toDecimalPlaces(2).toNumber() : null,
      invoiceContext: { rate, surcharge: num(l.fuelSurcharge), detention: billable, defaultTerms: l.payTermsDays ?? thresholds.defaultPayTermsDays },
      defaultNumber: defaultInvoiceNumber(l.loadNumber, l.id),
      readiness: invoiceReadiness({ ...l, quotedRevenue: rate })
    };
  });
}
