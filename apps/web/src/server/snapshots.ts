import { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAuditLog } from "@/lib/audit";
import { safeDivideDecimal } from "@/lib/decimal-utils";
import { computeWeekSnapshotTotals, diffWeekSnapshotTotals, type PureWeekSnapshotTotals } from "@/domain/kpi/pure";

function decimalField(load: Record<string, unknown>, key: string): Prisma.Decimal {
  const value = load[key];
  if (value instanceof Prisma.Decimal) {
    return value;
  }
  if (typeof value === "number" || typeof value === "string") {
    return new Prisma.Decimal(value);
  }
  return new Prisma.Decimal(0);
}

function computeLegacyTotals(rawLoads: Array<{
  status: string;
  lineHaulRate: Prisma.Decimal;
  fscAmount: Prisma.Decimal;
  loadedMiles: Prisma.Decimal;
  puDeadheadMiles: Prisma.Decimal;
  delDeadheadMiles: Prisma.Decimal;
} & Record<string, unknown>>): PureWeekSnapshotTotals {
  const loads = rawLoads.filter((load) => {
    const totalTripMiles = load.loadedMiles.plus(load.puDeadheadMiles).plus(load.delDeadheadMiles);
    const hasMovement = totalTripMiles.greaterThan(0);
    const hasFinancialImpact = load.lineHaulRate.plus(load.fscAmount).plus(decimalField(load, "tonuAmount")).greaterThan(0);
    if ((load as { status?: string }).status === "CANCELED" || (load as { status?: string }).status === "FAILED") {
      return hasMovement || hasFinancialImpact;
    }
    return true;
  });

  const lineHaulRevenue = loads.reduce((acc, load) => acc.plus(load.lineHaulRate), new Prisma.Decimal(0));
  const fuelSurchargeAmount = loads.reduce((acc, load) => acc.plus(load.fscAmount), new Prisma.Decimal(0));
  const totalTonuAmount = loads.reduce((acc, load) => acc.plus(decimalField(load, "tonuAmount")), new Prisma.Decimal(0));
  const totalAllInRevenue = loads.reduce(
    (acc, load) =>
      acc.plus(
        decimalField(load, "allInRevenue").equals(0)
          ? load.lineHaulRate.plus(load.fscAmount).plus(decimalField(load, "tonuAmount"))
          : decimalField(load, "allInRevenue")
      ),
    new Prisma.Decimal(0)
  );
  const totalLoadedMiles = loads.reduce((acc, load) => acc.plus(load.loadedMiles), new Prisma.Decimal(0));
  const totalPickupDeadhead = loads.reduce((acc, load) => acc.plus(load.puDeadheadMiles), new Prisma.Decimal(0));
  const totalDeliveryDeadhead = loads.reduce((acc, load) => acc.plus(load.delDeadheadMiles), new Prisma.Decimal(0));
  const totalEmptyMiles = totalPickupDeadhead.plus(totalDeliveryDeadhead);
  const totalTripMiles = totalLoadedMiles.plus(totalEmptyMiles);
  const emptyMilePct = safeDivideDecimal(totalEmptyMiles, totalTripMiles);
  const inboundRevenue = new Prisma.Decimal(0);
  const inboundLoadedMiles = new Prisma.Decimal(0);
  const mileMaxRpm = safeDivideDecimal(lineHaulRevenue, totalLoadedMiles.plus(totalPickupDeadhead));
  const nby = safeDivideDecimal(lineHaulRevenue, totalTripMiles);

  return {
    loadCount: loads.length,
    lineHaulRevenue,
    fuelSurchargeAmount,
    totalLoadedMiles,
    totalPickupDeadhead,
    totalDeliveryDeadhead,
    totalEmptyMiles,
    totalTripMiles,
    emptyMilePct,
    totalAllInRevenue,
    totalTonuAmount,
    inboundRevenue,
    inboundLoadedMiles,
    mileMaxMissingInbound: true,
    mileMaxRpm,
    nby
  };
}

async function recomputeWithClient(
  tx: Prisma.TransactionClient | PrismaClient,
  regionId: string,
  weekIso: string,
  actorId: string
): Promise<void> {
    const existing = await tx.weekSnapshot.findUnique({
      where: {
        regionId_weekIso: {
          regionId,
          weekIso
        }
      }
    });

    const inboundRevenue = existing?.inboundRevenue ?? new Prisma.Decimal(0);
    const inboundLoadedMiles = existing?.inboundLoadedMiles ?? new Prisma.Decimal(0);

    const rawLoads = await tx.load.findMany({
      where: {
        regionId,
        weekIso,
        deletedAt: null
      },
      select: {
        status: true,
        lineHaulRate: true,
        fscAmount: true,
        tonuAmount: true,
        allInRevenue: true,
        loadedMiles: true,
        puDeadheadMiles: true,
        delDeadheadMiles: true
      }
    });
    const semanticTotals = computeWeekSnapshotTotals(
      rawLoads.map((load) => ({
        status: load.status,
        lineHaulRate: load.lineHaulRate,
        fscAmount: load.fscAmount,
        tonuAmount: decimalField(load as unknown as Record<string, unknown>, "tonuAmount"),
        allInRevenue: decimalField(load as unknown as Record<string, unknown>, "allInRevenue"),
        loadedMiles: load.loadedMiles,
        pickupDeadhead: load.puDeadheadMiles,
        deliveryDeadhead: load.delDeadheadMiles
      })),
      {
        inboundRevenue,
        inboundLoadedMiles
      }
    );
    const legacyTotals = computeLegacyTotals(rawLoads);
    const parityDiffs = diffWeekSnapshotTotals(legacyTotals, semanticTotals);
    if (parityDiffs.length > 0) {
      await tx.auditLog.create({
        data: createAuditLog({
          entityType: "WeekSnapshot",
          entityId: `${regionId}:${weekIso}`,
          action: "PARITY_DIFF_DETECTED",
          actorId,
          timestamp: new Date(),
          afterValue: parityDiffs as unknown as Prisma.InputJsonValue
        })
      });
      if (process.env.REQUIRE_KPI_PARITY_ZERO_DIFF === "true") {
        throw new Error("Shadow parity mismatch detected for week snapshot recompute");
      }
    }

    if (!existing) {
      // See note in review.ts re: narrow cast at Prisma boundary.
      const createData = {
        regionId,
        weekIso,
        loadCount: semanticTotals.loadCount,
        lineHaulRevenue: semanticTotals.lineHaulRevenue,
        fuelSurchargeAmount: semanticTotals.fuelSurchargeAmount,
        totalLoadedMiles: semanticTotals.totalLoadedMiles,
        totalPickupDeadhead: semanticTotals.totalPickupDeadhead,
        totalDeliveryDeadhead: semanticTotals.totalDeliveryDeadhead,
        totalEmptyMiles: semanticTotals.totalEmptyMiles,
        totalTripMiles: semanticTotals.totalTripMiles,
        emptyMilePct: semanticTotals.emptyMilePct,
        totalAllInRevenue: semanticTotals.totalAllInRevenue,
        totalTonuAmount: semanticTotals.totalTonuAmount,
        inboundRevenue: semanticTotals.inboundRevenue,
        inboundLoadedMiles: semanticTotals.inboundLoadedMiles,
        mileMaxMissingInbound: semanticTotals.mileMaxMissingInbound,
        mileMaxRpm: semanticTotals.mileMaxRpm
      } as Prisma.WeekSnapshotUncheckedCreateInput;

      await tx.weekSnapshot.create({
        data: createData
      });
      return;
    }

    if (existing.lockedAt) {
      await tx.auditLog.create({
        data: createAuditLog({
          entityType: "WeekSnapshot",
          entityId: existing.id,
          action: "UPDATE_BLOCKED",
          actorId,
          timestamp: new Date(),
          reason: "WeekSnapshot is immutable once lockedAt is set"
        })
      })
      throw new Error("WeekSnapshot is immutable");
    }

    const updateData = {
      loadCount: semanticTotals.loadCount,
      lineHaulRevenue: semanticTotals.lineHaulRevenue,
      fuelSurchargeAmount: semanticTotals.fuelSurchargeAmount,
      totalLoadedMiles: semanticTotals.totalLoadedMiles,
      totalPickupDeadhead: semanticTotals.totalPickupDeadhead,
      totalDeliveryDeadhead: semanticTotals.totalDeliveryDeadhead,
      totalEmptyMiles: semanticTotals.totalEmptyMiles,
      totalTripMiles: semanticTotals.totalTripMiles,
      emptyMilePct: semanticTotals.emptyMilePct,
      totalAllInRevenue: semanticTotals.totalAllInRevenue,
      totalTonuAmount: semanticTotals.totalTonuAmount,
      inboundRevenue: semanticTotals.inboundRevenue,
      inboundLoadedMiles: semanticTotals.inboundLoadedMiles,
      mileMaxMissingInbound: semanticTotals.mileMaxMissingInbound,
      mileMaxRpm: semanticTotals.mileMaxRpm,
      computedAt: new Date()
    } as Prisma.WeekSnapshotUncheckedUpdateInput;

    await tx.weekSnapshot.update({
      where: { id: existing.id },
      data: updateData
    });
}

export async function recomputeWeekSnapshot(
  regionId: string,
  weekIso: string,
  actorId: string,
  db?: PrismaClient | Prisma.TransactionClient
): Promise<void> {
  if (db) {
    await recomputeWithClient(db, regionId, weekIso, actorId);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await recomputeWithClient(tx, regionId, weekIso, actorId);
  });
}
