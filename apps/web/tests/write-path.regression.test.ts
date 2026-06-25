import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mockPrisma = {
  load: {
    create: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  }
};

vi.mock("@/lib/db", () => ({
  prisma: mockPrisma
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    SQS_RECOMPUTE_QUEUE_URL: "https://example.com/recompute",
    AWS_REGION: "us-east-1",
    SQS_PARSE_QUEUE_URL: "https://example.com/parse",
    CLERK_SECRET_KEY: "sk",
    CLERK_PUBLISHABLE_KEY: "pk",
    DATABASE_URL: "https://example.com/db",
    S3_BUCKET_NAME: "bucket",
    ANTHROPIC_API_KEY: "ak",
    PHASE1_REGION_CODE: "NE"
  })
}));

const enqueueJob = vi.fn();
vi.mock("@/server/queue", () => ({
  enqueueJob
}));

const requireRegionAccess = vi.fn();
vi.mock("@/lib/access", () => ({
  requireRegionAccess
}));

const assertWeekHasTuesdayFsc = vi.fn();
const getEffectiveFscRate = vi.fn();
vi.mock("@/server/fsc", () => ({
  assertWeekHasTuesdayFsc,
  getEffectiveFscRate
}));

describe("createLoadFromReview regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRegionAccess.mockResolvedValue({ userId: "user-1", regionId: "region-1", role: "COORDINATOR" });
    mockPrisma.load.create.mockResolvedValue({ id: "load-1" });
    mockPrisma.auditLog.create.mockResolvedValue(undefined);
  });

  test("persists computed KPI fields and enqueues recompute (FSC parked → 0)", async () => {
    const { createLoadFromReview } = await import("@/server/review");
    await createLoadFromReview({
      actorId: "user-1",
      regionId: "region-1",
      rateConfirmationId: "rc-1",
      pickupDate: new Date("2026-04-27T12:00:00.000Z"),
      lineHaulRate: new Prisma.Decimal("2000"),
      loadedMiles: new Prisma.Decimal("500"),
      puDeadheadMiles: new Prisma.Decimal("50"),
      delDeadheadMiles: new Prisma.Decimal("25"),
      fscApplies: true
    }, mockPrisma as never);

    expect(mockPrisma.load.create).toHaveBeenCalledTimes(1);
    const loadCreateArg = mockPrisma.load.create.mock.calls[0][0];
    expect(loadCreateArg.data.status).toBe("BOOKED");
    expect(loadCreateArg.data.createdById).toBe("user-1");
    expect(loadCreateArg.data.bookingDate.toISOString()).toBe("2026-04-27T12:00:00.000Z");
    expect(loadCreateArg.data.totalTripMiles.toString()).toBe("575");
    expect(loadCreateArg.data.loadedRpm.toString()).toBe("4");
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  test("neutralizes FSC: fsc-applicable input persists fscAmount=0 and fscApplies=false, no Tuesday gate", async () => {
    // FSC parked (spot-broker-first): even with fscApplies:true, no Tuesday FSC index is required
    // and the persisted load carries fscAmount=0 / allInRevenue=lineHaul, fscApplies=false.
    const { createLoadFromReview } = await import("@/server/review");
    await createLoadFromReview({
      actorId: "user-1",
      regionId: "region-1",
      rateConfirmationId: "rc-1",
      pickupDate: new Date("2026-04-27T12:00:00.000Z"),
      lineHaulRate: new Prisma.Decimal("2000"),
      loadedMiles: new Prisma.Decimal("500"),
      puDeadheadMiles: new Prisma.Decimal("50"),
      delDeadheadMiles: new Prisma.Decimal("25"),
      fscApplies: true
    }, mockPrisma as never);

    expect(assertWeekHasTuesdayFsc).not.toHaveBeenCalled();
    const loadCreateArg = mockPrisma.load.create.mock.calls[0][0];
    expect(loadCreateArg.data.fscAmount.toString()).toBe("0");
    expect(loadCreateArg.data.fscApplies).toBe(false);
    expect(loadCreateArg.data.fscRateUsed).toBeNull();
    expect(loadCreateArg.data.allInRevenue.toString()).toBe("2000");
  });
});
