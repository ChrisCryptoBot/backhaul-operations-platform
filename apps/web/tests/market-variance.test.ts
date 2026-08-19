import { describe, expect, test } from "vitest";
import { classifyBand, computeVariance } from "@/server/dat/market-rate";

// Revenue-side semantics: we are the carrier, so negotiated ABOVE market is the win.
// variance = negotiated − market; band thresholds are ±10%.

describe("classifyBand", () => {
  test("ABOVE above +10%, BELOW below −10%, AT in between", () => {
    expect(classifyBand(0.159)).toBe("ABOVE");
    expect(classifyBand(0.1001)).toBe("ABOVE");
    expect(classifyBand(0.1)).toBe("AT"); // boundary is inclusive of AT
    expect(classifyBand(0)).toBe("AT");
    expect(classifyBand(-0.1)).toBe("AT");
    expect(classifyBand(-0.2)).toBe("BELOW");
  });
});

describe("computeVariance", () => {
  test("negotiated above market → positive variance + ABOVE band", () => {
    // Market total $690, negotiated $800, 250 mi → +$110, +15.9%, $3.20 vs $2.76/mi.
    const v = computeVariance({ negotiatedTotal: 800, marketTotal: 690, miles: 250 });
    expect(v.negotiatedPerMile).toBeCloseTo(3.2, 4);
    expect(v.marketPerMile).toBeCloseTo(2.76, 4);
    expect(v.varianceTotal).toBeCloseTo(110, 4);
    expect(v.variancePerMile).toBeCloseTo(0.44, 4);
    expect(v.variancePct).toBeCloseTo(0.1594, 3);
    expect(v.band).toBe("ABOVE");
  });

  test("negotiated at market → ~zero variance + AT band", () => {
    const v = computeVariance({ negotiatedTotal: 690, marketTotal: 690, miles: 250 });
    expect(v.varianceTotal).toBeCloseTo(0, 4);
    expect(v.band).toBe("AT");
  });

  test("negotiated well below market → negative variance + BELOW band", () => {
    const v = computeVariance({ negotiatedTotal: 500, marketTotal: 690, miles: 250 });
    expect(v.varianceTotal).toBeLessThan(0);
    expect(v.band).toBe("BELOW");
  });

  test("no miles → variance still computes (Excel model); per-mile figures are null", () => {
    // The screenshot case: market $2500, negotiated $2250, no trip miles.
    const v = computeVariance({ negotiatedTotal: 2250, marketTotal: 2500 });
    expect(v.varianceTotal).toBeCloseTo(-250, 4);
    expect(v.variancePct).toBeCloseTo(-0.1, 4);
    expect(v.band).toBe("AT"); // exactly −10% is the boundary → AT
    expect(v.negotiatedPerMile).toBeNull();
    expect(v.marketPerMile).toBeNull();
    expect(v.variancePerMile).toBeNull();
  });
});
