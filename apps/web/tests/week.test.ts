import { describe, expect, test } from "vitest";
import { weekIsoFromPickup } from "@/lib/week";

describe("weekIsoFromPickup", () => {
  test("handles year boundary entering week 1", () => {
    expect(weekIsoFromPickup(new Date("2025-12-29T12:00:00Z"))).toBe("2026-W01");
  });

  test("handles first-week Sunday correctly", () => {
    expect(weekIsoFromPickup(new Date("2026-01-04T12:00:00Z"))).toBe("2026-W01");
  });

  test("handles ISO week 53 tail", () => {
    expect(weekIsoFromPickup(new Date("2027-01-03T12:00:00Z"))).toBe("2026-W53");
  });

  test("handles in-year ISO week 53 start", () => {
    expect(weekIsoFromPickup(new Date("2026-12-28T12:00:00Z"))).toBe("2026-W53");
  });
});
