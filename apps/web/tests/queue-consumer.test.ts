import { ParseState, Prisma } from "@prisma/client";
import { beforeEach, describe, expect, test, vi } from "vitest";

const readUploadedPdf = vi.fn();
const recomputeWeekSnapshot = vi.fn();
const markParseState = vi.fn();
const mapParseFailure = vi.fn();

vi.mock("@/server/upload-storage", () => ({
  readUploadedPdf
}));

vi.mock("@/server/snapshots", () => ({
  recomputeWeekSnapshot
}));

vi.mock("@/server/ingestion", () => ({
  markParseState,
  mapParseFailure
}));

describe("queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mapParseFailure.mockReturnValue(ParseState.FAILED_SCHEMA);
  });

  test("processes parse envelope and writes extracted payload", async () => {
    const db = {
      rateConfirmation: {
        findFirst: vi.fn().mockResolvedValue({
          id: "rc-1",
          regionId: "region-1",
          sourceFileHash: "hash-1",
          parseState: ParseState.QUEUED
        }),
        update: vi.fn().mockResolvedValue({})
      },
      auditLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
    readUploadedPdf.mockResolvedValue(Buffer.from("pickupDate 2026-05-01 PU123 LD123 1000 200 miles"));
    markParseState.mockResolvedValue(undefined);

    const { processQueueEnvelope } = await import("@/server/queue-consumer");
    await processQueueEnvelope(
      {
        contractVersion: "v1",
        payload: {
          regionId: "region-1",
          weekIso: "2026-W18",
          entityId: "rc-1",
          eventType: "PARSE_RATE_CON"
        }
      },
      db as never
    );

    expect(db.rateConfirmation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-1" },
        data: expect.objectContaining({
          parseConfidence: expect.any(Prisma.Decimal),
          reviewDecision: "PENDING"
        })
      })
    );
    expect(markParseState).toHaveBeenCalledWith(
      expect.objectContaining({
        rateConfirmationId: "rc-1",
        to: ParseState.EXTRACTED
      })
    );
  });

  test("routes recompute events to snapshot recompute", async () => {
    const { processQueueEnvelope } = await import("@/server/queue-consumer");
    await processQueueEnvelope({
      contractVersion: "v1",
      payload: {
        regionId: "region-1",
        weekIso: "2026-W18",
        entityId: "load-1",
        eventType: "RECOMPUTE_WEEK_SNAPSHOT"
      }
    });
    expect(recomputeWeekSnapshot).toHaveBeenCalledWith("region-1", "2026-W18", "worker-system", expect.anything());
  });
});

