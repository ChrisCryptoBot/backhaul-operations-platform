import { prisma } from "@/lib/db";
import { computeAnalytics } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { deadheadMilesOf, deadheadPct, drivenMiles } from "@/truelane/lib/domain/loadEconomics";
import { isRevenueLoad } from "@/truelane/lib/analytics";
import { num, numOrNull, toAgingView, toAnalyticsInput, type LoadRow } from "./convert";
import { getAlerts } from "./alerts";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * What the shell shows on every screen: live counts on the sidebar and the totals strip in the header.
 * `buildShellData` is pure so it can be tested with plain rows; `getShellData` reads the database.
 */
export type ShellRow = LoadRow & { assignment: { status: string } | null };

export type ShellData = {
  counts: { needsDriver: number; sentWaiting: number; onTheRoad: number; readyToInvoice: number; overdue: number; alertsBlock: number; alertsWarn: number };
  totals: { open: number; needsDriver: number; gross: number; avgRpm: number | null; emptyShare: number | null };
};

export function buildShellData(rows: ShellRow[], now: number = Date.now(), alertCounts: { block: number; warn: number } = { block: 0, warn: 0 }): ShellData {
  const open = rows.filter((l) => l.status === "draft" || l.status === "accepted" || l.status === "in_progress");
  const needsDriver = rows.filter((l) => l.status === "draft" && (!l.assignment || l.assignment.status === "draft" || l.assignment.status === "declined")).length;
  const sentWaiting = rows.filter((l) => l.assignment?.status === "dispatched").length;
  const onTheRoad = rows.filter((l) => l.status === "in_progress").length;
  const readyToInvoice = rows.filter((l) => l.status === "completed" && !l.paymentStatus).length;
  const invoiced = rows.filter((l) => l.paymentStatus === "invoiced");
  const overdue = computeAgingSummary(invoiced.map(toAgingView), now).overdueCount;

  const analytics = computeAnalytics(rows.map(toAnalyticsInput), "all", new Date(now));
  const finished = rows.filter((l) => isRevenueLoad(l));
  const milesIn = (l: ShellRow) => ({
    status: l.status,
    isBackhaul: l.isBackhaul,
    pickupDeadheadMiles: num(l.pickupDeadheadMiles),
    loadedMiles: num(l.loadedMiles),
    returnDeadheadMiles: num(l.returnDeadheadMiles),
    quotedPickupDhMiles: numOrNull(l.quotedPickupDhMiles),
    quotedLoadedMiles: numOrNull(l.quotedLoadedMiles),
    quotedReturnDhMiles: numOrNull(l.quotedReturnDhMiles)
  });
  const dh = deadheadPct(finished.map((l) => ({ drivenMiles: drivenMiles(milesIn(l)), deadheadMiles: deadheadMilesOf(milesIn(l)) })));

  return {
    counts: { needsDriver, sentWaiting, onTheRoad, readyToInvoice, overdue, alertsBlock: alertCounts.block, alertsWarn: alertCounts.warn },
    totals: { open: open.length, needsDriver, gross: analytics.summary.grossRevenue, avgRpm: analytics.summary.avgRpm, emptyShare: dh == null ? null : dh / 100 }
  };
}

export async function getShellData(workspaceId = DEMO_WORKSPACE_ID): Promise<ShellData> {
  const [loads, alerts] = await Promise.all([
    prisma.load.findMany({ where: { workspaceId, deletedAt: null }, include: { assignment: { select: { status: true } } } }),
    getAlerts(new Date(), workspaceId)
  ]);
  return buildShellData(loads, Date.now(), alerts.counts);
}
