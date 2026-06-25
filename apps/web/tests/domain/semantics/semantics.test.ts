import { Prisma } from "@prisma/client";
import { describe, expect, test } from "vitest";
import {
  assertMileMaxUsage,
  computeAllInRevenue,
  mapToCanonicalLoadStatus,
  shouldIncludeInKpi
} from "@/domain/semantics";

describe("semantic kernel", () => {
  test("maps BOOKED to canonical PLANNED status", () => {
    expect(mapToCanonicalLoadStatus("BOOKED")).toBe("PLANNED");
  });

  test("computes all-in revenue from line haul + tonu (FSC parked)", () => {
    // FSC parked (spot-broker-first): all-in excludes the fscAmount term.
    const allIn = computeAllInRevenue({
      lineHaulRate: new Prisma.Decimal("1000"),
      fscAmount: new Prisma.Decimal("200"),
      tonuAmount: new Prisma.Decimal("75")
    });
    expect(allIn.toString()).toBe("1075");
  });

  test("includes canceled load when movement exists", () => {
    const include = shouldIncludeInKpi({
      status: "CANCELED",
      lineHaulRate: new Prisma.Decimal("0"),
      fscAmount: new Prisma.Decimal("0"),
      loadedMiles: new Prisma.Decimal("1"),
      pickupDeadhead: new Prisma.Decimal("0"),
      deliveryDeadhead: new Prisma.Decimal("0")
    });
    expect(include).toBe(true);
  });

  test("excludes canceled load with no movement and no financial impact", () => {
    const include = shouldIncludeInKpi({
      status: "CANCELED",
      lineHaulRate: new Prisma.Decimal("0"),
      fscAmount: new Prisma.Decimal("0"),
      loadedMiles: new Prisma.Decimal("0"),
      pickupDeadhead: new Prisma.Decimal("0"),
      deliveryDeadhead: new Prisma.Decimal("0")
    });
    expect(include).toBe(false);
  });

  test("rejects non-total MileMax usage", () => {
    expect(() => assertMileMaxUsage({ level: "lane" })).toThrow(/totals-level only/);
  });
});

