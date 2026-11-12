import { describe, expect, test } from "vitest";
import { BURST_MIN_READS_PER_DAY, OVERAGE_CENTS_PER_READ, PLANS, READS_INCLUDED_PER_TRUCK, burstReadsPerDay, centsText, effectivePlan, hardMonthlyReads, includedReads, isPlanKey, limitOf, limitsOf, monthlyPriceCents, overageCents, planAllows, planForTruckCount, planHolding, priceText, truckLimit } from "@/lib/plans";
import { ENTERPRISE_TRUCKS } from "@/lib/signup";
import { CAPABILITIES, FACTORING_PACKET, PROVIDERS, SECRET_ENV, hosCaution, packetGaps } from "@/truelane/partners/contract";

describe("the plans", () => {
  test("a fleet's size falls in one plan: 1 to 10, 11 to 25, 26 to 49, 50 and up", () => {
    const at = (n: number) => planForTruckCount(n).key;
    expect([0, 1, 10].map(at)).toEqual(["starter", "starter", "starter"]);
    expect([11, 25].map(at)).toEqual(["growth", "growth"]);
    expect([26, 49].map(at)).toEqual(["pro", "pro"]);
    expect([50, 75, 1500].map(at)).toEqual(["enterprise", "enterprise", "enterprise"]);
    expect(planForTruckCount(10.9).key).toBe("starter");
  });

  test("the month's price in cents: $99 plus $25 for every truck, never under $349, with no cliff between plans", () => {
    expect(monthlyPriceCents("starter", 3)).toBe(34900); // $174 by the formula, held to the minimum
    expect(monthlyPriceCents("starter", 10)).toBe(34900);
    expect(monthlyPriceCents("growth", 15)).toBe(47400);
    expect(monthlyPriceCents("growth", 25)).toBe(72400);
    expect(monthlyPriceCents("pro", 49)).toBe(132400);
    expect(monthlyPriceCents("enterprise", 50)).toBe(134900); // only where the conversation starts; Enterprise is by agreement
    expect(monthlyPriceCents("pro", -3)).toBe(34900);
    // one more truck costs $25 at every size, including across a plan edge (10 to 11, 25 to 26)
    expect(monthlyPriceCents("growth", 11) - monthlyPriceCents("starter", 10)).toBe(2500);
    expect(monthlyPriceCents("pro", 26) - monthlyPriceCents("growth", 25)).toBe(2500);
  });

  test("the Desk is never cheaper than Signals alone ($20 a truck, $300 minimum, quoted after the Read, not listed)", () => {
    const signals = (trucks: number) => Math.max(30000, 2000 * trucks);
    for (const trucks of [1, 10, 15, 25, 50, 200]) expect(monthlyPriceCents(planForTruckCount(trucks).key, trucks)).toBeGreaterThanOrEqual(signals(trucks));
    expect(monthlyPriceCents("growth", 25) - signals(25)).toBe(72400 - 50000);
  });

  test("the price in words and the limit", () => {
    expect(priceText("starter")).toBe("$99 + $25 a truck, $349 minimum");
    expect(priceText("growth")).toBe("$99 + $25 a truck, $349 minimum");
    expect(priceText("pro")).toBe("$99 + $25 a truck, $349 minimum");
    expect(priceText("enterprise")).toBe("By agreement");
    expect(centsText(4950)).toBe("$49.50");
    expect([truckLimit("starter"), truckLimit("growth"), truckLimit("pro"), truckLimit("enterprise")]).toEqual([10, 25, 49, null]);
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
    expect(limitsOf("starter")).toEqual({ trucks: 10, drivers: 20, trailers: 20 });
    expect(limitsOf("growth")).toEqual({ trucks: 25, drivers: 50, trailers: 50 });
    expect(limitsOf("pro")).toEqual({ trucks: 49, drivers: 98, trailers: 98 });
    expect(limitsOf("enterprise")).toEqual({ trucks: null, drivers: null, trailers: null });
    expect(limitOf("growth", "driver")).toBe(50);
    expect([limitOf("starter", "member"), limitOf("growth", "member"), limitOf("pro", "member"), limitOf("enterprise", "member")]).toEqual([3, 5, 10, null]);
    expect([planHolding("truck", 10).key, planHolding("truck", 11).key, planHolding("driver", 21).key, planHolding("trailer", 51).key, planHolding("driver", 99).key]).toEqual(["starter", "growth", "growth", "pro", "enterprise"]);
  });

  test("a plan allows units up to its limit and says so past it; no plan is Starter, never unlimited", () => {
    expect(planAllows(null, 9)).toEqual({ ok: true });
    expect(planAllows(null, 10)).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 10 trucks") });
    expect(planAllows(null, 5000)).toMatchObject({ ok: false });
    expect(planAllows("starter", 19, 1, "driver")).toEqual({ ok: true });
    expect(planAllows("starter", 20, 1, "driver")).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 20 drivers (twice its 10 trucks)") });
    expect(planAllows("growth", 50, 1, "trailer")).toMatchObject({ ok: false, message: expect.stringContaining("51 trailers is the Pro plan") });
    expect(planAllows("pro", 48)).toEqual({ ok: true });
    expect(planAllows("pro", 49)).toMatchObject({ ok: false, message: expect.stringContaining("50 trucks is the Enterprise plan") });
    expect(planAllows("starter", 9)).toEqual({ ok: true });
    expect(planAllows("starter", 10)).toMatchObject({ ok: false, message: expect.stringContaining("Starter plan covers 10 trucks") });
    expect(planAllows("growth", 23, 3)).toMatchObject({ ok: false });
    expect(planAllows("growth", 23, 2)).toEqual({ ok: true });
    expect(planAllows("enterprise", 100000, 5000)).toEqual({ ok: true });
    expect(planAllows("enterprise", 100000, 5000, "driver")).toEqual({ ok: true });
  });
});

describe("rate confirmation reads: the allowance, the overage and the limits", () => {
  test("a desk includes 25 reads a truck a month, pooled; a desk with no trucks yet gets one truck's worth", () => {
    expect(READS_INCLUDED_PER_TRUCK).toBe(25);
    expect([includedReads(10), includedReads(25), includedReads(0), includedReads(Number.NaN)]).toEqual([250, 625, 25, 25]);
  });

  test("past the allowance a read that worked is 25 cents, a separate line; failed reads are not in the count at all", () => {
    expect(OVERAGE_CENTS_PER_READ).toBe(25);
    expect(overageCents(250, 10)).toBe(0);
    expect(overageCents(251, 10)).toBe(25);
    expect(overageCents(300, 10)).toBe(50 * 25);
    expect(overageCents(10, 10)).toBe(0);
  });

  test("the month's hard limit is the allowance plus what a $50 overage ceiling pays for (200 reads)", () => {
    expect(hardMonthlyReads(10)).toBe(250 + 200);
    expect(hardMonthlyReads(10, 0)).toBe(250);
    expect(hardMonthlyReads(10, 1_000)).toBe(250 + 40);
  });

  test("the daily number is only a burst limit: three times an average day of the allowance, never under 25", () => {
    expect(BURST_MIN_READS_PER_DAY).toBe(25);
    expect(burstReadsPerDay(1)).toBe(25);
    expect(burstReadsPerDay(10)).toBe(25); // 3 x 250 / 30 = 25
    expect(burstReadsPerDay(25)).toBe(63);
    expect(burstReadsPerDay(50)).toBe(125);
  });
});

describe("the vendored partner contract (a copy of the phone's)", () => {
  test("names the same seven capabilities with a secret for every candidate", () => {
    expect(CAPABILITIES).toHaveLength(8);
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
