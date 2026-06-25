import { beforeEach, describe, expect, test, vi } from "vitest";
import { ReviewValidationError } from "@/lib/review-errors";

const runInRegionScope = vi.fn();
const enqueueJob = vi.fn();

vi.mock("@/lib/db", () => ({
  runInRegionScope,
  prisma: {}
}));

vi.mock("@/server/queue", () => ({
  enqueueJob
}));

describe("review service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("reject transition sets review decision metadata", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: "rc-1",
        parseState: "EXTRACTED",
        reviewDecision: "APPROVED",
        sourceFileUrl: "https://example.com/rc-1.pdf",
        extractedPayload: {},
        reviewedAt: null,
        reviewedById: null,
        reviewReason: null,
        createdAt: new Date("2026-04-29T00:00:00.000Z"),
        updatedAt: new Date("2026-04-29T01:00:00.000Z")
      }
    ]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: queryRaw,
      rateConfirmation: {
        findFirst: vi.fn().mockResolvedValue({})
      },
      load: {
        findFirst: vi.fn().mockResolvedValue(null)
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) =>
      callback(tx)
    );

    const { rejectRateConfirmationReview } = await import("@/server/review");
    const result = await rejectRateConfirmationReview({
      actorId: "user-1",
      regionId: "region-1",
      rateConfirmationId: "rc-1",
      reason: "Not a valid rate confirmation"
    });

    expect(result.reviewDecision).toBe("REJECTED");
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "REJECT_REVIEW"
        })
      })
    );
  });

  test("approve rejects missing required extracted pickupDate", async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      {
        id: "rc-1",
        parseState: "EXTRACTED",
        reviewDecision: "APPROVED",
        sourceFileUrl: "https://example.com/rc-1.pdf",
        extractedPayload: {
          lineHaulRate: 1000,
          loadedMiles: 300
        },
        reviewedAt: null,
        reviewedById: null,
        reviewReason: null,
        createdAt: new Date("2026-04-29T00:00:00.000Z"),
        updatedAt: new Date("2026-04-29T01:00:00.000Z")
      }
    ]);
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: queryRaw,
      rateConfirmation: {
        findFirst: vi.fn().mockResolvedValue({})
      },
      load: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "load-1" })
      },
      broker: {
        findFirst: vi.fn().mockResolvedValue(null)
      },
      fuelSurchargeIndex: {
        findFirst: vi.fn()
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    runInRegionScope.mockImplementation(async (_regionId: string, callback: (trx: typeof tx) => Promise<unknown>) =>
      callback(tx)
    );

    const { approveRateConfirmationReview } = await import("@/server/review");
    await expect(
      approveRateConfirmationReview({
        actorId: "user-1",
        regionId: "region-1",
        rateConfirmationId: "rc-1"
      })
    ).rejects.toBeInstanceOf(ReviewValidationError);
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
