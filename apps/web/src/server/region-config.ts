import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";

export const DEFAULT_EMPTY_PCT_AMBER = 15;
export const DEFAULT_EMPTY_PCT_RED = 25;
/** Aggregate weekly empty-mile % that fires the KPI dashboard alert (distinct from the per-load board colors). */
export const DEFAULT_EMPTY_PCT_ALERT = 6.5;
/** Target on-time % for the reliability bullet cards (target line + pass/fail). */
export const DEFAULT_ON_TIME_TARGET_PCT = 95;
/** ± band (whole percent) around DAT market before a negotiation flags above/below. */
export const DEFAULT_MARKET_VARIANCE_BAND_PCT = 10;

/** Per-region board tunables (Empty% color thresholds + the dashboard empty-mile alert, as whole percents). */
export interface RegionThresholds {
  emptyPctAmber: number;
  emptyPctRed: number;
  emptyPctAlert: number;
  onTimeTargetPct: number;
  marketVarianceBandPct: number;
}

export class RegionConfigValidationError extends Error {}

export async function getRegionConfig(
  regionId: string,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<RegionThresholds> {
  const row = await db.regionConfig.findUnique({ where: { regionId } });
  if (!row) {
    return {
      emptyPctAmber: DEFAULT_EMPTY_PCT_AMBER,
      emptyPctRed: DEFAULT_EMPTY_PCT_RED,
      emptyPctAlert: DEFAULT_EMPTY_PCT_ALERT,
      onTimeTargetPct: DEFAULT_ON_TIME_TARGET_PCT,
      marketVarianceBandPct: DEFAULT_MARKET_VARIANCE_BAND_PCT
    };
  }
  return {
    emptyPctAmber: row.emptyPctAmber.toNumber(),
    emptyPctRed: row.emptyPctRed.toNumber(),
    emptyPctAlert: row.emptyPctAlert.toNumber(),
    onTimeTargetPct: row.onTimeTargetPct.toNumber(),
    marketVarianceBandPct: row.marketVarianceBandPct.toNumber()
  };
}

export interface UpdateRegionConfigInput {
  actorId: string;
  regionId: string;
  /** Whole percent (e.g. 15). Omit/null/"" keeps the current value. */
  emptyPctAmber?: number | string | null;
  emptyPctRed?: number | string | null;
  /** Aggregate weekly empty-mile % that fires the dashboard alert (e.g. 6.5). */
  emptyPctAlert?: number | string | null;
  /** Target on-time % for the reliability cards (e.g. 95). */
  onTimeTargetPct?: number | string | null;
  /** ± market-variance band, whole percent (e.g. 10). */
  marketVarianceBandPct?: number | string | null;
  reason?: string;
}

function toThresholdDecimal(value: number | string, field: string): Prisma.Decimal {
  try {
    return new Prisma.Decimal(value);
  } catch {
    throw new RegionConfigValidationError(`Invalid ${field} threshold.`);
  }
}

function isProvided(value: number | string | null | undefined): value is number | string {
  return value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
}

/**
 * Upsert the region's board thresholds and write an audit entry. Validates
 * `0 < amber < red <= 100` with Decimal math (no float coercion).
 */
export async function updateRegionConfig(
  input: UpdateRegionConfigInput,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<RegionThresholds> {
  const existing = await db.regionConfig.findUnique({ where: { regionId: input.regionId } });
  const currentAmber = existing ? existing.emptyPctAmber : new Prisma.Decimal(DEFAULT_EMPTY_PCT_AMBER);
  const currentRed = existing ? existing.emptyPctRed : new Prisma.Decimal(DEFAULT_EMPTY_PCT_RED);
  const currentAlert = existing ? existing.emptyPctAlert : new Prisma.Decimal(DEFAULT_EMPTY_PCT_ALERT);
  const currentOnTime = existing ? existing.onTimeTargetPct : new Prisma.Decimal(DEFAULT_ON_TIME_TARGET_PCT);
  const currentBand = existing ? existing.marketVarianceBandPct : new Prisma.Decimal(DEFAULT_MARKET_VARIANCE_BAND_PCT);

  const nextAmber = isProvided(input.emptyPctAmber) ? toThresholdDecimal(input.emptyPctAmber, "amber") : currentAmber;
  const nextRed = isProvided(input.emptyPctRed) ? toThresholdDecimal(input.emptyPctRed, "red") : currentRed;
  const nextAlert = isProvided(input.emptyPctAlert) ? toThresholdDecimal(input.emptyPctAlert, "alert") : currentAlert;
  const nextOnTime = isProvided(input.onTimeTargetPct) ? toThresholdDecimal(input.onTimeTargetPct, "onTimeTarget") : currentOnTime;
  const nextBand = isProvided(input.marketVarianceBandPct) ? toThresholdDecimal(input.marketVarianceBandPct, "marketVarianceBand") : currentBand;

  if (
    nextAmber.lessThanOrEqualTo(0) ||
    nextRed.greaterThan(100) ||
    nextAmber.greaterThanOrEqualTo(nextRed)
  ) {
    throw new RegionConfigValidationError("Thresholds must satisfy 0 < amber < red <= 100.");
  }
  if (nextAlert.lessThanOrEqualTo(0) || nextAlert.greaterThan(100)) {
    throw new RegionConfigValidationError("Empty-mile alert threshold must satisfy 0 < alert <= 100.");
  }
  if (nextOnTime.lessThanOrEqualTo(0) || nextOnTime.greaterThan(100)) {
    throw new RegionConfigValidationError("On-time target must satisfy 0 < target <= 100.");
  }
  if (nextBand.lessThanOrEqualTo(0) || nextBand.greaterThan(50)) {
    throw new RegionConfigValidationError("Market-variance band must satisfy 0 < band <= 50.");
  }

  const row = await db.regionConfig.upsert({
    where: { regionId: input.regionId },
    create: {
      regionId: input.regionId,
      emptyPctAmber: nextAmber,
      emptyPctRed: nextRed,
      emptyPctAlert: nextAlert,
      onTimeTargetPct: nextOnTime,
      marketVarianceBandPct: nextBand,
      updatedById: input.actorId
    },
    update: {
      emptyPctAmber: nextAmber,
      emptyPctRed: nextRed,
      emptyPctAlert: nextAlert,
      onTimeTargetPct: nextOnTime,
      marketVarianceBandPct: nextBand,
      updatedById: input.actorId
    }
  });

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "RegionConfig",
      entityId: row.id,
      action: existing ? "UPDATE" : "CREATE",
      actorId: input.actorId,
      timestamp: new Date(),
      reason: input.reason,
      beforeValue: existing
        ? {
            emptyPctAmber: currentAmber.toString(),
            emptyPctRed: currentRed.toString(),
            emptyPctAlert: currentAlert.toString(),
            onTimeTargetPct: currentOnTime.toString(),
            marketVarianceBandPct: currentBand.toString()
          }
        : Prisma.JsonNull,
      afterValue: {
        emptyPctAmber: row.emptyPctAmber.toString(),
        emptyPctRed: row.emptyPctRed.toString(),
        emptyPctAlert: row.emptyPctAlert.toString(),
        onTimeTargetPct: row.onTimeTargetPct.toString(),
        marketVarianceBandPct: row.marketVarianceBandPct.toString()
      }
    })
  });

  return {
    emptyPctAmber: row.emptyPctAmber.toNumber(),
    emptyPctRed: row.emptyPctRed.toNumber(),
    emptyPctAlert: row.emptyPctAlert.toNumber(),
    onTimeTargetPct: row.onTimeTargetPct.toNumber(),
    marketVarianceBandPct: row.marketVarianceBandPct.toNumber()
  };
}
