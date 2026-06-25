import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import { computeWeekSnapshotTotals, diffWeekSnapshotTotals } from "@/domain/kpi/pure";

describe("pure KPI functions", () => {
  test("computes snapshot totals from included rows", () => {
    const totals = computeWeekSnapshotTotals([
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("1000"),
        fscAmount: new Prisma.Decimal("100"),
        loadedMiles: new Prisma.Decimal("200"),
        pickupDeadhead: new Prisma.Decimal("20"),
        deliveryDeadhead: new Prisma.Decimal("10")
      },
      {
        status: "CANCELED",
        lineHaulRate: new Prisma.Decimal("0"),
        fscAmount: new Prisma.Decimal("0"),
        loadedMiles: new Prisma.Decimal("0"),
        pickupDeadhead: new Prisma.Decimal("0"),
        deliveryDeadhead: new Prisma.Decimal("0")
      }
    ]);

    expect(totals.loadCount).toBe(1);
    expect(totals.lineHaulRevenue.toString()).toBe("1000");
    expect(totals.totalTripMiles.toString()).toBe("230");
    // NBY = line haul ÷ total trip miles (1000 / 230).
    expect(totals.nby?.toNumber()).toBeCloseTo(1000 / 230, 4);
  });

  test("detects parity diffs", () => {
    const current = computeWeekSnapshotTotals([
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("1000"),
        fscAmount: new Prisma.Decimal("0"),
        loadedMiles: new Prisma.Decimal("100"),
        pickupDeadhead: new Prisma.Decimal("10"),
        deliveryDeadhead: new Prisma.Decimal("10")
      }
    ]);
    const next = computeWeekSnapshotTotals([
      {
        status: "BOOKED",
        lineHaulRate: new Prisma.Decimal("1100"),
        fscAmount: new Prisma.Decimal("0"),
        loadedMiles: new Prisma.Decimal("100"),
        pickupDeadhead: new Prisma.Decimal("10"),
        deliveryDeadhead: new Prisma.Decimal("10")
      }
    ]);
    const diffs = diffWeekSnapshotTotals(current, next);
    expect(diffs.some((diff) => diff.metric === "lineHaulRevenue")).toBe(true);
  });
});

