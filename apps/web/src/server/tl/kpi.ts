import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeAnalytics, isRevenueLoad, type AnalyticsResult } from "@/truelane/lib/analytics";
import { computeAgingSummary, invoiceBilledTotal, agingDueAtMs, type AgingSummary } from "@/truelane/lib/invoice";
import { deadheadMilesOf, deadheadPct, drivenMiles, loadCompletedAtMs, loadGross, revenueMiles } from "@/truelane/lib/domain/loadEconomics";
import { effectiveMiles } from "@/truelane/lib/domain/quotedMiles";
import { loadMarketVariance } from "@/truelane/lib/domain/marketVariance";
import { calendarDaysBetween } from "@/truelane/lib/domain/calendarDays";
import { DAY_MS, inWindow, periodWindow, previousWindow, weekBuckets, type KpiPeriod, type TimeWindow } from "@/lib/kpi-periods";
import type { KpiFilters } from "@/lib/kpi-params";
import { THRESHOLD_DEFAULTS, type Thresholds } from "@/lib/thresholds";
import type { Verdict } from "@/lib/desk-format";
import { evaluateTlLoad } from "./evaluate";
import { ms, num, numOrNull, toAgingView, toAnalyticsInput, toMarketVarianceLoad, type LoadRow } from "./convert";
import { getThresholds } from "./thresholds";
import { DEMO_WORKSPACE_ID } from "./workspace";

/**
 * The KPI dashboard's numbers, computed from the TrueLane-shaped tables with TrueLane's own functions (analytics, load
 * economics, market variance, invoice aging). Finished loads are turned into one "fact" each, and every number on the page is a
 * sum or a ratio of sums over the facts in a window (never an average of per-load percentages). `buildDeskKpi` is pure so it can
 * be tested with plain rows.
 */
export type KpiLoadRow = LoadRow & {
  id: string;
  loadNumber: string | null;
  createdAt: Date;
  scheduledDate: Date | null;
  paidAt: Date | null;
  /** The truck's break-even floor ($/mi, before fuel) frozen when the load was accepted. */
  snapshotBaseFloorRpm: Prisma.Decimal | number | string | null;
  vehicleName: string | null;
  /** Verdict on the truck's own floor, for loads that are not finished yet. */
  verdict: Verdict | null;
  stops: Array<{ waitMinutes: number | null }>;
  assignment: { driverName: string; payKind: string; payEstimate: number | null; status: string } | null;
};

export type { KpiFilters };
export type KpiOptions = { period: KpiPeriod; compare: boolean; filters: KpiFilters };

export type PeriodStats = {
  loads: number;
  gross: number;
  expenses: number;
  /** Gross minus the tracked fuel, tolls and other expenses. */
  netEstimate: number;
  /** Gross per revenue mile (TrueLane's "avg $/revenue mile"). */
  rpm: number | null;
  totalMiles: number;
  /** Empty miles as a share of every mile driven, 0 to 1. */
  emptyShare: number | null;
  emptyMiles: number;
  /** Share of finished loads whose pay, after tracked fuel and tolls, still covered the floor frozen at accept. */
  clearedFloor: number | null;
  judgedLoads: number;
  /** Share of paid invoices paid within their terms. */
  paidWithinTerms: number | null;
  paidLoads: number;
  avgDaysToPay: number | null;
  /** Average recorded wait at a stop, minutes. */
  avgWaitMinutes: number | null;
  waitStops: number;
};

export type DriverKpi = { name: string; loads: number; gross: number; rpm: number | null; payOwed: number; drivenMiles: number; emptyMiles: number; emptyShare: number | null };
export type LaneStatus = "above" | "below" | "unknown";
export type LaneKpi = {
  key: string;
  label: string;
  loads: number;
  gross: number;
  rpm: number | null;
  emptyShare: number | null;
  /** Average empty miles before the pickup and after the delivery, per load. */
  avgPickupEmpty: number;
  avgReturnEmpty: number;
  /** Loads on this lane that carry a market rate, and how far above (+) or below (-) it they paid, as a fraction. */
  benchmarked: number;
  marketVariancePct: number | null;
  status: LaneStatus;
};
export type TrendWeek = {
  label: string;
  end: number;
  gross: number;
  loads: number;
  rpm: number | null;
  emptyShare: number | null;
  /** The sums behind the ratios, so any run of weeks can be combined as a ratio of sums. */
  revenueMiles: number;
  drivenMiles: number;
  emptyMiles: number;
};
export type OutstandingInvoice = { id: string; loadNumber: string | null; broker: string | null; billed: number; dueAt: number | null; daysPastDue: number | null };

export type DeskKpi = {
  period: KpiPeriod;
  compare: boolean;
  filters: KpiFilters;
  thresholds: Thresholds;
  window: TimeWindow;
  previous: TimeWindow | null;
  current: PeriodStats;
  prior: PeriodStats | null;
  /** Totals, top lists and market disparity for the window; `monthly` is the whole filtered history. */
  analytics: AnalyticsResult;
  /** Twelve trailing weeks ending now, whatever the period is. */
  trend: TrendWeek[];
  drivers: DriverKpi[];
  lanes: LaneKpi[];
  /** Each finished freight load's rate against its market rate (a fraction), null where none was captured. */
  variance: Array<number | null>;
  pipeline: { needsDriver: number; sent: number; onTheRoad: number };
  verdictMix: Record<Verdict, number>;
  aging: AgingSummary;
  outstanding: OutstandingInvoice[];
  /** What the filter menus offer, taken before any filter is applied. */
  choices: { lanes: string[]; brokers: string[]; drivers: string[]; trucks: string[] };
};

type Fact = {
  row: KpiLoadRow;
  doneAt: number;
  lane: string;
  origin: string;
  destination: string;
  broker: string | null;
  driver: string | null;
  truck: string | null;
  gross: number;
  revenueMiles: number;
  drivenMiles: number;
  emptyMiles: number;
  pickupEmpty: number;
  returnEmpty: number;
  clearedFloor: boolean | null;
  daysToPay: number | null;
  paidWithinTerms: boolean | null;
  market: { pay: number; benchmarkTotal: number; variancePct: number } | null;
  waits: number[];
};

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
const doneAtOf = (l: KpiLoadRow) =>
  loadCompletedAtMs({ status: l.status, completedAt: ms(l.completedAt), cancelledAt: ms(l.cancelledAt), updatedAt: l.updatedAt, scheduledDate: ms(l.scheduledDate), createdAt: l.createdAt });

const mean = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const laneOf = (l: { originAddress: string | null; destinationAddress: string | null }) => `${l.originAddress ?? "?"} → ${l.destinationAddress ?? "?"}`;

function factOf(l: KpiLoadRow, t: Thresholds): Fact {
  const m = money(l);
  const mi = milesIn(l);
  const gross = loadGross(m);
  const driven = drivenMiles(mi);
  const eff = effectiveMiles(mi);
  const expenses = num(l.expenseFuelActual) + num(l.expenseTolls) + num(l.expenseMisc);
  const floor = numOrNull(l.snapshotBaseFloorRpm);
  const isTonu = l.status === "tonu";
  const paid = l.paymentStatus === "paid" && l.invoicedAt != null && l.paidAt != null;
  const daysToPay = paid ? (l.paidAt!.getTime() - l.invoicedAt!.getTime()) / DAY_MS : null;
  const mv = isTonu ? null : loadMarketVariance(toMarketVarianceLoad(l));
  return {
    row: l,
    doneAt: doneAtOf(l),
    lane: laneOf(l),
    origin: l.originAddress ?? "?",
    destination: l.destinationAddress ?? "?",
    broker: l.brokerName,
    driver: l.assignment?.driverName ?? null,
    truck: l.vehicleName,
    gross,
    revenueMiles: revenueMiles(mi),
    drivenMiles: driven,
    emptyMiles: deadheadMilesOf(mi),
    pickupEmpty: eff.pickupDh,
    returnEmpty: eff.returnDh,
    // Pay after the tracked fuel, tolls and other costs, per mile driven, against the floor that was frozen when the load was accepted.
    clearedFloor: isTonu || floor == null || !(driven > 0) ? null : (gross - expenses) / driven >= floor,
    daysToPay,
    paidWithinTerms: daysToPay == null ? null : daysToPay <= (l.payTermsDays ?? t.defaultPayTermsDays),
    market: mv ? { pay: mv.pay, benchmarkTotal: mv.benchmarkTotal, variancePct: mv.variancePct } : null,
    waits: l.stops.map((s) => s.waitMinutes).filter((n): n is number => n != null)
  };
}

function statsOf(facts: Fact[], now: Date): PeriodStats {
  const a = computeAnalytics(facts.map((f) => toAnalyticsInput(f.row)), "all", now).summary;
  const dh = deadheadPct(facts.map((f) => ({ drivenMiles: f.drivenMiles, deadheadMiles: f.emptyMiles })));
  const judged = facts.filter((f) => f.clearedFloor != null);
  const paid = facts.filter((f) => f.paidWithinTerms != null);
  const waits = facts.flatMap((f) => f.waits);
  return {
    loads: a.loadCount,
    gross: a.grossRevenue,
    expenses: a.totalExpenses,
    netEstimate: a.netEstimate,
    rpm: a.avgRpm,
    totalMiles: a.totalMiles,
    emptyShare: dh == null ? null : dh / 100,
    emptyMiles: facts.reduce((s, f) => s + f.emptyMiles, 0),
    clearedFloor: judged.length > 0 ? judged.filter((f) => f.clearedFloor).length / judged.length : null,
    judgedLoads: judged.length,
    paidWithinTerms: paid.length > 0 ? paid.filter((f) => f.paidWithinTerms).length / paid.length : null,
    paidLoads: paid.length,
    avgDaysToPay: mean(paid.map((f) => f.daysToPay!)),
    avgWaitMinutes: mean(waits),
    waitStops: waits.length
  };
}

function applyFilters(rows: KpiLoadRow[], f: KpiFilters): KpiLoadRow[] {
  return rows.filter(
    (l) => (!f.lane || laneOf(l) === f.lane) && (!f.broker || l.brokerName === f.broker) && (!f.driver || l.assignment?.driverName === f.driver) && (!f.truck || l.vehicleName === f.truck)
  );
}

const uniqueSorted = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b));

export function buildDeskKpi(rows: KpiLoadRow[], opts: KpiOptions, thresholds: Thresholds = THRESHOLD_DEFAULTS, now: Date = new Date()): DeskKpi {
  const nowMs = now.getTime();
  const choices = {
    lanes: uniqueSorted(rows.map(laneOf)),
    brokers: uniqueSorted(rows.map((l) => l.brokerName)),
    drivers: uniqueSorted(rows.map((l) => l.assignment?.driverName)),
    trucks: uniqueSorted(rows.map((l) => l.vehicleName))
  };
  const kept = applyFilters(rows, opts.filters);

  const facts = kept.filter((l) => isRevenueLoad(l)).map((l) => factOf(l, thresholds));
  const window = periodWindow(opts.period, nowMs);
  const previous = opts.compare ? previousWindow(opts.period, nowMs) : null;
  const scoped = facts.filter((f) => inWindow(f.doneAt, window));
  const earlier = previous ? facts.filter((f) => inWindow(f.doneAt, previous)) : null;

  const current = statsOf(scoped, now);
  const prior = earlier ? statsOf(earlier, now) : null;
  const win = computeAnalytics(scoped.map((f) => toAnalyticsInput(f.row)), "all", now);
  const whole = computeAnalytics(facts.map((f) => toAnalyticsInput(f.row)), "all", now);
  const analytics: AnalyticsResult = { ...win, monthly: whole.monthly, maxMonthlyRevenue: whole.maxMonthlyRevenue };

  const trend: TrendWeek[] = weekBuckets(nowMs, 12).map((b) => {
    const inBucket = facts.filter((f) => f.doneAt > b.start && f.doneAt <= b.end);
    const gross = inBucket.reduce((s, f) => s + f.gross, 0);
    const mi = inBucket.reduce((s, f) => s + f.revenueMiles, 0);
    const driven = inBucket.reduce((s, f) => s + f.drivenMiles, 0);
    const empty = inBucket.reduce((s, f) => s + f.emptyMiles, 0);
    const dh = deadheadPct(inBucket.map((f) => ({ drivenMiles: f.drivenMiles, deadheadMiles: f.emptyMiles })));
    return { label: b.label, end: b.end, gross, loads: inBucket.length, rpm: mi > 0 ? gross / mi : null, emptyShare: dh == null ? null : dh / 100, revenueMiles: mi, drivenMiles: driven, emptyMiles: empty };
  });

  const byDriver = new Map<string, Fact[]>();
  for (const f of scoped) if (f.driver) byDriver.set(f.driver, [...(byDriver.get(f.driver) ?? []), f]);
  const drivers: DriverKpi[] = [...byDriver.entries()]
    .map(([name, fs]) => {
      const gross = fs.reduce((s, f) => s + f.gross, 0);
      const mi = fs.reduce((s, f) => s + f.revenueMiles, 0);
      const driven = fs.reduce((s, f) => s + f.drivenMiles, 0);
      const empty = fs.reduce((s, f) => s + f.emptyMiles, 0);
      const owed = fs.reduce((s, f) => s + (f.row.assignment?.payEstimate ?? 0), 0);
      return { name, loads: fs.length, gross, rpm: mi > 0 ? gross / mi : null, payOwed: new Prisma.Decimal(owed).toDecimalPlaces(2).toNumber(), drivenMiles: driven, emptyMiles: empty, emptyShare: driven > 0 ? empty / driven : null };
    })
    .sort((a, b) => b.gross - a.gross);

  const byLane = new Map<string, Fact[]>();
  for (const f of scoped) byLane.set(f.lane, [...(byLane.get(f.lane) ?? []), f]);
  const lanes: LaneKpi[] = [...byLane.entries()]
    .map(([key, fs]) => {
      const gross = fs.reduce((s, f) => s + f.gross, 0);
      const mi = fs.reduce((s, f) => s + f.revenueMiles, 0);
      const driven = fs.reduce((s, f) => s + f.drivenMiles, 0);
      const empty = fs.reduce((s, f) => s + f.emptyMiles, 0);
      const marked = fs.filter((f) => f.market);
      const pay = marked.reduce((s, f) => s + f.market!.pay, 0);
      const bench = marked.reduce((s, f) => s + f.market!.benchmarkTotal, 0);
      // A ratio of sums, as TrueLane's own disparity is: (what was paid - what the market would have paid) over the market total.
      const variance = bench > 0 ? (pay - bench) / bench : null;
      return {
        key,
        label: key,
        loads: fs.length,
        gross,
        rpm: mi > 0 ? gross / mi : null,
        emptyShare: driven > 0 ? empty / driven : null,
        avgPickupEmpty: fs.reduce((s, f) => s + f.pickupEmpty, 0) / fs.length,
        avgReturnEmpty: fs.reduce((s, f) => s + f.returnEmpty, 0) / fs.length,
        benchmarked: marked.length,
        marketVariancePct: variance,
        status: variance == null ? ("unknown" as const) : variance >= 0 ? ("above" as const) : ("below" as const)
      };
    })
    .sort((a, b) => b.loads - a.loads || b.gross - a.gross);

  const open = kept.filter((l) => l.status === "draft" || l.status === "accepted" || l.status === "in_progress");
  const pipeline = {
    needsDriver: kept.filter((l) => l.status === "draft" && (!l.assignment || l.assignment.status === "draft" || l.assignment.status === "declined")).length,
    sent: kept.filter((l) => l.assignment?.status === "dispatched").length,
    onTheRoad: kept.filter((l) => l.status === "in_progress" || l.assignment?.status === "in_progress").length
  };
  const verdictMix: Record<Verdict, number> = { accept: 0, caution: 0, reject: 0, needs_fuel: 0 };
  for (const l of open) if (l.verdict) verdictMix[l.verdict] += 1;

  const invoiced = kept.filter((l) => l.paymentStatus === "invoiced");
  const aging = computeAgingSummary(invoiced.map(toAgingView), nowMs);
  const outstanding: OutstandingInvoice[] = invoiced
    .map((l) => {
      const view = toAgingView(l);
      const due = agingDueAtMs(view.invoicedAt, view.payTermsDays);
      return { id: l.id, loadNumber: l.loadNumber, broker: l.brokerName, billed: invoiceBilledTotal(view), dueAt: due, daysPastDue: due == null ? null : calendarDaysBetween(due, nowMs) };
    })
    .sort((a, b) => (b.daysPastDue ?? -Infinity) - (a.daysPastDue ?? -Infinity));

  return {
    period: opts.period,
    compare: opts.compare,
    filters: opts.filters,
    thresholds,
    window,
    previous,
    current,
    prior,
    analytics,
    trend,
    drivers,
    lanes,
    variance: scoped.filter((f) => f.row.status !== "tonu").map((f) => f.market?.variancePct ?? null),
    pipeline,
    verdictMix,
    aging,
    outstanding,
    choices
  };
}

export async function getKpiRows(workspaceId = DEMO_WORKSPACE_ID): Promise<KpiLoadRow[]> {
  const loads = await prisma.load.findMany({
    where: { workspaceId, deletedAt: null },
    include: { vehicle: { include: { costProfile: true } }, assignment: { include: { driver: true } }, stops: { select: { waitMinutes: true } } }
  });
  return loads.map((l) => {
    const profile = l.vehicle?.costProfile ?? null;
    const open = l.status === "draft" || l.status === "accepted" || l.status === "in_progress";
    return {
      ...l,
      vehicleName: l.vehicle?.name ?? null,
      verdict: open && profile ? evaluateTlLoad(l, profile, l.vehicle).finalDecision : null,
      assignment: l.assignment
        ? { driverName: l.assignment.driver.name, payKind: l.assignment.payKind, payEstimate: numOrNull(l.assignment.payEstimate), status: l.assignment.status }
        : null
    };
  });
}

export async function getDeskKpi(opts: { period: KpiPeriod; compare?: boolean; filters?: KpiFilters }, now = new Date(), workspaceId = DEMO_WORKSPACE_ID): Promise<DeskKpi> {
  const [rows, thresholds] = await Promise.all([getKpiRows(workspaceId), getThresholds(workspaceId)]);
  return buildDeskKpi(rows, { period: opts.period, compare: opts.compare ?? true, filters: opts.filters ?? {} }, thresholds, now);
}
