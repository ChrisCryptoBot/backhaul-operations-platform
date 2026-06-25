import { FuelSurchargeSource, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockPrisma = {
  fuelSurchargeIndex: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  }
};

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma
}));

describe("fsc governance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("fails closed on cross-region FSC write", async () => {
    const { upsertFscIndex } = await import("@/server/fsc");
    await expect(
      upsertFscIndex({
        ctx: {
          userId: "user-1",
          role: "ADMIN",
          regionId: "region-a"
        },
        regionId: "region-b",
        weekIso: "2026-W18",
        value: new Prisma.Decimal("0.42"),
        reason: "sync",
        source: FuelSurchargeSource.manual_tuesday
      })
    ).rejects.toThrow(/Cross-region FSC write not permitted/);
  });

  test("blocks CORPORATE_OPS from Tuesday FSC writes", async () => {
    const { upsertFscIndex } = await import("@/server/fsc");
    await expect(
      upsertFscIndex({
        ctx: {
          userId: "user-1",
          role: "CORPORATE_OPS",
          regionId: "region-a"
        },
        regionId: "region-a",
        weekIso: "2026-W18",
        value: new Prisma.Decimal("0.42"),
        reason: "sync",
        source: FuelSurchargeSource.manual_tuesday
      })
    ).rejects.toThrow(/Only COORDINATOR, REGIONAL_MANAGER, or ADMIN can perform Tuesday FSC updates/);
  });

  test("blocks COORDINATOR from manual overrides", async () => {
    const { upsertFscIndex } = await import("@/server/fsc");
    await expect(
      upsertFscIndex({
        ctx: {
          userId: "user-1",
          role: "COORDINATOR",
          regionId: "region-a"
        },
        regionId: "region-a",
        weekIso: "2026-W18",
        value: new Prisma.Decimal("0.45"),
        reason: "override",
        source: FuelSurchargeSource.manual_override
      })
    ).rejects.toThrow(/Only REGIONAL_MANAGER or ADMIN can create FSC overrides/);
  });

  test("writes row-specific audit metadata for Tuesday create", async () => {
    mockPrisma.fuelSurchargeIndex.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    mockPrisma.fuelSurchargeIndex.create.mockResolvedValue({ id: "fsc-row-1" });

    const { upsertFscIndex } = await import("@/server/fsc");
    await upsertFscIndex({
      ctx: {
        userId: "user-1",
        role: "COORDINATOR",
        regionId: "region-a"
      },
      regionId: "region-a",
      weekIso: "2026-W18",
      value: new Prisma.Decimal("0.42"),
      reason: "Tuesday update",
      source: FuelSurchargeSource.manual_tuesday
    });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityId: "fsc-row-1",
          action: "CREATE_TUESDAY",
          reason: expect.stringContaining("region-a:2026-W18"),
          afterValue: expect.objectContaining({
            value: "0.42",
            source: FuelSurchargeSource.manual_tuesday
          })
        })
      })
    );
  });

  test("asserts Tuesday entry exists even after manual override", async () => {
    mockPrisma.fuelSurchargeIndex.findFirst.mockReset();
    mockPrisma.fuelSurchargeIndex.findFirst
      .mockResolvedValueOnce({
        id: "tuesday",
        source: FuelSurchargeSource.manual_tuesday
      })
      .mockResolvedValueOnce({
        id: "override",
        value: new Prisma.Decimal("0.45")
      });

    const { assertWeekHasTuesdayFsc, getEffectiveFscRate } = await import("@/server/fsc");
    await expect(assertWeekHasTuesdayFsc("region-1", "2026-W18")).resolves.toBeUndefined();
    const latest = await getEffectiveFscRate("region-1", "2026-W18");
    expect(latest?.toString()).toBe("0.45");
  });
});
