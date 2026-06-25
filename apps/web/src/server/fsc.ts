import { FuelSurchargeSource, Prisma, PrismaClient } from "@prisma/client";
import { type AccessContext } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { PolicyViolationError } from "@/lib/policy-error";

export async function upsertFscIndex(input: {
  ctx: AccessContext;
  regionId: string;
  weekIso: string;
  value: Prisma.Decimal;
  reason: string;
  source: FuelSurchargeSource;
  db?: PrismaClient | Prisma.TransactionClient;
}): Promise<void> {
  const db = input.db ?? prisma;
  if (input.ctx.regionId !== input.regionId) {
    throw new PolicyViolationError("Cross-region FSC write not permitted");
  }
  if (input.source === "manual_override") {
    if (input.ctx.role !== "REGIONAL_MANAGER" && input.ctx.role !== "ADMIN") {
      throw new PolicyViolationError("Only REGIONAL_MANAGER or ADMIN can create FSC overrides");
    }
  } else if (
    input.ctx.role !== "COORDINATOR" &&
    input.ctx.role !== "REGIONAL_MANAGER" &&
    input.ctx.role !== "ADMIN"
  ) {
    throw new PolicyViolationError("Only COORDINATOR, REGIONAL_MANAGER, or ADMIN can perform Tuesday FSC updates");
  }

  const previous = await db.fuelSurchargeIndex.findFirst({
    where: {
      regionId: input.regionId,
      weekIso: input.weekIso
    },
    orderBy: {
      effectiveAt: "desc"
    }
  });

  let persistedRow:
    | {
        id: string;
      }
    | undefined;
  let action: "CREATE_TUESDAY" | "UPDATE_TUESDAY" | "CREATE_OVERRIDE";

  if (input.source === FuelSurchargeSource.manual_tuesday) {
    const existingTuesday = await db.fuelSurchargeIndex.findFirst({
      where: {
        regionId: input.regionId,
        weekIso: input.weekIso,
        source: FuelSurchargeSource.manual_tuesday
      },
      orderBy: { effectiveAt: "desc" }
    });
    if (existingTuesday) {
      persistedRow = await db.fuelSurchargeIndex.update({
        where: { id: existingTuesday.id },
        data: {
          value: input.value,
          effectiveAt: new Date(),
          updatedByUserId: input.ctx.userId,
          updateReason: input.reason
        }
      });
      action = "UPDATE_TUESDAY";
    } else {
      persistedRow = await db.fuelSurchargeIndex.create({
        data: {
          regionId: input.regionId,
          weekIso: input.weekIso,
          value: input.value,
          source: input.source,
          effectiveAt: new Date(),
          updatedByUserId: input.ctx.userId,
          updateReason: input.reason
        }
      });
      action = "CREATE_TUESDAY";
    }
  } else {
    persistedRow = await db.fuelSurchargeIndex.create({
      data: {
        regionId: input.regionId,
        weekIso: input.weekIso,
        value: input.value,
        source: input.source,
        effectiveAt: new Date(),
        updatedByUserId: input.ctx.userId,
        updateReason: input.reason
      }
    });
    action = "CREATE_OVERRIDE";
  }
  if (!persistedRow) {
    throw new Error("Failed to persist FSC row");
  }

  await db.auditLog.create({
    data: createAuditLog({
      entityType: "FuelSurchargeIndex",
      entityId: persistedRow.id,
      action,
      actorId: input.ctx.userId,
      timestamp: new Date(),
      reason: `${input.regionId}:${input.weekIso} ${input.reason}`,
      beforeValue: previous
        ? {
            value: previous.value.toString(),
            source: previous.source
          }
        : Prisma.JsonNull,
      afterValue: {
        value: input.value.toString(),
        source: input.source
      }
    })
  });
}

export async function getEffectiveFscRate(
  regionId: string,
  weekIso: string,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<Prisma.Decimal | null> {
  const latest = await db.fuelSurchargeIndex.findFirst({
    where: { regionId, weekIso },
    orderBy: { effectiveAt: "desc" }
  });
  return latest?.value ?? null;
}

export async function assertWeekHasTuesdayFsc(
  regionId: string,
  weekIso: string,
  db: PrismaClient | Prisma.TransactionClient = prisma
): Promise<void> {
  const row = await db.fuelSurchargeIndex.findFirst({
    where: {
      regionId,
      weekIso,
      source: FuelSurchargeSource.manual_tuesday
    },
    orderBy: { effectiveAt: "desc" }
  });
  if (!row) {
    throw new Error("Tuesday FSC entry is required before confirming FSC-applicable loads");
  }
}
