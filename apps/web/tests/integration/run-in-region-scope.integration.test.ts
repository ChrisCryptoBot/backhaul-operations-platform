import { FuelSurchargeSource, ParseState, Prisma, Role } from "@prisma/client";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { prisma, runInRegionScope } from "@/lib/db";
import { createLoadFromReview } from "@/server/review";
import { recomputeWeekSnapshot } from "@/server/snapshots";

vi.mock("@/server/queue", () => ({
  enqueueJob: vi.fn().mockResolvedValue(undefined)
}));

const runDbIntegration = process.env.RUN_DB_INTEGRATION === "true";

describe.skipIf(!runDbIntegration)("runInRegionScope integration", () => {
  const pickupDate = new Date("2026-04-27T12:00:00.000Z");
  const weekIso = "2026-W18";
  const userId = "integration-user";
  let regionId = "";

  function buildSnapshotTestLoad(input: {
    lineHaulRate: string;
    loadedMiles: string;
    puDeadheadMiles: string;
    delDeadheadMiles: string;
    status?: "BOOKED" | "CANCELED";
  }) {
    return {
      regionId,
      weekIso,
      pickupDate,
      lineHaulRate: new Prisma.Decimal(input.lineHaulRate),
      loadedMiles: new Prisma.Decimal(input.loadedMiles),
      puDeadheadMiles: new Prisma.Decimal(input.puDeadheadMiles),
      delDeadheadMiles: new Prisma.Decimal(input.delDeadheadMiles),
      fscApplies: false,
      fscAmount: new Prisma.Decimal("0"),
      status: input.status ?? "BOOKED",
      createdById: userId
    };
  }

  async function cleanupWeekData() {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [
          { entityType: "Load" },
          { entityType: "WeekSnapshot" },
          { entityType: "FuelSurchargeIndex" }
        ]
      }
    });
    await prisma.load.deleteMany({ where: { regionId, weekIso } });
    await prisma.rateConfirmation.deleteMany({ where: { regionId, weekIso } });
    await prisma.fuelSurchargeIndex.deleteMany({ where: { regionId, weekIso } });
    await prisma.weekSnapshot.deleteMany({ where: { regionId, weekIso } });
  }

  beforeAll(async () => {
    const region = await prisma.region.upsert({
      where: { code: "NE" },
      update: {},
      create: {
        code: "NE",
        name: "Northeast"
      }
    });
    regionId = region.id;

    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: "integration-user@example.com",
        name: "Integration User"
      }
    });

    await prisma.userRegionRole.upsert({
      where: {
        userId_regionId: {
          userId,
          regionId
        }
      },
      update: {
        role: Role.COORDINATOR
      },
      create: {
        userId,
        regionId,
        role: Role.COORDINATOR
      }
    });
  });

  beforeEach(async () => {
    await cleanupWeekData();
  });

  test("binds app.region_id for transactional queries", async () => {
    const result = await runInRegionScope(regionId, async (tx) => {
      const rows = await tx.$queryRaw<Array<{ region_id: string }>>`
        SELECT current_setting('app.region_id', true) AS region_id
      `;
      return rows[0]?.region_id;
    });

    expect(result).toBe(regionId);
  });

  test("creates a load using Tuesday FSC rate in real DB", async () => {
    const rateConfirmation = await prisma.rateConfirmation.create({
      data: {
        regionId,
        weekIso,
        sourceFileUrl: "https://backhaul-ratecons.s3.us-east-1.amazonaws.com/integration.pdf",
        sourceFileHash: "integration-hash-1",
        parseState: ParseState.UPLOADED
      }
    });

    await prisma.fuelSurchargeIndex.create({
      data: {
        regionId,
        weekIso,
        value: new Prisma.Decimal("0.4200"),
        source: FuelSurchargeSource.manual_tuesday,
        effectiveAt: new Date(),
        updatedByUserId: userId,
        updateReason: "integration Tuesday entry"
      }
    });

    const result = await runInRegionScope(regionId, (tx) =>
      createLoadFromReview(
        {
          actorId: userId,
          regionId,
          rateConfirmationId: rateConfirmation.id,
          pickupDate,
          lineHaulRate: new Prisma.Decimal("1500"),
          loadedMiles: new Prisma.Decimal("300"),
          puDeadheadMiles: new Prisma.Decimal("25"),
          delDeadheadMiles: new Prisma.Decimal("25"),
          fscApplies: true
        },
        tx
      )
    );

    const load = (await prisma.load.findUniqueOrThrow({ where: { id: result.loadId } })) as Record<string, unknown>;
    expect(load.status).toBe("BOOKED");
    expect(load.createdById).toBe(userId);
    expect(Number(((load.fscRateUsed as Prisma.Decimal | null)?.toString() ?? 0))).toBeCloseTo(0.42, 4);
    expect(Number((load.fscAmount as Prisma.Decimal).toString())).toBeCloseTo(126, 4);
  });

  test("updates unlocked snapshots and blocks locked snapshots", async () => {
    await prisma.load.create({ data: buildSnapshotTestLoad({ lineHaulRate: "1000", loadedMiles: "200", puDeadheadMiles: "10", delDeadheadMiles: "10" }) });
    await recomputeWeekSnapshot(regionId, weekIso, userId);
    let snapshot = await prisma.weekSnapshot.findUniqueOrThrow({
      where: { regionId_weekIso: { regionId, weekIso } }
    });
    expect(snapshot.loadCount).toBe(1);

    await prisma.load.create({ data: buildSnapshotTestLoad({ lineHaulRate: "900", loadedMiles: "180", puDeadheadMiles: "10", delDeadheadMiles: "10" }) });
    await prisma.load.create({ data: buildSnapshotTestLoad({ lineHaulRate: "500", loadedMiles: "150", puDeadheadMiles: "10", delDeadheadMiles: "10", status: "CANCELED" }) });
    await recomputeWeekSnapshot(regionId, weekIso, userId);
    snapshot = await prisma.weekSnapshot.findUniqueOrThrow({
      where: { regionId_weekIso: { regionId, weekIso } }
    });
    expect(snapshot.loadCount).toBe(2);
    const snapshotRecord = snapshot as unknown as Record<string, Prisma.Decimal | Date | number | null>;
    expect(Number((snapshotRecord.totalLoadedMiles as Prisma.Decimal).toString())).toBeCloseTo(380, 4);
    expect(Number((snapshotRecord.totalTripMiles as Prisma.Decimal).toString())).toBeCloseTo(420, 4);
    expect(Number(((snapshotRecord.emptyMilePct as Prisma.Decimal | null)?.toString() ?? 0))).toBeCloseTo(40 / 420, 4);

    await prisma.weekSnapshot.update({
      where: { id: snapshot.id },
      data: { lockedAt: new Date() }
    });

    await expect(recomputeWeekSnapshot(regionId, weekIso, userId)).rejects.toThrow(/immutable/);
  });
});
