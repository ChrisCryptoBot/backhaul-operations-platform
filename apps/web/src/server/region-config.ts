import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";

export const DEFAULT_EMPTY_PCT_AMBER = 15;
export const DEFAULT_EMPTY_PCT_RED = 25;
/** Aggregate weekly empty-mile % that fires the KPI dashboard alert (distinct from the per-load board colors). */
export const DEFAULT_EMPTY_PCT_ALERT = 6.5;

/** Per-region board tunables (Empty% color thresholds + the dashboard empty-mile alert, as whole percents). */
export interface RegionThresholds {
  emptyPctAmber: number;
  emptyPctRed: number;
  emptyPctAlert: number;
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
      emptyPctAlert: DEFAULT_EMPTY_PCT_ALERT
    };
  }
  return {
    emptyPctAmber: row.emptyPctAmber.toNumber(),
    emptyPctRed: row.emptyPctRed.toNumber(),
    emptyPctAlert: row.emptyPctAlert.toNumber()
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

  const nextAmber = isProvided(input.emptyPctAmber) ? toThresholdDecimal(input.emptyPctAmber, "amber") : currentAmber;
  const nextRed = isProvided(input.emptyPctRed) ? toThresholdDecimal(input.emptyPctRed, "red") : currentRed;
  const nextAlert = isProvided(input.emptyPctAlert) ? toThresholdDecimal(input.emptyPctAlert, "alert") : currentAlert;

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

  const row = await db.regionConfig.upsert({
    where: { regionId: input.regionId },
    create: {
      regionId: input.regionId,
      emptyPctAmber: nextAmber,
      emptyPctRed: nextRed,
      emptyPctAlert: nextAlert,
      updatedById: input.actorId
    },
    update: {
      emptyPctAmber: nextAmber,
      emptyPctRed: nextRed,
      emptyPctAlert: nextAlert,
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
            emptyPctAlert: currentAlert.toString()
          }
        : Prisma.JsonNull,
      afterValue: {
        emptyPctAmber: row.emptyPctAmber.toString(),
        emptyPctRed: row.emptyPctRed.toString(),
        emptyPctAlert: row.emptyPctAlert.toString()
      }
    })
  });

  return {
    emptyPctAmber: row.emptyPctAmber.toNumber(),
    emptyPctRed: row.emptyPctRed.toNumber(),
    emptyPctAlert: row.emptyPctAlert.toNumber()
  };
}
