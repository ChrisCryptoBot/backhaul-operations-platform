import { beforeEach, describe, expect, test, vi } from "vitest";

const enqueueJob = vi.fn();

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    SQS_PARSE_QUEUE_URL: "https://sqs.example.com/parse"
  })
}));

vi.mock("@/server/queue", () => ({
  enqueueJob
}));

describe("finalizeUpload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("stamps acceptance metadata and writes upload audit event", async () => {
    const db = {
      rateConfirmation: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null),
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "rc-1" })
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    const { finalizeUpload } = await import("@/server/ingestion");
    const result = await finalizeUpload({
      regionId: "region-1",
      weekIso: "2026-W18",
      sourceFileUrl: "https://bucket.s3.us-east-1.amazonaws.com/rc-1.pdf",
      sourceFileHash: "hash-1",
      acceptedById: "user-1",
      enqueueParseJob: false,
      db: db as never
    });
    expect(result).toEqual({ rateConfirmationId: "rc-1", duplicateKind: "NONE", alreadyExisted: false });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledTimes(1);
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entityType: "RateConfirmation",
          entityId: "rc-1",
          action: "UPLOAD_ACCEPTED",
          actorId: "user-1"
        })
      })
    );
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test("returns existing idempotent record without acceptance side effects", async () => {
    const db = {
      rateConfirmation: {
        findUnique: vi.fn().mockResolvedValueOnce({
          id: "rc-existing",
          sourceFileHash: "hash-1"
        }),
        findFirst: vi.fn().mockResolvedValue(null)
      },
      $executeRaw: vi.fn().mockResolvedValue(1),
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    const { finalizeUpload } = await import("@/server/ingestion");
    const result = await finalizeUpload({
      regionId: "region-1",
      weekIso: "2026-W18",
      sourceFileUrl: "https://bucket.s3.us-east-1.amazonaws.com/rc-1.pdf",
      sourceFileHash: "hash-1",
      acceptedById: "user-1",
      idempotencyKey: "idem-1",
      enqueueParseJob: false,
      db: db as never
    });
    expect(result).toEqual({ rateConfirmationId: "rc-existing", duplicateKind: "EXACT_DUPLICATE", alreadyExisted: true });
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.auditLog.create).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
