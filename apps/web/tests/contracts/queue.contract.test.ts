import { describe, expect, test } from "vitest";
import { queueEnvelopeSchema, queueEnvelopeVersion } from "@/contracts/queue";

describe("queue contract", () => {
  test("accepts v1 envelope", () => {
    const parsed = queueEnvelopeSchema.parse({
      contractVersion: queueEnvelopeVersion,
      payload: {
        regionId: "r1",
        weekIso: "2026-W18",
        entityId: "id-1",
        eventType: "PARSE_RATE_CON"
      }
    });
    expect(parsed.contractVersion).toBe("v1");
  });
});

