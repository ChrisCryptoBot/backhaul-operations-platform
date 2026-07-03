import { describe, expect, test, vi } from "vitest";
import { ReviewValidationError } from "@/lib/review-errors";

// Keep the Prisma client + SQS out of this unit test (we only exercise the pure
// extracted-payload -> CreateLoadInput mapper).
vi.mock("@/lib/db", () => ({ runInRegionScope: vi.fn(), prisma: {} }));
vi.mock("@/server/queue", () => ({ enqueueJob: vi.fn() }));

import { mapExtractedPayloadToCreateLoadInput } from "@/server/review";

const BASE = {
  pickupDate: "2026-06-25",
  pickupNumber: "PU-1",
  lineHaulRate: "2400",
  loadedMiles: "520",
  shipperName: "Acme",
  receiverName: "BigBox",
  brokerName: "Summit",
  loadNumber: "LD-1",
  originCityState: "Pittsburgh, PA",
  destinationCityState: "Carlisle, PA"
};

function build(overrides: Record<string, unknown>) {
  return mapExtractedPayloadToCreateLoadInput({
    actorId: "u1",
    regionId: "r1",
    rateConfirmationId: "rc1",
    extractedPayload: { ...BASE, ...overrides }
  });
}

describe("extracted-payload decimal guards", () => {
  test("a clean payload maps without error", () => {
    const input = build({});
    expect(input.lineHaulRate.toString()).toBe("2400");
    expect(input.loadedMiles.toString()).toBe("520");
  });

  test("rejects a zero line-haul rate", () => {
    expect(() => build({ lineHaulRate: "0" })).toThrow(ReviewValidationError);
  });

  test("rejects a negative line-haul rate", () => {
    expect(() => build({ lineHaulRate: "-100" })).toThrow(ReviewValidationError);
  });

  test("rejects zero loaded miles", () => {
    expect(() => build({ loadedMiles: "0" })).toThrow(ReviewValidationError);
  });

  test("rejects negative deadhead miles", () => {
    expect(() => build({ puDeadheadMiles: "-5" })).toThrow(ReviewValidationError);
  });

  test("accepts zero deadhead (optional, min 0)", () => {
    expect(() => build({ puDeadheadMiles: "0" })).not.toThrow();
  });
});

describe("extracted-payload reference numbers", () => {
  test("maps LLM-classified numbers, stamps source, and derives pickup fields", () => {
    const input = build({
      pickupNumber: "PU-1",
      loadNumber: "LD-9",
      referenceNumbers: [
        { kind: "PU", value: "PU-1" },
        { kind: "BOL", value: "BOL-77" },
        { kind: "PO", value: "PO-42" }
      ]
    });
    expect(input.loadNumber).toBe("LD-9");
    expect(input.referenceNumbers).toEqual([
      { kind: "PU", value: "PU-1", source: "RATE_CON" },
      { kind: "BOL", value: "BOL-77", source: "RATE_CON" },
      { kind: "PO", value: "PO-42", source: "RATE_CON" }
    ]);
    expect(input.pickupNumbers).toEqual(["PU-1"]);
    expect(input.pickupNumber).toBe("PU-1");
  });

  test("folds the scalar pickupNumber in as a PU when the LLM omitted it", () => {
    const input = build({ pickupNumber: "PU-XYZ", referenceNumbers: [{ kind: "BOL", value: "B1" }] });
    expect(input.referenceNumbers?.[0]).toEqual({ kind: "PU", value: "PU-XYZ", source: "RATE_CON" });
    expect(input.pickupNumbers).toEqual(["PU-XYZ"]);
  });

  test("no referenceNumbers → the scalar pickupNumber still becomes a PU entry (nothing dropped)", () => {
    const input = build({ pickupNumber: "PU-ONLY" });
    expect(input.referenceNumbers).toEqual([{ kind: "PU", value: "PU-ONLY", source: "RATE_CON" }]);
    expect(input.pickupNumbers).toEqual(["PU-ONLY"]);
  });
});
