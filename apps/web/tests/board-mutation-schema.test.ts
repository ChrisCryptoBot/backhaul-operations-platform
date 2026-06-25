import { describe, expect, test } from "vitest";
import { boardMutationSchema } from "@/app/api/board/schema";

const BASE = { date: "2026-06-21", loadId: "load-1" };

describe("boardMutationSchema — leg-upsert validation", () => {
  const leg = { legIndex: 0, legType: "PTP" as const };

  test("rejects non-numeric legMiles (would 500 on new Prisma.Decimal)", () => {
    const r = boardMutationSchema.safeParse({ action: "leg-upsert", ...BASE, leg: { ...leg, legMiles: "abc" } });
    expect(r.success).toBe(false);
  });

  test("accepts a decimal legMiles", () => {
    const r = boardMutationSchema.safeParse({ action: "leg-upsert", ...BASE, leg: { ...leg, legMiles: "286.5" } });
    expect(r.success).toBe(true);
  });

  test("rejects arrivalAt before etaAt", () => {
    const r = boardMutationSchema.safeParse({
      action: "leg-upsert",
      ...BASE,
      leg: { ...leg, etaAt: "2026-06-21T14:00:00.000Z", arrivalAt: "2026-06-21T13:00:00.000Z" }
    });
    expect(r.success).toBe(false);
  });

  test("accepts arrivalAt equal-or-after etaAt", () => {
    const r = boardMutationSchema.safeParse({
      action: "leg-upsert",
      ...BASE,
      leg: { ...leg, etaAt: "2026-06-21T14:00:00.000Z", arrivalAt: "2026-06-21T14:05:00.000Z" }
    });
    expect(r.success).toBe(true);
  });
});

describe("boardMutationSchema — reschedule-delivery validation", () => {
  const base = { action: "reschedule-delivery" as const, ...BASE, newDate: "2026-06-22", apptType: "FIRM_APPT" as const };

  test("rejects windowEnd before windowStart", () => {
    expect(boardMutationSchema.safeParse({ ...base, windowStart: "14:00", windowEnd: "09:00" }).success).toBe(false);
  });

  test("rejects windowEnd equal to windowStart", () => {
    expect(boardMutationSchema.safeParse({ ...base, windowStart: "09:00", windowEnd: "09:00" }).success).toBe(false);
  });

  test("accepts a forward window", () => {
    expect(boardMutationSchema.safeParse({ ...base, windowStart: "00:01", windowEnd: "09:30" }).success).toBe(true);
  });
});

describe("boardMutationSchema — update-fields state model", () => {
  test("rejects deliveryExceptionState=RESCHEDULED (action-only)", () => {
    const r = boardMutationSchema.safeParse({
      action: "update-fields",
      ...BASE,
      fields: { deliveryExceptionState: "RESCHEDULED" }
    });
    expect(r.success).toBe(false);
  });

  test("accepts NONE and WORK_IN_REQUESTED", () => {
    expect(
      boardMutationSchema.safeParse({ action: "update-fields", ...BASE, fields: { deliveryExceptionState: "WORK_IN_REQUESTED" } })
        .success
    ).toBe(true);
    expect(
      boardMutationSchema.safeParse({ action: "update-fields", ...BASE, fields: { deliveryExceptionState: "NONE" } }).success
    ).toBe(true);
  });
});

describe("boardMutationSchema — status overrideReason", () => {
  test("status accepts an optional overrideReason", () => {
    expect(boardMutationSchema.safeParse({ action: "status", ...BASE, status: "DELIVERED" }).success).toBe(true);
    expect(
      boardMutationSchema.safeParse({ action: "status", ...BASE, status: "DELIVERED", overrideReason: "broker notified by phone" })
        .success
    ).toBe(true);
  });
});
