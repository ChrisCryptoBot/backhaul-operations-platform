import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { computeLoadMetrics } from "@/server/kpi";

describe("kpi decimal formulas", () => {
  test("computes miles and rpm values using Decimal", () => {
    const metrics = computeLoadMetrics({
      lineHaulRate: new Prisma.Decimal("2000"),
      loadedMiles: new Prisma.Decimal("500"),
      puDeadheadMiles: new Prisma.Decimal("50"),
      delDeadheadMiles: new Prisma.Decimal("25"),
      fscApplies: true,
      fscRateUsed: new Prisma.Decimal("0.45")
    });

    expect(metrics.totalTripMiles.toString()).toBe("575");
    expect(metrics.negotiableMiles.toString()).toBe("550");
    expect(metrics.loadedRpm?.toString()).toBe("4");
    // FSC parked (spot-broker-first): fscAmount is forced to 0 even when fscApplies is true.
    expect(metrics.fscAmount.toString()).toBe("0");
    expect(Number(metrics.emptyMilePct?.toString() ?? 0)).toBeCloseTo(75 / 575, 4);
  });

  test("returns zero FSC when not applicable", () => {
    const metrics = computeLoadMetrics({
      lineHaulRate: new Prisma.Decimal("2000"),
      loadedMiles: new Prisma.Decimal("500"),
      puDeadheadMiles: new Prisma.Decimal("0"),
      delDeadheadMiles: new Prisma.Decimal("0"),
      fscApplies: false,
      fscRateUsed: null
    });

    expect(metrics.fscAmount.toString()).toBe("0");
  });

  test("returns null ratios for divide-by-zero metrics", () => {
    const metrics = computeLoadMetrics({
      lineHaulRate: new Prisma.Decimal("2000"),
      loadedMiles: new Prisma.Decimal("0"),
      puDeadheadMiles: new Prisma.Decimal("0"),
      delDeadheadMiles: new Prisma.Decimal("0"),
      fscApplies: false,
      fscRateUsed: null
    });

    expect(metrics.loadedRpm).toBeNull();
    expect(metrics.emptyMilePct).toBeNull();
  });
});
