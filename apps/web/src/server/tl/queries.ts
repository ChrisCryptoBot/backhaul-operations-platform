import { prisma } from "@/lib/db";
import { computeAnalytics, type AnalyticsPeriod } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { evaluateTlLoad } from "./evaluate";
import { toAgingView, toAnalyticsInput, num } from "./convert";
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
