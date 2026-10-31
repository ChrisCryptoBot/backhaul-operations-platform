import { describe, expect, test } from "vitest";
import { buildQuoteReport, letterFor, type DecisionRow } from "@/lib/quote-report";

const row = (over: Partial<DecisionRow> = {}): DecisionRow => ({
  id: Math.random().toString(36).slice(2),
  at: new Date("2026-10-05T12:00:00Z"),
  kind: "accepted",
  by: "Pat",
  reason: null,
  notes: null,
  customer: "Acme",
  lane: "Dallas, TX to Tulsa, OK",
  offer: 1500,
  verdict: "take",
  benchmark: "market",
  marginPerMile: 0.5,
  leftOver: 270,
  marketVariancePct: 0,
  firstOffer: 1400,
  truck: "Unit 1",
  fuelPrice: null,
  fuelSource: null,
  ...over
});

describe("the Quote decisions report", () => {
  test("counts what was booked, passed on and booked with an override, and the share booked of those decided", () => {
    const r = buildQuoteReport([row(), row(), row({ kind: "overridden", reason: "Relationship", marginPerMile: -0.2, leftOver: -100, verdict: "reject" }), row({ kind: "passed", reason: "Rate too low", verdict: "think" })]);
    expect(r).toMatchObject({ total: 4, booked: 3, passed: 1, overridden: 1, acceptanceRate: 0.75 });
    expect(r.byVerdict.take).toEqual({ booked: 2, passed: 0, overridden: 0 });
    expect(r.byVerdict.reject).toEqual({ booked: 1, passed: 0, overridden: 1 });
    expect(r.byVerdict.think).toEqual({ booked: 0, passed: 1, overridden: 0 });
  });

  test("overrides are listed by the reason given, with the money left on the ones that lost", () => {
    const r = buildQuoteReport([
      row({ kind: "overridden", reason: "Relationship", marginPerMile: -0.2, leftOver: -100 }),
      row({ kind: "overridden", reason: "Relationship", marginPerMile: 0.1, leftOver: 50 }),
      row({ kind: "overridden", reason: "Cash flow", marginPerMile: -0.1, leftOver: -60 })
    ]);
    expect(r.overrides.reasons).toEqual([
      { reason: "Relationship", count: 2, leftOver: -50 },
      { reason: "Cash flow", count: 1, leftOver: -60 }
    ]);
    expect(r.overrides.moneyLeftOnOverrides).toBe(-160);
    expect(r.overrides.belowFloor).toBe(2);
  });

  test("a raise is counted only where there was a first offer, and averaged over the raised ones", () => {
    const r = buildQuoteReport([row({ offer: 1500, firstOffer: 1400 }), row({ offer: 1600, firstOffer: 1400 }), row({ offer: 1500, firstOffer: 1500 }), row({ firstOffer: null })]);
    expect(r.negotiation).toMatchObject({ raised: 2, ofWithFirst: 3, avgRaise: 150 });
    expect(r.negotiation.avgRaisePct).toBeCloseTo((100 / 1400 + 200 / 1400) / 2, 6);
  });

  test("a pass for the rate is counted with how far under what it was read against it was", () => {
    const r = buildQuoteReport([row({ kind: "passed", reason: "Rate too low", marketVariancePct: -0.2 }), row({ kind: "passed", reason: "Rate too low", marketVariancePct: -0.1 }), row({ kind: "passed", reason: "Lost to another carrier" })]);
    expect(r.negotiation.passedOnRate).toBe(2);
    expect(r.negotiation.passedUnderMarketPct).toBeCloseTo(-0.15, 6);
  });

  test("a decision from before the details were kept counts in the totals and nowhere that needs them", () => {
    const old = row({ verdict: null, benchmark: null, marginPerMile: null, leftOver: null, firstOffer: null });
    const r = buildQuoteReport([old, old, row()]);
    expect(r.total).toBe(3);
    expect(r.withoutDetails).toBe(2);
    expect(r.byVerdict.take.booked).toBe(1);
    expect(r.negotiation.ofWithFirst).toBe(1);
  });

  test("people and customers are tallied, a person's override rate is over what they booked", () => {
    const r = buildQuoteReport([row({ by: "Pat" }), row({ by: "Pat", kind: "overridden", reason: "Cash flow" }), row({ by: "Sam", kind: "passed", reason: "Other" }), row({ by: "Sam", customer: "Blue Mesa" })]);
    const pat = r.people.find((p) => p.name === "Pat")!;
    expect(pat).toMatchObject({ decisions: 2, booked: 2, overridden: 1, overrideRate: 0.5 });
    expect(r.people.find((p) => p.name === "Sam")).toMatchObject({ decisions: 2, passed: 1, booked: 1 });
    expect(r.customers.find((c) => c.name === "Blue Mesa")).toMatchObject({ booked: 1 });
  });

  test("weeks are counted by the Sunday that starts them, oldest first, and trimmed to the number asked for", () => {
    const week = (d: string) => row({ at: new Date(`${d}T12:00:00Z`) });
    const r = buildQuoteReport([week("2026-10-05"), week("2026-10-06"), week("2026-10-14"), week("2026-09-01")], 2);
    expect(r.weeks.map((w) => w.start.toISOString().slice(0, 10))).toEqual(["2026-10-04", "2026-10-11"]);
    expect(r.weeks[0]).toMatchObject({ booked: 2 });
  });

  test("no grade until there are five decisions; then the average of the three measures against their targets", () => {
    expect(buildQuoteReport([row(), row()]).grade).toBeNull();
    // Nine of ten booked without an override (target 90%, full marks), every booked load cleared its cost (full marks), a quarter raised (target 25%, full marks).
    const good = [
      ...Array.from({ length: 9 }, (_, i) => row({ firstOffer: i < 3 ? 1400 : 1500, offer: 1500 })),
      row({ kind: "overridden", reason: "Relationship", marginPerMile: 0.1, leftOver: 10, firstOffer: 1500 })
    ];
    const r = buildQuoteReport(good);
    expect(r.measures.map((m) => Math.round(m.score ?? 0))).toEqual([100, 100, 100]);
    expect(r.grade).toMatchObject({ letter: "A" });
    const bad = buildQuoteReport(Array.from({ length: 6 }, () => row({ kind: "overridden", reason: "Other", marginPerMile: -0.3, leftOver: -90, firstOffer: 1500 })));
    expect(bad.grade!.letter).toBe("F");
  });

  test("letters follow the usual bands", () => {
    expect([95, 85, 75, 65, 10].map(letterFor)).toEqual(["A", "B", "C", "D", "F"]);
  });
});
