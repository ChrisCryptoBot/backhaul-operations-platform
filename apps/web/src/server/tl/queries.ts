import { prisma } from "@/lib/db";
import { computeAnalytics, type AnalyticsPeriod } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { evaluateTlLoad } from "./evaluate";
import { toAgingView, toAnalyticsInput, num, numOrNull } from "./convert";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * Read model for the dispatcher screens, all computed from the TrueLane-shaped tables with TrueLane's own math.
 * The page layer (stage 3) calls these; nothing here renders anything.
 */
const loadInclude = {
  vehicle: { include: { costProfile: true } },
  stops: { orderBy: { stopSequence: "asc" as const } },
  assignment: { include: { driver: true } }
};

export type BoardRow = Awaited<ReturnType<typeof listBoardRows>>[number];

/** Every live load with its verdict, newest first. The verdict is TrueLane's finalDecision on the truck's own floor. */
export async function listBoardRows(workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.tlLoad.findMany({
    where: { workspaceId, deletedAt: null },
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
      paymentStatus: l.paymentStatus
    };
  });
}

export async function analyticsFor(period: AnalyticsPeriod, now = new Date(), workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.tlLoad.findMany({ where: { workspaceId, deletedAt: null } });
  return computeAnalytics(loads.map(toAnalyticsInput), period, now);
}

export async function agingFor(now = Date.now(), workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.tlLoad.findMany({ where: { workspaceId, deletedAt: null, paymentStatus: "invoiced" } });
  return computeAgingSummary(loads.map(toAgingView), now);
}

// ── Load detail, drivers, trucks, invoices ─────────────────────────────────────────────────────

import { driverBlocker } from "./dispatch";
import { projectLoadToSummary, type LoadSummary, type PayKind } from "./projector";

export async function getLoadDetail(id: string, workspaceId = DEMO_WORKSPACE_ID) {
  const l = await prisma.tlLoad.findFirst({ where: { id, workspaceId, deletedAt: null }, include: loadInclude });
  if (!l) return null;
  const profile = l.vehicle?.costProfile ?? null;
  const evaluation = profile ? evaluateTlLoad(l, profile, l.vehicle) : null;
  // The same offer with the way home flipped: the clip's "what if a load covers the trip back".
  const flipped = profile ? evaluateTlLoad({ ...l, isBackhaul: !l.isBackhaul }, profile, l.vehicle) : null;
  const drivers = await prisma.tlDriver.findMany({ where: { workspaceId, active: true }, orderBy: { name: "asc" } });
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
      { kind: l.assignment.payKind as PayKind, rate: num(l.assignment.payRate) }
    );
  }
  return {
    load: l,
    evaluation,
    flipped,
    driverView,
    drivers: drivers.map((d) => ({ id: d.id, name: d.name, blocker: driverBlocker(d) }))
  };
}

export async function listDrivers(workspaceId = DEMO_WORKSPACE_ID) {
  const drivers = await prisma.tlDriver.findMany({
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
    delivered: d.assignments.filter((a) => a.status === "completed").length
  }));
}

export async function listTrucks(workspaceId = DEMO_WORKSPACE_ID) {
  const trucks = await prisma.tlVehicle.findMany({ where: { workspaceId }, include: { costProfile: true, loads: { where: { deletedAt: null } } }, orderBy: { name: "asc" } });
  return trucks.map((t) => ({
    id: t.id,
    name: t.name,
    type: t.type,
    mpg: numOrNull(t.mpg),
    fuelPrice: numOrNull(t.costProfile?.lastFuelPricePerGallon),
    breakEvenRpm: numOrNull(t.costProfile?.breakEvenRpm),
    survivalFloorRpm: numOrNull(t.costProfile?.survivalFloorRpm),
    monthlyMiles: numOrNull(t.costProfile?.estimatedMonthlyMiles),
    archetype: t.costProfile?.archetype ?? null,
    loads: t.loads.length,
    open: t.loads.filter((l) => ["draft", "accepted", "in_progress"].includes(l.status)).length
  }));
}

export async function listInvoiceRows(workspaceId = DEMO_WORKSPACE_ID) {
  const loads = await prisma.tlLoad.findMany({
    where: { workspaceId, deletedAt: null, status: "completed" },
    orderBy: [{ invoicedAt: "desc" }, { completedAt: "desc" }]
  });
  return loads.map((l) => ({
    id: l.id,
    loadNumber: l.loadNumber,
    broker: l.brokerName,
    lane: `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`,
    completedAt: l.completedAt,
    invoiceNumber: l.invoiceNumber,
    invoicedAt: l.invoicedAt,
    paidAt: l.paidAt,
    payTermsDays: l.payTermsDays,
    status: l.paymentStatus,
    amount: num(l.invoicedAmount ?? l.actualRevenue ?? l.quotedRevenue)
  }));
}
