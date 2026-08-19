import type { DatEquipment, DatRateType, MarketPerformanceBand } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getRoadMiles } from "@/server/distance";
import { resolveDatProvider, type LaneRateResult } from "@/server/dat/provider";

// ── Market-rate orchestration ────────────────────────────────────────────────
// Cache-aware lane lookups + the revenue-side variance math that powers the
// negotiation widget and the persisted tracker. We are the carrier, so a
// negotiated rate ABOVE market is the win (band ABOVE = 🟢).

/** Cached quotes older than this are re-fetched (and flagged stale in the UI). */
export const QUOTE_TTL_HOURS = 12;
/** ± band around market that counts as "at market" before flagging above/below. */
export const BAND_THRESHOLD = 0.1;

export interface LaneKey {
  originCity: string;
  originState: string;
  destCity: string;
  destState: string;
  equipment: DatEquipment;
  rateType: DatRateType;
}

export interface MarketQuote extends LaneRateResult {
  /** Cache-row id, so a logged variance entry can link back to the source quote. */
  id: string;
  /** All-in per mile = line-haul avg + fuel surcharge (0 when unknown). */
  allInPerMile: number;
  fetchedAt: string;
  isStale: boolean;
  isMock: boolean;
}

function normalizeLane(input: LaneKey): LaneKey {
  return {
    originCity: input.originCity.trim(),
    originState: input.originState.trim().toUpperCase(),
    destCity: input.destCity.trim(),
    destState: input.destState.trim().toUpperCase(),
    equipment: input.equipment,
    rateType: input.rateType
  };
}

function toMarketQuote(row: {
  id: string;
  ratePerMileLow: unknown;
  ratePerMileAvg: unknown;
  ratePerMileHigh: unknown;
  fuelPerMile: unknown;
  mileage: unknown;
  reportCount: number | null;
  timeframe: string | null;
  source: string;
  fetchedAt: Date;
}): MarketQuote {
  const avg = Number(row.ratePerMileAvg);
  const fuel = row.fuelPerMile == null ? null : Number(row.fuelPerMile);
  const ageMs = Date.now() - row.fetchedAt.getTime();
  return {
    id: row.id,
    ratePerMileLow: Number(row.ratePerMileLow),
    ratePerMileAvg: avg,
    ratePerMileHigh: Number(row.ratePerMileHigh),
    fuelPerMile: fuel,
    mileage: row.mileage == null ? null : Number(row.mileage),
    reportCount: row.reportCount,
    timeframe: row.timeframe,
    source: row.source === "dat" ? "dat" : "mock",
    allInPerMile: Number((avg + (fuel ?? 0)).toFixed(4)),
    fetchedAt: row.fetchedAt.toISOString(),
    isStale: ageMs > QUOTE_TTL_HOURS * 3_600_000,
    isMock: row.source !== "dat"
  };
}

/**
 * Returns the market rate for a lane, served from the cache when fresh, otherwise
 * fetched from DAT (or the mock), enriched with road miles when available, and
 * upserted. `forceRefresh` bypasses the cache (the UI "refresh" button).
 */
export async function getLaneMarketRate(
  regionId: string,
  laneInput: LaneKey,
  options: { forceRefresh?: boolean } = {}
): Promise<MarketQuote> {
  const lane = normalizeLane(laneInput);
  const where = {
    regionId_originCity_originState_destCity_destState_equipment_rateType: {
      regionId,
      originCity: lane.originCity,
      originState: lane.originState,
      destCity: lane.destCity,
      destState: lane.destState,
      equipment: lane.equipment,
      rateType: lane.rateType
    }
  };

  if (!options.forceRefresh) {
    const cached = await prisma.marketRateQuote.findUnique({ where });
    if (cached && Date.now() - cached.fetchedAt.getTime() <= QUOTE_TTL_HOURS * 3_600_000) {
      return toMarketQuote(cached);
    }
  }

  const provider = await resolveDatProvider();
  const result = await provider.getLaneRate(lane);

  // Enrich with practical road miles when the provider didn't supply them.
  let mileage = result.mileage;
  if (mileage == null) {
    const road = await getRoadMiles({
      originCity: lane.originCity,
      originState: lane.originState,
      destCity: lane.destCity,
      destState: lane.destState
    });
    mileage = road.miles;
  }

  const now = new Date();
  const row = await prisma.marketRateQuote.upsert({
    where,
    create: {
      regionId,
      ...lane,
      ratePerMileLow: result.ratePerMileLow,
      ratePerMileAvg: result.ratePerMileAvg,
      ratePerMileHigh: result.ratePerMileHigh,
      fuelPerMile: result.fuelPerMile,
      mileage,
      reportCount: result.reportCount,
      timeframe: result.timeframe,
      source: result.source,
      fetchedAt: now
    },
    update: {
      ratePerMileLow: result.ratePerMileLow,
      ratePerMileAvg: result.ratePerMileAvg,
      ratePerMileHigh: result.ratePerMileHigh,
      fuelPerMile: result.fuelPerMile,
      mileage,
      reportCount: result.reportCount,
      timeframe: result.timeframe,
      source: result.source,
      fetchedAt: now
    }
  });

  return toMarketQuote(row);
}

// ── Variance math (revenue side) ─────────────────────────────────────────────

export interface VarianceInput {
  /** Our negotiated payout, total dollars. */
  negotiatedTotal: number;
  /** The DAT market rate for the lane, total dollars. */
  marketTotal: number;
  /** Optional trip miles — only used to derive per-mile figures. NOT required. */
  miles?: number;
}

export interface VarianceResult {
  negotiatedTotal: number;
  marketTotal: number;
  varianceTotal: number;
  /** Signed fraction: +0.12 = we're 12% above market. */
  variancePct: number;
  band: MarketPerformanceBand;
  /** Per-mile figures — null when trip miles weren't supplied (total-only entry). */
  negotiatedPerMile: number | null;
  marketPerMile: number | null;
  variancePerMile: number | null;
}

export function classifyBand(variancePct: number, threshold: number = BAND_THRESHOLD): MarketPerformanceBand {
  if (variancePct > threshold) return "ABOVE";
  if (variancePct < -threshold) return "BELOW";
  return "AT";
}

/**
 * Revenue-side variance straight from the two totals (the Excel model): Dollar Variance
 * = negotiated − market, % = variance ÷ market, then the band. Trip miles are optional
 * and only used to derive per-mile figures — they are NOT needed for the variance.
 */
export function computeVariance(input: VarianceInput, threshold: number = BAND_THRESHOLD): VarianceResult {
  const varianceTotal = input.negotiatedTotal - input.marketTotal;
  const variancePct = input.marketTotal !== 0 ? varianceTotal / input.marketTotal : 0;
  const miles = input.miles && input.miles > 0 ? input.miles : null;
  const negotiatedPerMile = miles ? input.negotiatedTotal / miles : null;
  const marketPerMile = miles ? input.marketTotal / miles : null;
  return {
    negotiatedTotal: round4(input.negotiatedTotal),
    marketTotal: round4(input.marketTotal),
    varianceTotal: round4(varianceTotal),
    variancePct: round4(variancePct),
    band: classifyBand(variancePct, threshold),
    negotiatedPerMile: negotiatedPerMile === null ? null : round4(negotiatedPerMile),
    marketPerMile: marketPerMile === null ? null : round4(marketPerMile),
    variancePerMile:
      negotiatedPerMile === null || marketPerMile === null ? null : round4(negotiatedPerMile - marketPerMile)
  };
}

function round4(n: number): number {
  return Number(n.toFixed(4));
}
