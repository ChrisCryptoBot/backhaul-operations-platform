import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { computeAnalytics, isRevenueLoad, type AnalyticsResult } from "@/truelane/lib/analytics";
import { computeAgingSummary, invoiceBilledTotal, agingDueAtMs, type AgingSummary } from "@/truelane/lib/invoice";
import { deadheadMilesOf, deadheadPct, drivenMiles, loadCompletedAtMs, loadGross, revenueMiles } from "@/truelane/lib/domain/loadEconomics";
import { effectiveMiles } from "@/truelane/lib/domain/quotedMiles";
import { loadMarketVariance } from "@/truelane/lib/domain/marketVariance";
import { calendarDaysBetween } from "@/truelane/lib/domain/calendarDays";
import { DAY_MS, WEEK_MS, inWindow, periodWindow, previousWindow, weekBuckets, type KpiPeriod, type TimeWindow } from "@/lib/kpi-periods";
import type { KpiFilters } from "@/lib/kpi-params";
import { THRESHOLD_DEFAULTS, type Thresholds } from "@/lib/thresholds";
import type { Verdict } from "@/lib/desk-format";
import { reasonLabel } from "@/lib/disruptions";
import { evaluateTlLoad } from "./evaluate";
import { notQuote } from "@/lib/quote-status";
import { ms, num, numOrNull, toAgingView, toAnalyticsInput, toMarketVarianceLoad, type LoadRow } from "./convert";
import { getThresholds } from "./thresholds";
import { currentWorkspaceId } from "./workspace";
import { answerCache, clockBucket } from "./answer-cache";

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
  /** Why a cancelled load or a TONU fell through (a key from lib/disruptions.ts). */
  cancelReason: string | null;
  /** The truck's break-even floor ($/mi, before fuel) frozen when the load was accepted. */
  snapshotBaseFloorRpm: Prisma.Decimal | number | string | null;
  vehicleName: string | null;
  /** Verdict on the truck's own floor, for loads that are not finished yet. */
  verdict: Verdict | null;
  stops: Array<{ waitMinutes: number | null; arrivedAt?: Date | null; timeWindowLatest?: Date | null }>;
  assignment: { driverName: string; payKind: string; payEstimate: number | null; status: string } | null;
};

export type { KpiFilters };
export type KpiOptions = { period: KpiPeriod; compare: boolean; filters: KpiFilters };

export type PeriodStats = {
  /** Loads that finished and earned money: delivered freight plus any TONU fees. */
  loads: number;
  /** How many of `loads` were a TONU (the truck went and there was nothing to haul). */
  tonuLoads: number;
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
  /** Share of stops the driver reached by the time the window closed, over stops that have both times. */
  onTimeArrivals: number | null;
  arrivalStops: number;
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
export type ReliabilityKpi = {
  cancelled: number;
  tonu: number;
  lost: number;
  /** Delivered freight loads in the same window. */
  delivered: number;
  /** Lost loads over loads that were meant to run (delivered + lost), 0 to 1; null with neither. */
  rate: number | null;
  /** Why they fell through, most common first. */
  reasons: Array<{ key: string; label: string; count: number }>;
  priorLost: number | null;
  priorRate: number | null;
};

export type BrokerKpi = {
  name: string;
  loads: number;
  gross: number;
  rpm: number | null;
  /** How far above (+) or below (-) the market rate this broker paid, as a fraction, over loads that carry one. */
  marketVariancePct: number | null;
  benchmarked: number;
  paidLoads: number;
  avgDaysToPay: number | null;
  avgWaitMinutes: number | null;
  waitStops: number;
  /** Loads this broker cancelled or turned into a TONU. */
  lost: number;
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
  brokers: BrokerKpi[];
  reliability: ReliabilityKpi;
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
  /** For each stop with an arrival and a window: was the driver there by the time the window closed. */
  arrivals: boolean[];
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
    waits: l.stops.map((s) => s.waitMinutes).filter((n): n is number => n != null),
    arrivals: l.stops.filter((s) => s.arrivedAt != null && s.timeWindowLatest != null).map((s) => s.arrivedAt!.getTime() <= s.timeWindowLatest!.getTime())
  };
}

function statsOf(facts: Fact[], now: Date): PeriodStats {
  const a = computeAnalytics(facts.map((f) => toAnalyticsInput(f.row)), "all", now).summary;
  const dh = deadheadPct(facts.map((f) => ({ drivenMiles: f.drivenMiles, deadheadMiles: f.emptyMiles })));
  const judged = facts.filter((f) => f.clearedFloor != null);
  const paid = facts.filter((f) => f.paidWithinTerms != null);
  const waits = facts.flatMap((f) => f.waits);
  const arrivals = facts.flatMap((f) => f.arrivals);
  return {
    loads: a.loadCount,
    tonuLoads: facts.filter((f) => f.row.status === "tonu").length,
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
    onTimeArrivals: arrivals.length > 0 ? arrivals.filter(Boolean).length / arrivals.length : null,
    arrivalStops: arrivals.length,
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

  const lostIn = (w: TimeWindow) => {
    const cancelled = kept.filter((l) => l.status === "cancelled" && l.cancelledAt != null && inWindow(l.cancelledAt.getTime(), w));
    const tonu = facts.filter((f) => f.row.status === "tonu" && inWindow(f.doneAt, w)).map((f) => f.row);
    const delivered = facts.filter((f) => f.row.status !== "tonu" && inWindow(f.doneAt, w)).length;
    return { cancelled, tonu, delivered, lost: cancelled.length + tonu.length };
  };
  const now0 = lostIn(window);
  const was = previous ? lostIn(previous) : null;
  const rateOf = (x: { lost: number; delivered: number }) => (x.lost + x.delivered > 0 ? x.lost / (x.lost + x.delivered) : null);
  const reasonCounts = new Map<string, number>();
  for (const l of [...now0.cancelled, ...now0.tonu]) reasonCounts.set(l.cancelReason ?? "none", (reasonCounts.get(l.cancelReason ?? "none") ?? 0) + 1);
  const reliability: ReliabilityKpi = {
    cancelled: now0.cancelled.length,
    tonu: now0.tonu.length,
    lost: now0.lost,
    delivered: now0.delivered,
    rate: rateOf(now0),
    reasons: [...reasonCounts.entries()].map(([key, count]) => ({ key, label: key === "none" ? "No reason given" : reasonLabel(key), count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    priorLost: was ? was.lost : null,
    priorRate: was ? rateOf(was) : null
  };

  const brokerName = (b: string | null) => b ?? "No customer";
  const byBroker = new Map<string, Fact[]>();
  for (const f of scoped) byBroker.set(brokerName(f.broker), [...(byBroker.get(brokerName(f.broker)) ?? []), f]);
  for (const l of now0.cancelled) if (!byBroker.has(brokerName(l.brokerName))) byBroker.set(brokerName(l.brokerName), []);
  const brokers: BrokerKpi[] = [...byBroker.entries()]
    .map(([name, fs]) => {
      const gross = fs.reduce((s, f) => s + f.gross, 0);
      const mi = fs.reduce((s, f) => s + f.revenueMiles, 0);
      const marked = fs.filter((f) => f.market);
      const bench = marked.reduce((s, f) => s + f.market!.benchmarkTotal, 0);
      const paid = fs.filter((f) => f.daysToPay != null);
      const waits = fs.flatMap((f) => f.waits);
      const lost = now0.cancelled.filter((l) => brokerName(l.brokerName) === name).length + fs.filter((f) => f.row.status === "tonu").length;
      return {
        name,
        loads: fs.length,
        gross,
        rpm: mi > 0 ? gross / mi : null,
        marketVariancePct: bench > 0 ? (marked.reduce((s, f) => s + f.market!.pay, 0) - bench) / bench : null,
        benchmarked: marked.length,
        paidLoads: paid.length,
        avgDaysToPay: mean(paid.map((f) => f.daysToPay!)),
        avgWaitMinutes: mean(waits),
        waitStops: waits.length,
        lost
      };
    })
    .sort((a, b) => b.gross - a.gross || a.name.localeCompare(b.name));

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
    brokers,
    reliability,
    variance: scoped.filter((f) => f.row.status !== "tonu").map((f) => f.market?.variancePct ?? null),
    pipeline,
    verdictMix,
    aging,
    outstanding,
    choices
  };
}

/** "All time" reads this far back (the fleet's last three years). A big fleet has far more finished loads than one screen can add up. */
export const ALL_TIME_DAYS = 1095;

/**
 * How far back the rows must reach for this period: the window itself, the one before it (for the comparison), the twelve-week trend and the six-month chart.
 * Open loads and invoices still out are read whatever their age (the pipeline and the aging use them).
 */
export function rowsSince(period: KpiPeriod, nowMs: number): number {
  const w = periodWindow(period, nowMs);
  const prev = previousWindow(period, nowMs);
  const starts = [w.start ?? nowMs - ALL_TIME_DAYS * DAY_MS, prev?.start ?? null, nowMs - 13 * WEEK_MS, nowMs - 190 * DAY_MS];
  return starts.filter((x): x is number => x != null).reduce((lo, x) => (x < lo ? x : lo), nowMs);
}

/** Where the dock waits are needed from: the window and the one before it (the older months are only for the charts). "All time" needs them all. */
function stopsStart(period: KpiPeriod, nowMs: number, floor: number): number {
  const w = periodWindow(period, nowMs);
  const prev = previousWindow(period, nowMs);
  const start = w.start == null ? floor : (prev?.start ?? w.start);
  return start < floor ? floor : start;
}

type KpiRaw = Omit<KpiLoadRow, "vehicleName" | "verdict" | "stops" | "assignment"> & { vehicleName: string | null; asStatus: string | null; asPayKind: string | null; asPayEstimate: number | null; asDriver: string | null };

export async function getKpiRows(workspaceId = currentWorkspaceId(), opts: { since?: Date | null; lane?: string; stopsSince?: Date | null } = {}): Promise<KpiLoadRow[]> {
  const [origin, destination] = opts.lane ? opts.lane.split(" → ") : [null, null];
  const since = opts.since ?? null;
  const OPEN = ["draft", "accepted", "in_progress"];
  const laneSql = opts.lane
    ? Prisma.sql` and l.origin_address ${origin === "?" ? Prisma.sql`is null` : Prisma.sql`= ${origin}`} and l.destination_address ${destination === "?" ? Prisma.sql`is null` : Prisma.sql`= ${destination}`}`
    : Prisma.empty;
  const sinceSql = since
    ? Prisma.sql` and (l.status in ('draft', 'accepted', 'in_progress') or l.payment_status = 'invoiced' or l.completed_at >= ${since} or l.cancelled_at >= ${since} or (l.completed_at is null and l.cancelled_at is null))`
    : Prisma.empty;
  // One query for the rows, with plain numbers (no Decimal objects) and the truck and driver names joined in. The truck's cost profile is read only for open loads below
  // (it prices their verdict); reading one for every finished load is what made this slow.
  const loads = await prisma.$queryRaw<KpiRaw[]>`
    select l.id, l.load_number as "loadNumber", l.created_at as "createdAt", l.updated_at as "updatedAt", l.scheduled_date as "scheduledDate", l.completed_at as "completedAt", l.cancelled_at as "cancelledAt", l.paid_at as "paidAt",
      l.cancel_reason as "cancelReason", l.snapshot_base_floor_rpm::float8 as "snapshotBaseFloorRpm", l.status,
      l.actual_revenue::float8 as "actualRevenue", l.quoted_revenue::float8 as "quotedRevenue", l.fuel_surcharge::float8 as "fuelSurcharge", l.layover_pay::float8 as "layoverPay", l.tonu_revenue::float8 as "tonuRevenue",
      l.expense_fuel_actual::float8 as "expenseFuelActual", l.expense_tolls::float8 as "expenseTolls", l.expense_misc::float8 as "expenseMisc",
      l.pickup_deadhead_miles::float8 as "pickupDeadheadMiles", l.loaded_miles::float8 as "loadedMiles", l.return_deadhead_miles::float8 as "returnDeadheadMiles",
      l.quoted_pickup_dh_miles::float8 as "quotedPickupDhMiles", l.quoted_loaded_miles::float8 as "quotedLoadedMiles", l.quoted_return_dh_miles::float8 as "quotedReturnDhMiles", l.is_backhaul as "isBackhaul",
      l.broker_name as "brokerName", l.origin_address as "originAddress", l.destination_address as "destinationAddress", l.market_benchmark::float8 as "marketBenchmark",
      l.payment_status as "paymentStatus", l.invoiced_at as "invoicedAt", l.pay_terms_days as "payTermsDays", l.invoiced_amount::float8 as "invoicedAmount",
      v.name as "vehicleName", a.status as "asStatus", a.pay_kind as "asPayKind", a.pay_estimate::float8 as "asPayEstimate", d.name as "asDriver"
    from loads l left join vehicles v on v.id = l.vehicle_id left join assignments a on a.load_id = l.id left join drivers d on d.id = a.driver_id
    where l.workspace_id = ${workspaceId} and l.deleted_at is null and l.status <> 'quote'${laneSql}${sinceSql}`;

  // Stops (the waits at the dock) are read only for the loads a number is made of: open ones and those finished since `stopsSince`, not the older months the charts reach back to.
  const stopsFrom = (opts.stopsSince ?? since)?.getTime() ?? null;
  const needStops = loads.filter((l) => OPEN.includes(l.status) || stopsFrom == null || (l.completedAt ?? l.cancelledAt ?? l.updatedAt).getTime() >= stopsFrom).map((l) => l.id);
  const stopRows = needStops.length
    ? await prisma.$queryRaw<Array<{ loadId: string; waitMinutes: number | null; arrivedAt: Date | null; timeWindowLatest: Date | null }>>`
        select load_id as "loadId", wait_minutes as "waitMinutes", arrived_at as "arrivedAt", time_window_latest as "timeWindowLatest" from stops where load_id = any(${needStops})`
    : [];
  const stopsOf = new Map<string, Array<{ waitMinutes: number | null; arrivedAt: Date | null; timeWindowLatest: Date | null }>>();
  for (const st of stopRows) stopsOf.set(st.loadId, [...(stopsOf.get(st.loadId) ?? []), st]);

  const openIds = loads.filter((l) => OPEN.includes(l.status)).map((l) => l.id);
  const priced = openIds.length ? await prisma.load.findMany({ where: { id: { in: openIds } }, include: { vehicle: { include: { costProfile: true } }, assignment: true } }) : [];
  const verdictOf = new Map<string, Verdict | null>();
  for (const l of priced) {
    const profile = l.vehicle?.costProfile ?? null;
    verdictOf.set(l.id, profile ? evaluateTlLoad(l, profile, l.vehicle).finalDecision : null);
  }
  return loads.map((l) => ({
    ...l,
    verdict: verdictOf.get(l.id) ?? null,
    stops: stopsOf.get(l.id) ?? [],
    assignment: l.asStatus ? { driverName: l.asDriver ?? "", payKind: l.asPayKind ?? "", payEstimate: l.asPayEstimate, status: l.asStatus } : null
  }));
}

/**
 * What the KPI, Customers and Lanes screens read is every load of a window (tens of thousands for a big fleet), so a finished answer is kept until the data under
 * it moves (answer-cache.ts), and it also depends on the period, the filters, the thresholds and the hour (the windows slide with the clock).
 */
const answers = answerCache<DeskKpi>();
/** Tests clear it between cases. */
export const clearKpiCache = () => answers.clear();

export async function getDeskKpi(opts: { period: KpiPeriod; compare?: boolean; filters?: KpiFilters }, now = new Date(), workspaceId = currentWorkspaceId()): Promise<DeskKpi> {
  const thresholds = await getThresholds(workspaceId);
  const compare = opts.compare ?? true;
  const filters = opts.filters ?? {};
  return answers.remember([workspaceId, opts.period, compare, filters, clockBucket(now.getTime(), 3_600_000), thresholds], workspaceId, async () => {
    const since = new Date(rowsSince(opts.period, now.getTime()));
    const rows = await getKpiRows(workspaceId, { since, lane: filters.lane, stopsSince: new Date(stopsStart(opts.period, now.getTime(), since.getTime())) });
    return buildDeskKpi(rows, { period: opts.period, compare, filters }, thresholds, now);
  });
}
