import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeAnalytics, isRevenueLoad, type AnalyticsPeriod, type AnalyticsResult } from "@/truelane/lib/analytics";
import { computeAgingSummary, invoiceBilledTotal, agingDueAtMs, type AgingSummary } from "@/truelane/lib/invoice";
import { deadheadMilesOf, deadheadPct, drivenMiles, loadCompletedAtMs, loadGross, revenueMiles } from "@/truelane/lib/domain/loadEconomics";
import { calendarDaysBetween } from "@/truelane/lib/domain/calendarDays";
import { evaluateTlLoad } from "./evaluate";
import { ms, num, numOrNull, toAgingView, toAnalyticsInput, type LoadRow } from "./convert";
import { DEMO_WORKSPACE_ID } from "./workspace";
import type { Verdict } from "@/lib/desk-format";

/**
 * The KPI dashboard's numbers, computed from the TrueLane-shaped tables with TrueLane's own functions
 * (analytics, load economics, invoice aging). `buildDeskKpi` is pure so it can be tested with plain rows.
 */
export type KpiLoadRow = LoadRow & {
  id: string;
  loadNumber: string | null;
  createdAt: Date;
  scheduledDate: Date | null;
  /** Verdict on the truck's own floor, for loads that are not finished yet. */
  verdict: Verdict | null;
  assignment: { driverName: string; payKind: string; payEstimate: number | null; status: string } | null;
};

export type DriverKpi = { name: string; loads: number; gross: number; rpm: number | null; payOwed: number };
export type OutstandingInvoice = { id: string; loadNumber: string | null; broker: string | null; billed: number; dueAt: number | null; daysPastDue: number | null };

export type DeskKpi = {
  period: AnalyticsPeriod;
  analytics: AnalyticsResult;
  /** Revenue per week for the last 12 weeks, oldest first. */
  weekly: Array<{ label: string; value: number }>;
  /** Empty miles as a share of every mile driven, 0 to 1, over the finished loads in the period. */
  deadheadShare: number | null;
  pipeline: { needsDriver: number; sent: number; onTheRoad: number };
  verdictMix: Record<Verdict, number>;
  aging: AgingSummary;
  outstanding: OutstandingInvoice[];
  drivers: DriverKpi[];
};

const WEEK = 7 * 86_400_000;

function inPeriod(t: number, period: AnalyticsPeriod, now: Date): boolean {
  if (period === "all") return true;
  const d = new Date(t);
  if (period === "ytd") return d.getFullYear() === now.getFullYear();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export function buildDeskKpi(rows: KpiLoadRow[], period: AnalyticsPeriod, now: Date = new Date()): DeskKpi {
  const analytics = computeAnalytics(rows.map(toAnalyticsInput), period, now);

  const money = (l: KpiLoadRow) => ({
    status: l.status,
    quotedRevenue: num(l.quotedRevenue),
    actualRevenue: numOrNull(l.actualRevenue),
    fuelSurcharge: numOrNull(l.fuelSurcharge),
    layoverPay: numOrNull(l.layoverPay),
    tonuRevenue: numOrNull(l.tonuRevenue)
  });
  const milesIn = (l: KpiLoadRow) => ({
    status: l.status,
    isBackhaul: l.isBackhaul,
    pickupDeadheadMiles: num(l.pickupDeadheadMiles),
    loadedMiles: num(l.loadedMiles),
    returnDeadheadMiles: num(l.returnDeadheadMiles),
    quotedPickupDhMiles: numOrNull(l.quotedPickupDhMiles),
    quotedLoadedMiles: numOrNull(l.quotedLoadedMiles),
    quotedReturnDhMiles: numOrNull(l.quotedReturnDhMiles)
  });
  const doneAt = (l: KpiLoadRow) =>
    loadCompletedAtMs({ status: l.status, completedAt: ms(l.completedAt), cancelledAt: ms(l.cancelledAt), updatedAt: l.updatedAt, scheduledDate: ms(l.scheduledDate), createdAt: l.createdAt });

  const finished = rows.filter((l) => isRevenueLoad(l));
  const scoped = finished.filter((l) => inPeriod(doneAt(l), period, now));

  const nowMs = now.getTime();
  const weekly = Array.from({ length: 12 }, (_, i) => {
    const end = nowMs - (11 - i) * WEEK;
    const start = end - WEEK;
    const value = finished.filter((l) => {
      const t = doneAt(l);
      return t > start && t <= end;
    }).reduce((s, l) => s + loadGross(money(l)), 0);
    const label = new Date(end).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    return { label, value: new Prisma.Decimal(value).toDecimalPlaces(0).toNumber() };
  });

  const dh = deadheadPct(scoped.map((l) => ({ drivenMiles: drivenMiles(milesIn(l)), deadheadMiles: deadheadMilesOf(milesIn(l)) })));

  const open = rows.filter((l) => l.status === "draft" || l.status === "accepted" || l.status === "in_progress");
  const pipeline = {
    needsDriver: rows.filter((l) => l.status === "draft" && (!l.assignment || l.assignment.status === "draft")).length,
    sent: rows.filter((l) => l.assignment?.status === "dispatched").length,
    onTheRoad: rows.filter((l) => l.status === "in_progress" || l.assignment?.status === "in_progress").length
  };
  const verdictMix: Record<Verdict, number> = { accept: 0, caution: 0, reject: 0, needs_fuel: 0 };
  for (const l of open) if (l.verdict) verdictMix[l.verdict] += 1;

  const invoiced = rows.filter((l) => l.paymentStatus === "invoiced");
  const aging = computeAgingSummary(invoiced.map(toAgingView), nowMs);
  const outstanding: OutstandingInvoice[] = invoiced
    .map((l) => {
      const view = toAgingView(l);
      const due = agingDueAtMs(view.invoicedAt, view.payTermsDays);
      return {
        id: l.id,
        loadNumber: l.loadNumber,
        broker: l.brokerName,
        billed: invoiceBilledTotal(view),
        dueAt: due,
        daysPastDue: due == null ? null : calendarDaysBetween(due, nowMs)
      };
    })
    .sort((a, b) => (b.daysPastDue ?? -Infinity) - (a.daysPastDue ?? -Infinity));

  const byDriver = new Map<string, { loads: KpiLoadRow[]; owed: number }>();
  for (const l of scoped) {
    if (!l.assignment) continue;
    const e = byDriver.get(l.assignment.driverName) ?? { loads: [], owed: 0 };
    e.loads.push(l);
    e.owed += l.assignment.payEstimate ?? 0;
    byDriver.set(l.assignment.driverName, e);
  }
  const drivers: DriverKpi[] = [...byDriver.entries()]
    .map(([name, e]) => {
      const gross = e.loads.reduce((s, l) => s + loadGross(money(l)), 0);
      const mi = e.loads.reduce((s, l) => s + revenueMiles(milesIn(l)), 0);
      return { name, loads: e.loads.length, gross, rpm: mi > 0 ? gross / mi : null, payOwed: new Prisma.Decimal(e.owed).toDecimalPlaces(2).toNumber() };
    })
    .sort((a, b) => b.gross - a.gross);

  return { period, analytics, weekly, deadheadShare: dh == null ? null : dh / 100, pipeline, verdictMix, aging, outstanding, drivers };
}

export async function getDeskKpi(period: AnalyticsPeriod, now = new Date(), workspaceId = DEMO_WORKSPACE_ID): Promise<DeskKpi> {
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null },
    include: { vehicle: { include: { costProfile: true } }, assignment: { include: { driver: true } } }
  });
  const rows: KpiLoadRow[] = loads.map((l) => {
    const profile = l.vehicle?.costProfile ?? null;
    const open = l.status === "draft" || l.status === "accepted" || l.status === "in_progress";
    return {
      ...l,
      verdict: open && profile ? evaluateTlLoad(l, profile, l.vehicle).finalDecision : null,
      assignment: l.assignment
        ? { driverName: l.assignment.driver.name, payKind: l.assignment.payKind, payEstimate: numOrNull(l.assignment.payEstimate), status: l.assignment.status }
        : null
    };
  });
  return buildDeskKpi(rows, period, now);
}
