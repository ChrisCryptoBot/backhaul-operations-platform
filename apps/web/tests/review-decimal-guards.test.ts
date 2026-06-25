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
