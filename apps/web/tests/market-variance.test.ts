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
    // 250 mi, market $2.76/mi all-in → market total $690. Negotiated $800 → $3.20/mi.
    const v = computeVariance({ negotiatedTotal: 800, miles: 250, marketPerMile: 2.76 });
    expect(v.negotiatedPerMile).toBeCloseTo(3.2, 4);
    expect(v.marketTotal).toBeCloseTo(690, 4);
    expect(v.varianceTotal).toBeCloseTo(110, 4);
    expect(v.variancePerMile).toBeCloseTo(0.44, 4);
    expect(v.variancePct).toBeCloseTo(0.1594, 3);
    expect(v.band).toBe("ABOVE");
  });

  test("negotiated at market → ~zero variance + AT band", () => {
    const v = computeVariance({ negotiatedTotal: 690, miles: 250, marketPerMile: 2.76 });
    expect(v.varianceTotal).toBeCloseTo(0, 4);
    expect(v.band).toBe("AT");
  });

  test("negotiated well below market → negative variance + BELOW band", () => {
    // $2.00/mi vs $2.76 market ≈ −27.5%.
    const v = computeVariance({ negotiatedTotal: 500, miles: 250, marketPerMile: 2.76 });
    expect(v.varianceTotal).toBeLessThan(0);
    expect(v.band).toBe("BELOW");
  });

  test("zero miles is safe (no divide-by-zero)", () => {
    const v = computeVariance({ negotiatedTotal: 800, miles: 0, marketPerMile: 2.76 });
    expect(v.negotiatedPerMile).toBe(0);
    expect(v.marketTotal).toBe(0);
    expect(Number.isFinite(v.variancePct)).toBe(true);
  });
});
