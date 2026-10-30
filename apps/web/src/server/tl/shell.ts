import { notQuote } from "@/lib/quote-status";
import { prisma } from "@/lib/db";
import { computeAnalytics } from "@/truelane/lib/analytics";
import { computeAgingSummary } from "@/truelane/lib/invoice";
import { deadheadMilesOf, deadheadPct, drivenMiles } from "@/truelane/lib/domain/loadEconomics";
import { isRevenueLoad } from "@/truelane/lib/analytics";
import { num, numOrNull, toAgingView, toAnalyticsInput, type LoadRow } from "./convert";
import { getAlerts } from "./alerts";
import { finishedTotals } from "./finished-totals";
import { currentTerminal, listTerminals } from "./terminal";
import { agingSummary } from "./aging";
import { currentWorkspaceId } from "./workspace";
import { unreadMessageCount } from "./messages";

/**
 * What the shell shows on every screen: live counts on the sidebar and the totals strip in the header.
 * `buildShellData` is pure so it can be tested with plain rows; `getShellData` reads the database.
 */
export type ShellRow = LoadRow & { assignment: { status: string } | null };

export type ShellData = {
  counts: { needsDriver: number; sentWaiting: number; onTheRoad: number; readyToInvoice: number; overdue: number; alertsBlock: number; alertsWarn: number; unreadMessages: number };
  totals: { open: number; needsDriver: number; gross: number; avgRpm: number | null; emptyShare: number | null };
  /** The terminals trucks and drivers are assigned to, and the one the header is scoped to (null = all). The counts above are the whole fleet's. */
  terminals: string[];
  terminal: string | null;
  /** The workspace's name, for the account block at the foot of the sidebar. */
  workspaceName: string;
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
    counts: { needsDriver, sentWaiting, onTheRoad, readyToInvoice, overdue, alertsBlock: alertCounts.block, alertsWarn: alertCounts.warn, unreadMessages: 0 },
    totals: { open: open.length, needsDriver, gross: analytics.summary.grossRevenue, avgRpm: analytics.summary.avgRpm, emptyShare: dh == null ? null : dh / 100 },
    terminals: [],
    terminal: null,
    workspaceName: ""
  };
}

const OPEN = ["draft", "accepted", "in_progress"];

/**
 * The header and sidebar numbers, as aggregate queries: counts are counted by the database, the overdue figure reads only the invoices still out, the three
 * finished-load totals are kept until a finished load changes (finished-totals.ts), and the alert counts read only the loads that can raise a counted alert.
 * No screen reads every load to draw the shell.
 */
export async function getShellData(workspaceId = currentWorkspaceId()): Promise<ShellData> {
  const now = Date.now();
  const base = { workspaceId, deletedAt: null };
  const [open, needsDriver, sentWaiting, onTheRoad, readyToInvoice, owed, alerts, totals, terminals, unreadMessages, workspace] = await Promise.all([
    prisma.load.count({ where: { ...base, status: { in: OPEN } } }),
    prisma.load.count({ where: { ...base, status: "draft", OR: [{ assignment: null }, { assignment: { status: { in: ["draft", "declined"] } } }] } }),
    prisma.load.count({ where: { ...base, ...notQuote, assignment: { status: "dispatched" } } }),
    prisma.load.count({ where: { ...base, status: "in_progress" } }),
    prisma.load.count({ where: { ...base, status: "completed", paymentStatus: null } }),
    agingSummary(now, workspaceId),
    getAlerts(new Date(now), workspaceId, "shell"),
    finishedTotals(workspaceId, new Date(now)),
    listTerminals(workspaceId),
    unreadMessageCount(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { name: true } })
  ]);
  const terminal = await currentTerminal(workspaceId);
  const overdue = owed.overdueCount;
  return {
    counts: { needsDriver, sentWaiting, onTheRoad, readyToInvoice, overdue, alertsBlock: alerts.counts.block, alertsWarn: alerts.counts.warn, unreadMessages },
    totals: { open, needsDriver, gross: totals.gross, avgRpm: totals.avgRpm, emptyShare: totals.emptyShare },
    terminals,
    terminal,
    workspaceName: workspace?.name ?? ""
  };
}
