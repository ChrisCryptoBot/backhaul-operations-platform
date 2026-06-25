import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { computeLoadMetrics } from "@/server/kpi";
import { weekIsoFromPickup } from "@/lib/week";

describe("kpi and week alignment", () => {
  test("phase-1 formulas and week assignment align on pickup date", () => {
    const metrics = computeLoadMetrics({
      lineHaulRate: new Prisma.Decimal("1500"),
      loadedMiles: new Prisma.Decimal("300"),
      puDeadheadMiles: new Prisma.Decimal("25"),
      delDeadheadMiles: new Prisma.Decimal("25"),
      fscApplies: true,
      fscRateUsed: new Prisma.Decimal("0.35")
    });

    expect(metrics.totalTripMiles.toString()).toBe("350");
    expect(metrics.emptyMilePct?.greaterThan(0)).toBe(true);
    expect(weekIsoFromPickup(new Date("2026-04-29T12:00:00Z"))).toBe("2026-W18");
  });
});
