import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const tx = {
  load: { findMany: vi.fn() },
  weekSnapshot: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  }
};

const mockPrisma = {
  $transaction: vi.fn()
};

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma
}));

describe("snapshot recompute regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(async (callback: (trx: typeof tx) => Promise<unknown>) => callback(tx));
  });

  test("updates open snapshots and does not block second write", async () => {
    tx.load.findMany.mockResolvedValue([
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("1000"),
        fscAmount: new Prisma.Decimal("100"),
        loadedMiles: new Prisma.Decimal("200"),
        puDeadheadMiles: new Prisma.Decimal("10"),
        delDeadheadMiles: new Prisma.Decimal("10"),
        deletedAt: null
      },
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("900"),
        fscAmount: new Prisma.Decimal("90"),
        loadedMiles: new Prisma.Decimal("180"),
        puDeadheadMiles: new Prisma.Decimal("10"),
        delDeadheadMiles: new Prisma.Decimal("10"),
        deletedAt: null
      }
    ]);
    tx.weekSnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      lockedAt: null
    });
    tx.weekSnapshot.update.mockResolvedValue(undefined);

    const { recomputeWeekSnapshot } = await import("@/server/snapshots");
    await recomputeWeekSnapshot("region-1", "2026-W18", "actor-1");

    expect(tx.weekSnapshot.update).toHaveBeenCalledTimes(1);
    const updateArgs = tx.weekSnapshot.update.mock.calls[0][0];
    expect(updateArgs.data.loadCount).toBe(2);
    expect(updateArgs.data.lineHaulRevenue.toString()).toBe("1900");
    expect(updateArgs.data.fuelSurchargeAmount.toString()).toBe("190");
    expect(updateArgs.data.totalLoadedMiles.toString()).toBe("380");
    expect(updateArgs.data.totalTripMiles.toString()).toBe("420");
  });

  test("includes canceled/failed loads with movement or financial impact", async () => {
    tx.load.findMany.mockResolvedValue([
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("1000"),
        fscAmount: new Prisma.Decimal("100"),
        loadedMiles: new Prisma.Decimal("200"),
        puDeadheadMiles: new Prisma.Decimal("10"),
        delDeadheadMiles: new Prisma.Decimal("10"),
        deletedAt: null
      },
      {
        status: "CANCELED",
        lineHaulRate: new Prisma.Decimal("900"),
        fscAmount: new Prisma.Decimal("90"),
        loadedMiles: new Prisma.Decimal("180"),
        puDeadheadMiles: new Prisma.Decimal("10"),
        delDeadheadMiles: new Prisma.Decimal("10"),
        deletedAt: null
      }
    ]);
    tx.weekSnapshot.findUnique.mockResolvedValue({
      id: "snap-1",
      lockedAt: null
    });
    tx.weekSnapshot.update.mockResolvedValue(undefined);

    const { recomputeWeekSnapshot } = await import("@/server/snapshots");
    await recomputeWeekSnapshot("region-1", "2026-W18", "actor-1");

    const updateArgs = tx.weekSnapshot.update.mock.calls[0][0];
    expect(updateArgs.data.loadCount).toBe(2);
    expect(updateArgs.data.lineHaulRevenue.toString()).toBe("1900");
    expect(updateArgs.data.fuelSurchargeAmount.toString()).toBe("190");
  });
});
