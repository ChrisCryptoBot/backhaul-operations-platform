import { describe, expect, test } from "vitest";
import { isLateStatus, mapStatusPresentation } from "@/lib/ui/status-map";

describe("status map parity helpers", () => {
  test("normalizes casing for status presentation", () => {
    expect(mapStatusPresentation("tonu")).toEqual({ label: "TONU", tone: "canceled" });
  });

  test("detects derived late statuses consistently", () => {
    expect(isLateStatus("LATE_PICKUP")).toBe(true);
    expect(isLateStatus("delayed_delivery")).toBe(true);
    expect(isLateStatus("BOOKED")).toBe(false);
  });
});
