import { describe, expect, it } from "vitest";
import { perMile, usd } from "@/lib/desk-format";
import { readVerdict, type Benchmark, type Verdict } from "@/lib/verdict";
import type { FitRow } from "@/server/tl/quote";

/**
 * Phase 0.6: Matrix and Verdict Card Math Reconciliation.
 *
 * Asserts that for any truck selected in the fleet matrix, the values
 * presented in the matrix row (all-in rate, floor rate, margin, leftover)
 * reconcile to the cent and dollar with the verdict card and verdict bar.
 */
function mockRow(over: Partial<FitRow> = {}): FitRow {
  return {
    key: "truck-101-driver-1",
    truckId: "truck-101",
    truckName: "Unit 101",
    driverId: "drv-1",
    driverName: "Marcus Vance",
    labourNote: "usual pay: $0.62/mi, plus 25% burden",
    emptyToPickup: 45,
    totalMiles: 545.2,
    band: "above_market",
    decision: "accept",
    gate: null,
    allInPerMile: 2.34,
    floorPerMile: 1.5,
    marginPerMile: 0.84,
    leftOver: 457.97,
    blocked: null,
    warnings: [],
    hos: { availableHours: 11, syncedAt: null, caution: { level: "none", message: null } },
    detail: {
      effectiveGross: 1275,
      payNeeded: 818,
      marketVariancePct: 0.15,
      marketVarianceDollars: 165,
      thinMargin: false,
      timeTrap: false,
      profitPerHour: 45,
      hourlyTarget: 25,
      fuelPerMile: 0.5,
      requiredRests: 0,
      elapsedHours: 9.5,
      rejectReason: null,
      routeMinimum: null,
      metrics: {
        loadRpm: 2.34,
        pickupRpm: null,
        rph: 134,
        profitPerMile: 0.84,
        marginAfterFuelPct: 40,
        fuelTotal: 272.6,
        tripHours: 9.5,
        truckCostPerMile: 1.5
      },
      fees: {
        gross: 1275,
        carrier: 0,
        carrierPct: 0,
        factoring: 0,
        factoringPct: 0,
        rider: 0,
        net: 1275
      }
    },
    ...over
  };
}

function computeVerdict(row: FitRow, benchmark: Benchmark = "market", marketSuspect = false): Verdict {
  const d = row.detail;
  return readVerdict({
    band: row.band,
    gate: row.gate,
    allInPerMile: row.allInPerMile,
    floorPerMile: row.floorPerMile,
    marginPerMile: row.marginPerMile,
    leftOver: row.leftOver,
    totalMiles: row.totalMiles,
    gross: d.effectiveGross,
    marketDollars: d.marketVarianceDollars,
    marketPct: d.marketVariancePct,
    benchmark,
    payNeeded: d.payNeeded,
    thinMargin: d.thinMargin,
    timeTrap: d.timeTrap,
    profitPerHour: d.profitPerHour,
    hourlyTarget: d.hourlyTarget,
    marketSuspect
  });
}

describe("Phase 0.6: Matrix and Verdict Card Math Agreement", () => {
  it("reconciles all-in $/mi, floor, margin, and leftover for a profitable load", () => {
    const row = mockRow();
    const verdict = computeVerdict(row);

    // 1. All-In rate matches
    const matrixAllIn = perMile(row.allInPerMile);
    expect(matrixAllIn).toBe("$2.34/mi");
    expect(verdict.ruler?.offer.value).toBe(row.allInPerMile);

    // 2. Floor matches
    const matrixFloor = perMile(row.floorPerMile);
    expect(matrixFloor).toBe("$1.50/mi");
    expect(verdict.ruler?.floor.value).toBe(row.floorPerMile);

    // 3. Margin matches to the exact cent in sentence
    expect(verdict.sentence).toContain("$0.84/mi");
    expect(perMile(row.marginPerMile)).toBe("$0.84/mi");

    // 4. Leftover dollars match
    const matrixLeftOver = usd(row.leftOver, 0);
    expect(matrixLeftOver).toBe("$458");
    expect(verdict.sentence).toContain("$458 on this trip");
  });

  it("reconciles deficit figures for a losing load below cost", () => {
    const row = mockRow({
      band: "below_floor",
      decision: "reject",
      gate: "below_floor",
      allInPerMile: 1.19,
      floorPerMile: 1.5,
      marginPerMile: -0.31,
      leftOver: -168.97
    });
    const verdict = computeVerdict(row);

    // All-in & floor match
    expect(perMile(row.allInPerMile)).toBe("$1.19/mi");
    expect(verdict.ruler?.offer.value).toBe(1.19);
    expect(verdict.ruler?.floor.value).toBe(1.5);

    // Deficit sentence displays the shortfalls matching matrix row
    expect(verdict.sentence).toContain("Short of your cost by $0.31/mi, $169 on this trip");
    expect(perMile(Math.abs(row.marginPerMile!))).toBe("$0.31/mi");
    expect(usd(Math.abs(row.leftOver!), 0)).toBe("$169");
  });

  it("reconciles when fuel is missing (unjudged state)", () => {
    const row = mockRow({
      band: "needs_fuel",
      decision: "needs_fuel",
      gate: "needs_fuel",
      allInPerMile: null,
      marginPerMile: null,
      leftOver: null
    });
    const verdict = computeVerdict(row);

    // In matrix: nulls display as em dash
    expect(perMile(row.allInPerMile)).toBe("—");
    expect(row.leftOver == null ? "—" : usd(row.leftOver, 0)).toBe("—");

    // In verdict: ruler is null and sentence indicates missing fuel
    expect(verdict.ruler).toBeNull();
    expect(verdict.state).toBe("unjudged");
    expect(verdict.sentence).toContain("no mpg or fuel price");
  });

  it("reconciles with lane history benchmark instead of market rate", () => {
    const row = mockRow({ band: "above_market" });
    const verdict = computeVerdict(row, "lane");

    expect(verdict.ruler?.marketName).toBe("Your lane");
    expect(verdict.sentence).toContain("your lane average");
    expect(verdict.ruler?.floor.value).toBe(row.floorPerMile);
    expect(verdict.ruler?.offer.value).toBe(row.allInPerMile);
  });
});
