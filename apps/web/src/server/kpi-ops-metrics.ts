import type { DisruptionReason } from "@prisma/client";
import { DISRUPTION_REASON_OPTIONS, disruptionReasonLabel } from "@/lib/disruptions";

/**
 * Pure ops-analytics metric functions for the weekly KPI dashboard. Everything
 * here is deterministic and side-effect-free — the server fetches the rows and
 * hands them in, these functions shape them. Centered on minimizing shuttle
 * empty miles (a shuttle running empty is waste; a PTP deadheading out to a DC
 * is expected). See the "Backhaul metrics scope" for the approved metric set.
 */

// ── Input shapes ────────────────────────────────────────────────────────────

export interface OpsLegInput {
  legIndex: number;
  legType: "SHUTTLE" | "PTP" | "DELIVERY";
  driverId: string | null;
  driverName: string | null;
  /** Logged on-site time at this leg's stop (null = not yet verified). */
  arrivalAt: Date | null;
}

/** A current-week load, normalized with its legs, for the current-week metrics. */
export interface OpsLoadInput {
  status: string;
  driverType: string | null;
  lineHaulRate: number;
  puDeadheadMiles: number;
  delDeadheadMiles: number;
  loadedMiles: number;
  pickupWindowEnd: Date | null;
  deliveryWindowEnd: Date | null;
  deliveryApptType: string | null;
  /** Pre-resolved lane dollar target for this load (from the lane targets map), or null. */
  laneTarget: number | null;
  /** DAT market-rate benchmark snapshotted on the load (Load.marketRate), or null. */
  marketRate: number | null;
  /** Whether this load counts toward the revenue KPIs (mirrors shouldIncludeInKpi). */
  kpiEligible: boolean;
  legs: OpsLegInput[];
}

/** A lightweight multi-week row (from the drilldown fetch) for the radius trend. */
export interface OpsDrilldownRow {
  weekIso: string;
  driverType: string | null;
  puDeadheadMiles: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function sortedLegs(load: OpsLoadInput): OpsLegInput[] {
  return [...load.legs].sort((a, b) => a.legIndex - b.legIndex);
}

function firstShuttleLeg(load: OpsLoadInput): OpsLegInput | null {
  return sortedLegs(load).find((leg) => leg.legType === "SHUTTLE") ?? null;
}

function finalDeliveryLeg(load: OpsLoadInput): OpsLegInput | null {
  const deliveries = sortedLegs(load).filter((leg) => leg.legType === "DELIVERY");
  return deliveries.length > 0 ? deliveries[deliveries.length - 1] : null;
}

function hasShuttleLeg(load: OpsLoadInput): boolean {
  return load.legs.some((leg) => leg.legType === "SHUTTLE");
}

function round(value: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

// ── 1. Shuttle empty-mile leaderboard ───────────────────────────────────────

export interface ShuttleEmptyLeaderboardRow {
  /** Stable identity for keying/rank — a driverId when linked, else `name:<driverName>`. */
  key: string;
  driverId: string | null;
  driverName: string | null;
  deadheadMiles: number;
  loadedMiles: number;
  emptyPct: number;
}

/**
 * Attributes shuttle empty miles to drivers so the worst offenders surface first.
 * Deadhead is a LOAD-level number and loaded miles are only known at the load level,
 * so we attribute the whole load — pickup + delivery deadhead AND loaded miles — to
 * the shuttle hauler (the driver of the FIRST shuttle leg), who owns the shuttle run.
 * Loads with no shuttle leg are excluded (a PTP deadheading out is expected, not a
 * shuttle running empty). Splitting delivery deadhead onto the final delivery driver
 * would need per-leg loaded miles to yield a meaningful empty-% (see the spec's
 * DH_ATTRIBUTION flag); the PU-vs-DEL nuance lives in the aggregate split chart
 * instead. Worst-first by deadhead miles; per-driver empty-% is honest here.
 */
export function computeShuttleEmptyLeaderboard(loads: OpsLoadInput[]): ShuttleEmptyLeaderboardRow[] {
  const byDriver = new Map<
    string,
    { driverId: string | null; driverName: string | null; deadheadMiles: number; loadedMiles: number }
  >();

  const bump = (driverId: string | null, name: string | null, deadhead: number, loaded: number) => {
    // Attribute to the linked driver when available, else fall back to the free-text
    // name — many legs carry only a name. Skip only when neither identity exists.
    const key = driverId ?? (name ? `name:${name}` : null);
    if (!key) return;
    const row = byDriver.get(key) ?? { driverId, driverName: name, deadheadMiles: 0, loadedMiles: 0 };
    row.deadheadMiles += deadhead;
    row.loadedMiles += loaded;
    if (!row.driverName && name) row.driverName = name;
    byDriver.set(key, row);
  };

  for (const load of loads) {
    const shuttle = firstShuttleLeg(load);
    if (!shuttle) continue; // exclude non-shuttle loads
    bump(shuttle.driverId, shuttle.driverName, load.puDeadheadMiles + load.delDeadheadMiles, load.loadedMiles);
  }

  return Array.from(byDriver.entries())
    .map(([key, row]) => {
      const totalMiles = row.deadheadMiles + row.loadedMiles;
      return {
        key,
        driverId: row.driverId,
        driverName: row.driverName,
        deadheadMiles: round(row.deadheadMiles),
        loadedMiles: round(row.loadedMiles),
        emptyPct: totalMiles > 0 ? round((row.deadheadMiles / totalMiles) * 100) : 0
      };
    })
    .sort((a, b) => b.deadheadMiles - a.deadheadMiles);
}

// ── 2. Deadhead split (controllable vs expected) ─────────────────────────────

export interface DeadheadSplit {
  controllable: { pickupDh: number; deliveryDh: number };
  expected: { pickupDh: number; deliveryDh: number };
}

/**
 * Splits total pickup/delivery deadhead into "controllable" (loads with a shuttle
 * leg — an empty shuttle we can attack) vs "expected" (PTP, deadheading out to a
 * DC is structural). Amber vs neutral in the chart.
 */
export function computeDeadheadSplitPerLoad(loads: OpsLoadInput[]): DeadheadSplit {
  const split: DeadheadSplit = {
    controllable: { pickupDh: 0, deliveryDh: 0 },
    expected: { pickupDh: 0, deliveryDh: 0 }
  };
  for (const load of loads) {
    const bucket = hasShuttleLeg(load) ? split.controllable : split.expected;
    bucket.pickupDh += load.puDeadheadMiles;
    bucket.deliveryDh += load.delDeadheadMiles;
  }
  split.controllable.pickupDh = round(split.controllable.pickupDh);
  split.controllable.deliveryDh = round(split.controllable.deliveryDh);
  split.expected.pickupDh = round(split.expected.pickupDh);
  split.expected.deliveryDh = round(split.expected.deliveryDh);
  return split;
}

// ── 3. Average shuttle deadhead radius (weekly, single line) ──────────────────

export interface DeadheadRadiusPoint {
  weekIso: string;
  avgRadius: number;
  loadCount: number;
}

/**
 * Weekly mean of pickup deadhead on shuttle-origin loads — a proxy for how far
 * shuttles reach empty. Single line, no percentile band (v1). Shuttle-origin is
 * proxied by driverType='SHUTTLE' so it can be computed across weeks without legs.
 */
export function computeAvgShuttleDeadheadRadius(rows: OpsDrilldownRow[]): DeadheadRadiusPoint[] {
  const byWeek = new Map<string, { sum: number; count: number }>();
  for (const row of rows) {
    if (row.driverType !== "SHUTTLE") continue;
    const agg = byWeek.get(row.weekIso) ?? { sum: 0, count: 0 };
    agg.sum += row.puDeadheadMiles;
    agg.count += 1;
    byWeek.set(row.weekIso, agg);
  }
  return Array.from(byWeek.entries())
    .map(([weekIso, agg]) => ({
      weekIso,
      avgRadius: agg.count > 0 ? round(agg.sum / agg.count) : 0,
      loadCount: agg.count
    }))
    .sort((a, b) => a.weekIso.localeCompare(b.weekIso));
}

// ── 4. Rate variance histogram ($100 bins) ───────────────────────────────────

export interface RateVarianceBin {
  lo: number;
  hi: number;
  count: number;
  /** true when the whole bin is under target (used for the red/accent color split). */
  underTarget: boolean;
}

export interface RateVarianceHistogram {
  bins: RateVarianceBin[];
  median: number | null;
  count: number;
  binSize: number;
}

/**
 * Per-load rate variance (lineHaulRate − laneTarget) bucketed into $100 bins,
 * reusing the lane scorecard's `revLoad − target` idea at the load grain. Only
 * KPI-eligible loads with a resolved lane target are included. Bins are contiguous
 * from the lowest to the highest observed variance so the $0 marker sits in place.
 */
export function computeRateVarianceHistogram(loads: OpsLoadInput[], binSize = 100): RateVarianceHistogram {
  const variances: number[] = [];
  for (const load of loads) {
    if (!load.kpiEligible || load.laneTarget === null) continue;
    variances.push(load.lineHaulRate - load.laneTarget);
  }
  if (variances.length === 0) {
    return { bins: [], median: null, count: 0, binSize };
  }
  const binIndex = (v: number) => Math.floor(v / binSize);
  const minIdx = Math.min(...variances.map(binIndex));
  const maxIdx = Math.max(...variances.map(binIndex));
  const counts = new Map<number, number>();
  for (const v of variances) {
    const idx = binIndex(v);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  const bins: RateVarianceBin[] = [];
  for (let idx = minIdx; idx <= maxIdx; idx += 1) {
    const lo = idx * binSize;
    const hi = lo + binSize;
    bins.push({ lo, hi, count: counts.get(idx) ?? 0, underTarget: hi <= 0 });
  }
  const sorted = [...variances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { bins, median: round(median), count: variances.length, binSize };
}

/**
 * Per-load variance against the DAT market rate (lineHaulRate − marketRate), $100 bins.
 * Identical shape/logic to computeRateVarianceHistogram but keyed off the market
 * benchmark instead of the internal lane target, so the two can be shown side by side.
 * "underTarget" here means booked under market.
 */
export function computeMarketVarianceHistogram(loads: OpsLoadInput[], binSize = 100): RateVarianceHistogram {
  const variances: number[] = [];
  for (const load of loads) {
    if (!load.kpiEligible || load.marketRate === null) continue;
    variances.push(load.lineHaulRate - load.marketRate);
  }
  if (variances.length === 0) {
    return { bins: [], median: null, count: 0, binSize };
  }
  const binIndex = (v: number) => Math.floor(v / binSize);
  const minIdx = Math.min(...variances.map(binIndex));
  const maxIdx = Math.max(...variances.map(binIndex));
  const counts = new Map<number, number>();
  for (const v of variances) {
    const idx = binIndex(v);
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }
  const bins: RateVarianceBin[] = [];
  for (let idx = minIdx; idx <= maxIdx; idx += 1) {
    const lo = idx * binSize;
    const hi = lo + binSize;
    bins.push({ lo, hi, count: counts.get(idx) ?? 0, underTarget: hi <= 0 });
  }
  const sorted = [...variances].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return { bins, median: round(median), count: variances.length, binSize };
}

// ── 5. Reliability metrics (OTD / OTP / firm-appt / missed) ───────────────────

export interface OnTimeBucket {
  onTime: number;
  /** Verified loads (have both a window end and an arrival) — the "% of verified" denominator. */
  total: number;
  /** Loads with a window but no arrival logged — counted neither on-time nor missed. */
  unverified: number;
}

export interface ReliabilityMetrics {
  otd: OnTimeBucket;
  otp: OnTimeBucket;
  firmAppt: OnTimeBucket;
  /** Missed deliveries (arrived after the window end) — the complement of OTD within verified. */
  missed: { missed: number; total: number; unverified: number };
}

function evaluateOnTime(
  loads: OpsLoadInput[],
  windowEndOf: (load: OpsLoadInput) => Date | null,
  arrivalOf: (load: OpsLoadInput) => Date | null
): OnTimeBucket {
  let onTime = 0;
  let total = 0;
  let unverified = 0;
  for (const load of loads) {
    const windowEnd = windowEndOf(load);
    if (!windowEnd) continue; // no window → out of scope entirely
    const arrival = arrivalOf(load);
    if (!arrival) {
      unverified += 1;
      continue;
    }
    total += 1;
    if (arrival.getTime() <= windowEnd.getTime()) onTime += 1;
  }
  return { onTime, total, unverified };
}

/**
 * On-time pickup/delivery/firm-appt rates. On-time = the relevant leg's arrivalAt
 * ≤ the window end (mirrors the APPT_MISSED rule in load-alerts). Loads with no
 * arrival are UNVERIFIED — counted neither on-time nor missed, so cards read
 * "% of verified".
 */
export function computeReliabilityMetrics(loads: OpsLoadInput[]): ReliabilityMetrics {
  const deliveryArrival = (load: OpsLoadInput) => finalDeliveryLeg(load)?.arrivalAt ?? null;
  const pickupArrival = (load: OpsLoadInput) => sortedLegs(load)[0]?.arrivalAt ?? null;

  const otd = evaluateOnTime(loads, (l) => l.deliveryWindowEnd, deliveryArrival);
  const otp = evaluateOnTime(loads, (l) => l.pickupWindowEnd, pickupArrival);
  const firmLoads = loads.filter((l) => l.deliveryApptType === "FIRM_APPT");
  const firmAppt = evaluateOnTime(firmLoads, (l) => l.deliveryWindowEnd, deliveryArrival);

  return {
    otd,
    otp,
    firmAppt,
    missed: { missed: otd.total - otd.onTime, total: otd.total, unverified: otd.unverified }
  };
}

// ── 6. Disruption reason breakdown (cancel vs reschedule) ─────────────────────

export interface DisruptionReasonRow {
  reason: DisruptionReason;
  label: string;
  cancel: number;
  reschedule: number;
}

export interface DisruptionReasonBreakdown {
  reasons: DisruptionReasonRow[];
  totalCancel: number;
  totalReschedule: number;
  /** The earliest week we have any disruption data for (state reasons can't be backfilled). */
  trackedFromWeekIso: string | null;
}

export interface DisruptionGroupCount {
  kind: "CANCEL" | "RESCHEDULE";
  reason: DisruptionReason;
  count: number;
}

/**
 * Pairs cancel vs reschedule counts over the shared 9-reason taxonomy. Every
 * reason is returned in taxonomy order (the Phase-3 UI hides the zero rows).
 */
export function computeDisruptionReasonBreakdown(
  counts: DisruptionGroupCount[],
  trackedFromWeekIso: string | null
): DisruptionReasonBreakdown {
  const cancelByReason = new Map<DisruptionReason, number>();
  const rescheduleByReason = new Map<DisruptionReason, number>();
  let totalCancel = 0;
  let totalReschedule = 0;
  for (const c of counts) {
    if (c.kind === "CANCEL") {
      cancelByReason.set(c.reason, (cancelByReason.get(c.reason) ?? 0) + c.count);
      totalCancel += c.count;
    } else {
      rescheduleByReason.set(c.reason, (rescheduleByReason.get(c.reason) ?? 0) + c.count);
      totalReschedule += c.count;
    }
  }
  const reasons: DisruptionReasonRow[] = DISRUPTION_REASON_OPTIONS.map((opt) => ({
    reason: opt.value,
    label: disruptionReasonLabel(opt.value),
    cancel: cancelByReason.get(opt.value) ?? 0,
    reschedule: rescheduleByReason.get(opt.value) ?? 0
  }));
  return { reasons, totalCancel, totalReschedule, trackedFromWeekIso };
}

// ── 7. Week-over-week growth ──────────────────────────────────────────────────

export interface GrowthMetric {
  current: number;
  prior: number | null;
  pct: number | null;
}

export interface GrowthMetrics {
  loadCount: GrowthMetric;
  lineHaulRevenue: GrowthMetric;
}

function growth(current: number, prior: number | null): GrowthMetric {
  if (prior === null || prior === 0) {
    return { current, prior, pct: null };
  }
  return { current, prior, pct: round(((current - prior) / prior) * 100) };
}

/** WoW % change for load volume and line-haul revenue, from the already-fetched snapshots. */
export function computeGrowth(
  current: { loadCount: number; lineHaulRevenue: number | null },
  prior: { loadCount: number; lineHaulRevenue: number | null } | null
): GrowthMetrics {
  return {
    loadCount: growth(current.loadCount, prior ? prior.loadCount : null),
    lineHaulRevenue: growth(current.lineHaulRevenue ?? 0, prior ? prior.lineHaulRevenue ?? null : null)
  };
}
