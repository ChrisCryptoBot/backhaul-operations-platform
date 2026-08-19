import type { DatEquipment, DatRateType, MarketPerformanceBand } from "@prisma/client";
import { prisma } from "@/lib/db";
import { weekIsoFromPickup } from "@/lib/week";
import { computeVariance, getLaneMarketRate } from "@/server/dat/market-rate";
import { getRegionConfig } from "@/server/region-config";

// ── Market Variance tracker: persist + read the negotiation log ──────────────
// Each entry freezes the market snapshot at booking time so history stays accurate
// as the market moves. Weekly rollups + a current-vs-prior delta feed the tracker
// table and the executive brief (mirrors the Excel Market Variance tab).

export interface LogVarianceInput {
  regionId: string;
  actorId: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: DatEquipment;
  rateType: DatRateType;
  negotiatedTotal: number;
  /** The DAT market rate for the lane, total dollars. */
  marketTotal: number;
  /** Optional trip miles — only for per-mile derivation. */
  miles?: number;
  milesSource?: "dat" | "google" | "manual";
  loadId?: string | null;
  brokerId?: string | null;
  directCustomerId?: string | null;
  quoteId?: string | null;
  notes?: string | null;
}

export interface VarianceEntryDto {
  id: string;
  createdAt: string;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: DatEquipment;
  rateType: DatRateType;
  negotiatedTotal: number;
  negotiatedPerMile: number;
  miles: number;
  marketPerMile: number;
  marketTotal: number;
  variancePerMile: number;
  varianceTotal: number;
  variancePct: number;
  band: MarketPerformanceBand;
  notes: string | null;
}

/**
 * Idempotent auto-log: every ingested load with a full lane + positive rate/miles that
 * isn't already tracked gets a MarketVarianceEntry, deduped by loadId and dated by the
 * load's ingestion day (`createdAt`). Runs lazily when the tracker/KPI loads, so "all
 * ingested loads" flow into the variance history without touching load-creation paths.
 * Best-effort: a per-load failure (e.g. a DAT hiccup) is skipped, never thrown. Returns
 * the number of newly logged loads. Caps work per call to bound latency.
 */
export async function syncLoadVariance(regionId: string, maxNew = 150): Promise<number> {
  const logged = await prisma.marketVarianceEntry.findMany({
    where: { regionId, loadId: { not: null } },
    select: { loadId: true }
  });
  const loggedIds = new Set(logged.map((l) => l.loadId));

  const loads = await prisma.load.findMany({
    where: {
      regionId,
      deletedAt: null,
      pickupCity: { not: null },
      pickupState: { not: null },
      deliveryCity: { not: null },
      deliveryState: { not: null }
    },
    orderBy: { createdAt: "desc" },
    take: 600
  });

  const { marketVarianceBandPct } = await getRegionConfig(regionId);
  const threshold = marketVarianceBandPct / 100;

  let created = 0;
  for (const load of loads) {
    if (created >= maxNew) break;
    if (loggedIds.has(load.id)) continue;
    const originCity = load.pickupCity;
    const originState = load.pickupState;
    const destCity = load.deliveryCity;
    const destState = load.deliveryState;
    if (!originCity || !originState || !destCity || !destState) continue;
    const negotiatedTotal = Number(load.allInRevenue) || Number(load.lineHaulRate);
    const miles = Number(load.loadedMiles);
    if (!(negotiatedTotal > 0) || !(miles > 0)) continue;

    try {
      const quote = await getLaneMarketRate(regionId, {
        originCity,
        originState,
        destCity,
        destState,
        equipment: "VAN",
        rateType: "SPOT"
      });
      const marketTotal = quote.allInPerMile * miles;
      const v = computeVariance({ negotiatedTotal, marketTotal, miles }, threshold);
      await prisma.marketVarianceEntry.create({
        data: {
          regionId,
          createdById: "system-auto",
          originCity,
          originState,
          destCity,
          destState,
          equipment: "VAN",
          rateType: "SPOT",
          negotiatedTotal,
          negotiatedPerMile: v.negotiatedPerMile ?? 0,
          miles,
          milesSource: "manual",
          marketPerMile: v.marketPerMile ?? 0,
          marketTotal: v.marketTotal,
          variancePerMile: v.variancePerMile ?? 0,
          varianceTotal: v.varianceTotal,
          variancePct: v.variancePct,
          band: v.band,
          loadId: load.id,
          quoteId: quote.id,
          createdAt: load.createdAt, // dated by the day the load was ingested
          notes: "auto-logged from ingested load"
        }
      });
      created += 1;
    } catch {
      // Skip this load; a transient DAT/miles failure must not block the sync.
    }
  }
  return created;
}

export async function logMarketVariance(input: LogVarianceInput): Promise<VarianceEntryDto> {
  const { marketVarianceBandPct } = await getRegionConfig(input.regionId);
  const v = computeVariance(
    {
      negotiatedTotal: input.negotiatedTotal,
      marketTotal: input.marketTotal,
      miles: input.miles
    },
    marketVarianceBandPct / 100
  );

  const row = await prisma.marketVarianceEntry.create({
    data: {
      regionId: input.regionId,
      createdById: input.actorId,
      originCity: input.originCity.trim(),
      originState: input.originState.trim().toUpperCase(),
      destCity: input.destCity.trim(),
      destState: input.destState.trim().toUpperCase(),
      equipment: input.equipment,
      rateType: input.rateType,
      negotiatedTotal: input.negotiatedTotal,
      negotiatedPerMile: v.negotiatedPerMile ?? 0,
      miles: input.miles ?? 0,
      milesSource: input.milesSource ?? "manual",
      marketPerMile: v.marketPerMile ?? 0,
      marketTotal: v.marketTotal,
      variancePerMile: v.variancePerMile ?? 0,
      varianceTotal: v.varianceTotal,
      variancePct: v.variancePct,
      band: v.band,
      loadId: input.loadId ?? null,
      brokerId: input.brokerId ?? null,
      directCustomerId: input.directCustomerId ?? null,
      quoteId: input.quoteId ?? null,
      notes: input.notes ?? null
    }
  });

  return toDto(row);
}

export interface PeriodRollup {
  /** ISO week ("2026-W34") for weekly, or ISO date ("2026-08-18") for daily. */
  period: string;
  entryCount: number;
  negotiatedTotal: number;
  marketTotal: number;
  varianceTotal: number;
  /** Portfolio variance % for the period = Σvariance ÷ Σmarket. */
  variancePct: number;
  aboveCount: number;
  atCount: number;
  belowCount: number;
}

export interface VarianceLogView {
  entries: VarianceEntryDto[];
  weekly: PeriodRollup[];
  daily: PeriodRollup[];
  /** Configured ± band as a whole percent (e.g. 10), so clients classify live the same way. */
  bandPct: number;
  /** Executive-brief delta: current week vs the prior week. */
  brief: {
    currentWeek: PeriodRollup | null;
    priorWeek: PeriodRollup | null;
    revenueDelta: number;
    revenueDeltaPct: number | null;
    volumeDelta: number;
  } | null;
}

export async function listMarketVariance(regionId: string, limit = 500): Promise<VarianceLogView> {
  const [rows, config] = await Promise.all([
    prisma.marketVarianceEntry.findMany({
      where: { regionId },
      orderBy: { createdAt: "desc" },
      take: limit
    }),
    getRegionConfig(regionId)
  ]);
  const entries = rows.map(toDto);
  const weekly = rollupByPeriod(rows, "week");
  const daily = rollupByPeriod(rows, "day");
  return { entries, weekly, daily, bandPct: config.marketVarianceBandPct, brief: buildBrief(weekly) };
}

function periodKey(date: Date, unit: "day" | "week"): string {
  if (unit === "week") return weekIsoFromPickup(date);
  return date.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

function rollupByPeriod(rows: Array<Parameters<typeof toDto>[0]>, unit: "day" | "week"): PeriodRollup[] {
  const byPeriod = new Map<string, PeriodRollup>();
  for (const row of rows) {
    const period = periodKey(row.createdAt, unit);
    const acc =
      byPeriod.get(period) ??
      {
        period,
        entryCount: 0,
        negotiatedTotal: 0,
        marketTotal: 0,
        varianceTotal: 0,
        variancePct: 0,
        aboveCount: 0,
        atCount: 0,
        belowCount: 0
      };
    acc.entryCount += 1;
    acc.negotiatedTotal += Number(row.negotiatedTotal);
    acc.marketTotal += Number(row.marketTotal);
    acc.varianceTotal += Number(row.varianceTotal);
    if (row.band === "ABOVE") acc.aboveCount += 1;
    else if (row.band === "BELOW") acc.belowCount += 1;
    else acc.atCount += 1;
    byPeriod.set(period, acc);
  }
  const periods = [...byPeriod.values()].map((p) => ({
    ...p,
    negotiatedTotal: round2(p.negotiatedTotal),
    marketTotal: round2(p.marketTotal),
    varianceTotal: round2(p.varianceTotal),
    variancePct: p.marketTotal !== 0 ? Number((p.varianceTotal / p.marketTotal).toFixed(4)) : 0
  }));
  // Most recent period first.
  return periods.sort((a, b) => (a.period < b.period ? 1 : -1));
}

function buildBrief(weekly: PeriodRollup[]): VarianceLogView["brief"] {
  if (weekly.length === 0) return null;
  const currentWeek = weekly[0] ?? null;
  const priorWeek = weekly[1] ?? null;
  const revenueDelta = round2((currentWeek?.negotiatedTotal ?? 0) - (priorWeek?.negotiatedTotal ?? 0));
  const revenueDeltaPct =
    priorWeek && priorWeek.negotiatedTotal !== 0
      ? Number((revenueDelta / priorWeek.negotiatedTotal).toFixed(4))
      : null;
  const volumeDelta = (currentWeek?.entryCount ?? 0) - (priorWeek?.entryCount ?? 0);
  return { currentWeek, priorWeek, revenueDelta, revenueDeltaPct, volumeDelta };
}

function toDto(row: {
  id: string;
  createdAt: Date;
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: DatEquipment;
  rateType: DatRateType;
  negotiatedTotal: unknown;
  negotiatedPerMile: unknown;
  miles: unknown;
  marketPerMile: unknown;
  marketTotal: unknown;
  variancePerMile: unknown;
  varianceTotal: unknown;
  variancePct: unknown;
  band: MarketPerformanceBand;
  notes: string | null;
}): VarianceEntryDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    originCity: row.originCity,
    originState: row.originState,
    destCity: row.destCity,
    destState: row.destState,
    equipment: row.equipment,
    rateType: row.rateType,
    negotiatedTotal: Number(row.negotiatedTotal),
    negotiatedPerMile: Number(row.negotiatedPerMile),
    miles: Number(row.miles),
    marketPerMile: Number(row.marketPerMile),
    marketTotal: Number(row.marketTotal),
    variancePerMile: Number(row.variancePerMile),
    varianceTotal: Number(row.varianceTotal),
    variancePct: Number(row.variancePct),
    band: row.band,
    notes: row.notes
  };
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}
