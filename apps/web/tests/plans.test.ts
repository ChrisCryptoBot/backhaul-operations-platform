import { describe, expect, test } from "vitest";
import { PLANS, centsText, effectivePlan, isPlanKey, limitOf, limitsOf, monthlyPriceCents, planAllows, planForTruckCount, planHolding, priceText, truckLimit } from "@/lib/plans";
import { ENTERPRISE_TRUCKS } from "@/lib/signup";
import { CAPABILITIES, FACTORING_PACKET, PROVIDERS, SECRET_ENV, hosCaution, packetGaps } from "@/truelane/partners/contract";

describe("the plans", () => {
  test("a fleet's size falls in one plan: 1 to 3, 4 to 10, 11 to 49, 50 and up", () => {
    const at = (n: number) => planForTruckCount(n).key;
    expect([0, 1, 3].map(at)).toEqual(["starter", "starter", "starter"]);
    expect([4, 10].map(at)).toEqual(["growth", "growth"]);
    expect([11, 26, 49].map(at)).toEqual(["pro", "pro", "pro"]);
    expect([50, 75, 1500].map(at)).toEqual(["enterprise", "enterprise", "enterprise"]);
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
    expect([truckLimit("starter"), truckLimit("growth"), truckLimit("pro"), truckLimit("enterprise")]).toEqual([3, 10, 49, null]);
    expect(PLANS.map((p) => p.key)).toEqual(["starter", "growth", "pro", "enterprise"]);
    expect(isPlanKey("pro")).toBe(true);
    expect(isPlanKey("gold")).toBe(false);
  });

  test("the sign-up line and the Enterprise plan start at the same number", () => {
    expect(ENTERPRISE_TRUCKS).toBe(PLANS.find((p) => p.key === "enterprise")!.min);
  });

  test("a plan with none chosen, or one that is not ours, is Starter", () => {
    expect([effectivePlan(null), effectivePlan(undefined), effectivePlan("gold"), effectivePlan("pro")]).toEqual(["starter", "starter", "starter", "pro"]);
  });

  test("drivers and trailers are held to twice the truck cap; Enterprise has no automatic cap", () => {
    expect(limitsOf("starter")).toEqual({ trucks: 3, drivers: 6, trailers: 6 });
    expect(limitsOf("growth")).toEqual({ trucks: 10, drivers: 20, trailers: 20 });
    expect(limitsOf("pro")).toEqual({ trucks: 49, drivers: 98, trailers: 98 });
    expect(limitsOf("enterprise")).toEqual({ trucks: null, drivers: null, trailers: null });
    expect(limitOf("growth", "driver")).toBe(20);
    expect([limitOf("starter", "member"), limitOf("growth", "member"), limitOf("pro", "member"), limitOf("enterprise", "member")]).toEqual([1, 3, 10, null]);
    expect([planHolding("truck", 3).key, planHolding("truck", 4).key, planHolding("driver", 7).key, planHolding("trailer", 21).key, planHolding("driver", 99).key]).toEqual(["starter", "growth", "growth", "pro", "enterprise"]);
  });

  test("a plan allows units up to its limit and says so past it; no plan is Starter, never unlimited", () => {
    expect(planAllows(null, 2)).toEqual({ ok: true });
    expect(planAllows(null, 3)).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 3 trucks") });
    expect(planAllows(null, 5000)).toMatchObject({ ok: false });
    expect(planAllows("starter", 5, 1, "driver")).toEqual({ ok: true });
    expect(planAllows("starter", 6, 1, "driver")).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 6 drivers (twice its 3 trucks)") });
    expect(planAllows("growth", 20, 1, "trailer")).toMatchObject({ ok: false, message: expect.stringContaining("21 trailers is the Pro plan") });
    expect(planAllows("pro", 48)).toEqual({ ok: true });
    expect(planAllows("pro", 49)).toMatchObject({ ok: false, message: expect.stringContaining("50 trucks is the Enterprise plan") });
    expect(planAllows("starter", 2)).toEqual({ ok: true });
    expect(planAllows("starter", 3)).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 3 trucks") });
    expect(planAllows("growth", 8, 3)).toMatchObject({ ok: false });
    expect(planAllows("growth", 8, 2)).toEqual({ ok: true });
    expect(planAllows("enterprise", 100000, 5000)).toEqual({ ok: true });
    expect(planAllows("enterprise", 100000, 5000, "driver")).toEqual({ ok: true });
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
