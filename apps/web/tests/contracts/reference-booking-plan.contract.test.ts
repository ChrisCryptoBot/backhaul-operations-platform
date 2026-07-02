import { describe, expect, test } from "vitest";
import { bookingPlanMutationSchema } from "@/contracts/reference";

describe("contracts/reference — booking-plan mutations", () => {
  test("accepts a full create payload", () => {
    const result = bookingPlanMutationSchema.safeParse({
      action: "create_booking_plan_entry",
      entry: {
        planDate: "2026-07-03",
        driverId: "drv-1",
        expectedEmptyAt: "05:00",
        emptyCity: "Utica",
        emptyState: "NY",
        emptyCityAlt: "SA | AMHERST",
        backhaulNote: "NEED BH",
        status: "SOURCING",
        puCityDh: "READING PA +25",
        puTimes: "0800-1400",
        delCityDh: "LEESPORT PA +0",
        delTimes: "BY 2200"
      }
    });
    expect(result.success).toBe(true);
  });

  test("accepts a minimal create payload (planDate + driverId only)", () => {
    const result = bookingPlanMutationSchema.safeParse({
      action: "create_booking_plan_entry",
      entry: { planDate: "2026-07-03", driverId: "drv-1" }
    });
    expect(result.success).toBe(true);
  });

  test("rejects a bad planDate or a bad HH:MM empty time", () => {
    for (const planDate of ["07/03/2026", "2026-7-3", "20260703"]) {
      expect(
        bookingPlanMutationSchema.safeParse({
          action: "create_booking_plan_entry",
          entry: { planDate, driverId: "drv-1" }
        }).success
      ).toBe(false);
    }
    for (const expectedEmptyAt of ["0500", "5:00", "24:00"]) {
      expect(
        bookingPlanMutationSchema.safeParse({
          action: "create_booking_plan_entry",
          entry: { planDate: "2026-07-03", driverId: "drv-1", expectedEmptyAt }
        }).success
      ).toBe(false);
    }
  });

  test("BOOKED cannot be set directly on create or update", () => {
    expect(
      bookingPlanMutationSchema.safeParse({
        action: "create_booking_plan_entry",
        entry: { planDate: "2026-07-03", driverId: "drv-1", status: "BOOKED" }
      }).success
    ).toBe(false);
    expect(
      bookingPlanMutationSchema.safeParse({
        action: "update_booking_plan_entry",
        entryId: "bpe-1",
        fields: { status: "BOOKED" }
      }).success
    ).toBe(false);
    expect(
      bookingPlanMutationSchema.safeParse({
        action: "update_booking_plan_entry",
        entryId: "bpe-1",
        fields: { status: "SOURCING" }
      }).success
    ).toBe(true);
  });

  test("update requires at least one field", () => {
    expect(
      bookingPlanMutationSchema.safeParse({ action: "update_booking_plan_entry", entryId: "bpe-1", fields: {} })
        .success
    ).toBe(false);
  });

  test("delete requires a reason", () => {
    expect(
      bookingPlanMutationSchema.safeParse({ action: "delete_booking_plan_entry", entryId: "bpe-1" }).success
    ).toBe(false);
    expect(
      bookingPlanMutationSchema.safeParse({ action: "delete_booking_plan_entry", entryId: "bpe-1", reason: "dup" })
        .success
    ).toBe(true);
  });

  test("book action is entryId-only", () => {
    expect(
      bookingPlanMutationSchema.safeParse({ action: "book_booking_plan_entry", entryId: "bpe-1" }).success
    ).toBe(true);
    expect(bookingPlanMutationSchema.safeParse({ action: "book_booking_plan_entry" }).success).toBe(false);
  });
});
