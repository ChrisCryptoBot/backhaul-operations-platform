import { describe, expect, test } from "vitest";
import { PLANS, centsText, isPlanKey, monthlyPriceCents, planAllows, planForTruckCount, priceText, truckLimit } from "@/lib/plans";
import { CAPABILITIES, FACTORING_PACKET, PROVIDERS, SECRET_ENV, hosCaution, packetGaps } from "@/truelane/partners/contract";

describe("the plans", () => {
  test("a fleet's size falls in one plan: 1 to 3, 4 to 10, 11 to 74, 75 and up", () => {
    const at = (n: number) => planForTruckCount(n).key;
    expect([0, 1, 3].map(at)).toEqual(["starter", "starter", "starter"]);
    expect([4, 10].map(at)).toEqual(["growth", "growth"]);
    expect([11, 26, 74].map(at)).toEqual(["pro", "pro", "pro"]); // the 26 to 74 the tiers leave open are Pro
    expect([75, 1500].map(at)).toEqual(["enterprise", "enterprise"]);
    expect(planForTruckCount(2.9).key).toBe("starter");
  });

  test("the month's price in cents: a flat plan, or a base plus so much for every truck", () => {
    expect(monthlyPriceCents("starter", 3)).toBe(4900);
    expect(monthlyPriceCents("growth", 10)).toBe(9900 + 10 * 1500);
    expect(monthlyPriceCents("pro", 40)).toBe(19900 + 40 * 1200);
    expect(monthlyPriceCents("enterprise", 1500)).toBe(49900);
    expect(monthlyPriceCents("pro", -3)).toBe(19900);
  });

  test("the price in words and the limit", () => {
    expect(priceText("starter")).toBe("$49");
    expect(priceText("growth")).toBe("$99 + $15 a truck");
    expect(priceText("pro")).toBe("$199 + $12 a truck");
    expect(centsText(4950)).toBe("$49.50");
    expect([truckLimit("starter"), truckLimit("growth"), truckLimit("pro"), truckLimit("enterprise")]).toEqual([3, 10, 74, null]);
    expect(PLANS.map((p) => p.key)).toEqual(["starter", "growth", "pro", "enterprise"]);
    expect(isPlanKey("pro")).toBe(true);
    expect(isPlanKey("gold")).toBe(false);
  });

  test("a plan allows trucks up to its limit and says so past it; no plan has no limit", () => {
    expect(planAllows(null, 5000)).toEqual({ ok: true });
    expect(planAllows("starter", 2)).toEqual({ ok: true });
    expect(planAllows("starter", 3)).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 3 trucks") });
    expect(planAllows("growth", 8, 3)).toMatchObject({ ok: false });
    expect(planAllows("growth", 8, 2)).toEqual({ ok: true });
    expect(planAllows("enterprise", 100000, 5000)).toEqual({ ok: true });
  });
});

describe("the vendored partner contract (a copy of the phone's)", () => {
  test("names the same seven capabilities with a secret for every candidate", () => {
    expect(CAPABILITIES).toHaveLength(7);
    for (const c of CAPABILITIES) for (const p of PROVIDERS[c]) expect(SECRET_ENV[p]?.length).toBeGreaterThan(0);
  });

  test("the packet: the invoice is required, the rest optional", () => {
    expect(FACTORING_PACKET[0]).toEqual({ kind: "invoice", required: true });
    expect(packetGaps(["invoice"]).optional).toEqual(["rate_confirmation", "proof_of_delivery"]);
  });

  test("hours of service is a caution, short when the trip is longer than the clock", () => {
    expect(hosCaution(12, 11).level).toBe("short");
    expect(hosCaution(10, 11).level).toBe("caution");
    expect(hosCaution(5, 11).level).toBe("none");
    expect(hosCaution(5, null).level).toBe("none");
  });
});
