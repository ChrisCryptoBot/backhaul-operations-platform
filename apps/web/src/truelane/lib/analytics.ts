// VENDORED from TrueLane lib/analytics.ts @ e7c88066. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Dashboard analytics (#19): aggregates a driver's completed loads into the
 * higher-level views the History scorecard doesn't cover — period totals (this
 * month / year-to-date / all time), a multi-month revenue trend, and the driver's
 * most profitable lanes and brokers.
 *
 * Pure and dependency-free (mirrors lib/taxSummary.ts + lib/dashboardStats.ts) so
 * it can be unit-tested in Node without pulling in react-native. Gross, miles and the
 * completion date come from lib/domain/loadEconomics (the rule taxSummary and
 * dashboardStats share): gross = linehaul + FSC + layover (a TONU = its fee only),
 * miles driven = drivenMiles (a TONU = the miles to its pickup), $/mi over revenue miles (a TONU = 0; a
 * backhaul leaves out its post-delivery miles), dated by when the load was completed — not by
 * updated_at, which moves on every invoice / paid / sync write. Expenses = tracked
 * fuel/tolls/misc. Only completed/TONU loads count.
 */

import {
  drivenMiles,
  isRevenueLoad as isRevenueLoadRule,
  loadCompletedAtMs,
  loadGross,
  revenueMiles,
} from '@/truelane/lib/domain/loadEconomics';
import { effectiveMiles } from '@/truelane/lib/domain/quotedMiles';
import { loadMarketVariance } from '@/truelane/lib/domain/marketVariance';

export type AnalyticsPeriod = 'month' | 'ytd' | 'all';

/** Minimal load shape needed for analytics (WatermelonDB `Load` satisfies it). */
export type AnalyticsLoadInput = {
  status: string;
  updatedAt: Date;
  /** v45 completion stamp (ms). Absent/null → the TONU's cancelledAt, else updatedAt. */
  completedAt?: number | null;
  cancelledAt?: number | null;
  actualRevenue: number | null;
  quotedRevenue: number;
  fuelSurcharge: number | null;
  layoverPay: number | null;
  tonuRevenue: number | null;
  expenseFuelActual: number;
  expenseTolls: number;
  expenseMisc: number;
  pickupDeadheadMiles: number;
  loadedMiles: number;
  returnDeadheadMiles: number;
  /** Planned-miles snapshot — used when a finished trip's working miles are 0. */
  quotedPickupDhMiles?: number | null;
  quotedLoadedMiles?: number | null;
  quotedReturnDhMiles?: number | null;
  /** A backhaul's post-delivery miles aren't revenue miles. */
  isBackhaul?: boolean | null;
  /** v48: a TONU's miles driven to the pickup. */
  tonuDrivenMiles?: number | null;
  brokerName: string | null;
  originAddress: string | null;
  destinationAddress: string | null;
  /**
   * Market benchmark ($/mi) captured for this load at decision/log time — from the
   * driver's own entry, their lane history, or a BYO market-data key. Optional: absent
   * until the benchmark feature ships, in which case the load simply isn't counted in
   * disparity. Point-in-time by design (don't recompute from current history).
   */
  marketBenchmark?: number | null;
};

export type LaneStat = {
  key: string;
  origin: string;
  destination: string;
  revenue: number;
  count: number;
  miles: number;
};

export type BrokerStat = {
  key: string;
  broker: string;
  revenue: number;
  count: number;
};

export type MonthStat = {
  /** Stable YYYY-MM key. */
  key: string;
  /** Short display label, e.g. "Sep". */
  label: string;
  /** True for the calendar month `now` falls in (the partial, in-progress month). */
  isCurrent: boolean;
  revenue: number;
  count: number;
};

export type AnalyticsSummary = {
  loadCount: number;
  grossRevenue: number;
  totalExpenses: number;
  /** grossRevenue − totalExpenses (tracked fuel/tolls/misc only). */
  netEstimate: number;
  /** "Miles driven": every mile driven for the loads (drivenMiles — a TONU's miles to the pickup count). */
  totalMiles: number;
  /** The miles the pay covers (revenueMiles) — what avgRpm divides by. */
  revenueMiles: number;
  loadedMiles: number;
  /**
   * Σ gross ÷ count over freight loads only — a TONU's fee is not a load's pay, and counting it dragged
   * the average down (math review round 6, #21; the dashboard's "avg per freight load" already did this).
   * Null without a freight load.
   */
  avgRevenuePerLoad: number | null;
  /** "Avg $/revenue mile": Σ gross ÷ Σ revenue miles over loads that have them, null when none do. */
  avgRpm: number | null;
  topLanes: LaneStat[];
  topBrokers: BrokerStat[];
};

export type DisparityGroup = {
  key: string;
  label: string;
  count: number;
  /** (Σ pay − Σ market) ÷ Σ planned miles, $/mi. Negative = paid under the market rate. */
  avgVarianceRpm: number;
  /** (Σ pay − Σ market) ÷ Σ market. Negative = under the market rate. */
  avgVariancePct: number;
};

/**
 * How the driver's realized rate compares to the market benchmark they captured, over
 * the selected period. Only loads that carry a benchmark and have miles are counted.
 * "Variance" is revenue-side: positive = above benchmark (good), negative = underpaid.
 */
export type DisparitySummary = {
  benchmarkedLoadCount: number;
  avgBenchmarkRpm: number;
  avgActualRpm: number;
  avgVarianceRpm: number;
  avgVariancePct: number;
  /** Lanes ranked most-underpaid first (lowest avg variance %). */
  byLane: DisparityGroup[];
  /** Brokers ranked most-underpaid first. */
  byBroker: DisparityGroup[];
};

export type AnalyticsResult = {
  /** Totals + top lists scoped to the selected period. */
  summary: AnalyticsSummary;
  /** Revenue-by-month trend over the last `monthsBack` months (independent of period). */
  monthly: MonthStat[];
  /** Max revenue across `monthly` (>= 1), for bar-height scaling. */
  maxMonthlyRevenue: number;
  /** Rate-vs-benchmark disparity for the period, or null when no benchmarked loads. */
  disparity: DisparitySummary | null;
};

const num = (n: number | null | undefined): number =>
  Number.isFinite(n as number) ? (n as number) : 0;

/** Only completed/TONU loads produce revenue (matches taxSummary + dashboardStats). */
export function isRevenueLoad(l: { status: string }): boolean {
  return isRevenueLoadRule(l);
}

function revenueOf(l: AnalyticsLoadInput): number {
  return loadGross(l);
}


function loadedMilesOf(l: AnalyticsLoadInput): number {
  return l.status === 'tonu' ? 0 : effectiveMiles(l).loaded;
}

type DisparityRow = {
  pay: number;
  benchmarkTotal: number;
  miles: number;
  origin: string;
  destination: string;
  broker: string;
};

type DisparityTotals = { pay: number; benchmark: number; miles: number };

const addRow = (t: DisparityTotals, r: DisparityRow) => {
  t.pay += r.pay;
  t.benchmark += r.benchmarkTotal;
  t.miles += r.miles;
};

function groupDisparity(
  rows: DisparityRow[],
  keyOf: (r: DisparityRow) => string,
  labelOf: (r: DisparityRow) => string,
  topN: number
): DisparityGroup[] {
  const map = new Map<string, DisparityTotals & { count: number; label: string }>();
  for (const r of rows) {
    const key = keyOf(r);
    if (!key) continue;
    let g = map.get(key);
    if (!g) {
      g = { count: 0, label: labelOf(r), pay: 0, benchmark: 0, miles: 0 };
      map.set(key, g);
    }
    g.count += 1;
    addRow(g, r);
  }
  return [...map.entries()]
    .map(([key, g]) => ({
      key,
      label: g.label,
      count: g.count,
      avgVarianceRpm: (g.pay - g.benchmark) / g.miles,
      avgVariancePct: (g.pay - g.benchmark) / g.benchmark,
    }))
    // Most underpaid first (lowest avg variance %) — the actionable end.
    .sort((a, b) => a.avgVariancePct - b.avgVariancePct)
    .slice(0, topN);
}

/**
 * Disparity of realized rate vs captured benchmark, on the one basis Calculate and the broker
 * scorecard use (lib/domain/marketVariance, H4): all-in pay (linehaul + FSC, no layover) vs the market
 * rate, both per PLANNED mile. Counts only loads with a positive benchmark and miles (no TONU).
 * Ratios of sums, weighted by miles like every other $/mi here, so the tiles reconcile exactly:
 * avgVarianceRpm = avgActualRpm − avgBenchmarkRpm, and avgVariancePct = avgVarianceRpm ÷ avgBenchmarkRpm.
 */
function computeDisparity(loads: AnalyticsLoadInput[], topN: number): DisparitySummary | null {
  const rows: DisparityRow[] = [];
  for (const l of loads) {
    const v = loadMarketVariance(l);
    if (v == null) continue;
    rows.push({
      pay: v.pay,
      benchmarkTotal: v.benchmarkTotal,
      miles: v.miles,
      origin: (l.originAddress ?? '').trim(),
      destination: (l.destinationAddress ?? '').trim(),
      broker: (l.brokerName ?? '').trim(),
    });
  }
  const n = rows.length;
  if (n === 0) return null;
  const t: DisparityTotals = { pay: 0, benchmark: 0, miles: 0 };
  for (const r of rows) addRow(t, r);
  return {
    benchmarkedLoadCount: n,
    avgBenchmarkRpm: t.benchmark / t.miles,
    avgActualRpm: t.pay / t.miles,
    avgVarianceRpm: (t.pay - t.benchmark) / t.miles,
    avgVariancePct: (t.pay - t.benchmark) / t.benchmark,
    byLane: groupDisparity(
      rows,
      (r) => (r.origin || r.destination ? `${r.origin.toLowerCase()}||${r.destination.toLowerCase()}` : ''),
      (r) => `${r.origin || '—'} → ${r.destination || '—'}`,
      topN
    ),
    byBroker: groupDisparity(rows, (r) => r.broker.toLowerCase(), (r) => r.broker, topN),
  };
}

function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function inPeriod(t: number, period: AnalyticsPeriod, now: Date): boolean {
  if (period === 'all') return true;
  if (period === 'month') {
    const start = startOfMonth(now).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return t >= start && t < end;
  }
  // ytd
  const start = new Date(now.getFullYear(), 0, 1).getTime();
  const end = new Date(now.getFullYear() + 1, 0, 1).getTime();
  return t >= start && t < end;
}

/** 10q — round a dollar aggregate to whole cents so summed float noise never surfaces (or drifts a
 *  boundary) after accumulating across many loads. */
const roundCents = (n: number): number => Math.round(n * 100) / 100;

function summarize(loads: AnalyticsLoadInput[], topN: number): AnalyticsSummary {
  let grossRevenue = 0;
  let totalExpenses = 0;
  let totalMiles = 0;
  let revenueMilesSum = 0;
  let loadedMiles = 0;
  // $/mi counts only loads with miles (a TONU or a no-miles load adds no revenue to it either).
  let rpmRevenue = 0;
  let freightRevenue = 0;
  let freightCount = 0;
  const laneMap = new Map<string, LaneStat>();
  const brokerMap = new Map<string, BrokerStat>();

  for (const l of loads) {
    const rev = revenueOf(l);
    // Revenue miles for every $/mi (and lanes); driven miles for the "Miles driven" tile.
    const mi = revenueMiles(l);
    grossRevenue += rev;
    totalExpenses += num(l.expenseFuelActual) + num(l.expenseTolls) + num(l.expenseMisc);
    totalMiles += drivenMiles(l);
    revenueMilesSum += mi;
    loadedMiles += loadedMilesOf(l);
    if (mi > 0) rpmRevenue += rev;
    if (l.status !== 'tonu') {
      freightRevenue += rev;
      freightCount += 1;
    }

    const origin = (l.originAddress ?? '').trim();
    const destination = (l.destinationAddress ?? '').trim();
    if (origin || destination) {
      const key = `${origin.toLowerCase()}||${destination.toLowerCase()}`;
      const lane = laneMap.get(key);
      if (lane) {
        lane.revenue += rev;
        lane.count += 1;
        lane.miles += mi;
      } else {
        laneMap.set(key, { key, origin, destination, revenue: rev, count: 1, miles: mi });
      }
    }

    const broker = (l.brokerName ?? '').trim();
    if (broker) {
      const key = broker.toLowerCase();
      const b = brokerMap.get(key);
      if (b) {
        b.revenue += rev;
        b.count += 1;
      } else {
        brokerMap.set(key, { key, broker, revenue: rev, count: 1 });
      }
    }
  }

  const byRevenueDesc = (a: { revenue: number; key: string }, b: { revenue: number; key: string }) =>
    b.revenue - a.revenue || a.key.localeCompare(b.key);

  return {
    loadCount: loads.length,
    grossRevenue: roundCents(grossRevenue),
    totalExpenses: roundCents(totalExpenses),
    netEstimate: roundCents(grossRevenue - totalExpenses),
    totalMiles,
    revenueMiles: revenueMilesSum,
    loadedMiles,
    avgRevenuePerLoad: freightCount > 0 ? roundCents(freightRevenue / freightCount) : null,
    avgRpm: revenueMilesSum > 0 ? rpmRevenue / revenueMilesSum : null,
    topLanes: [...laneMap.values()].sort(byRevenueDesc).slice(0, topN),
    topBrokers: [...brokerMap.values()].sort(byRevenueDesc).slice(0, topN),
  };
}

function monthlyTrend(loads: AnalyticsLoadInput[], now: Date, monthsBack: number): MonthStat[] {
  const out: MonthStat[] = [];
  for (let i = monthsBack - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    const start = d.getTime();
    const end = next.getTime();
    let revenue = 0;
    let count = 0;
    for (const l of loads) {
      const t = loadCompletedAtMs(l);
      if (t >= start && t < end) {
        revenue += revenueOf(l);
        count += 1;
      }
    }
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString(undefined, { month: 'short' }),
      isCurrent: i === 0,
      revenue,
      count,
    });
  }
  return out;
}

export function computeAnalytics(
  loads: AnalyticsLoadInput[],
  period: AnalyticsPeriod,
  now: Date = new Date(),
  opts?: { monthsBack?: number; topN?: number }
): AnalyticsResult {
  const monthsBack = Math.max(1, opts?.monthsBack ?? 6);
  const topN = Math.max(1, opts?.topN ?? 5);

  const revenueLoads = loads.filter(isRevenueLoad);
  const scoped = revenueLoads.filter((l) => inPeriod(loadCompletedAtMs(l), period, now));
  const monthly = monthlyTrend(revenueLoads, now, monthsBack);

  return {
    summary: summarize(scoped, topN),
    monthly,
    maxMonthlyRevenue: Math.max(1, ...monthly.map((m) => m.revenue)),
    disparity: computeDisparity(scoped, topN),
  };
}
