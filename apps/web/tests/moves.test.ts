import { describe, expect, test } from "vitest";
import { EFFECT_ORDER, ZERO_WEEK, bridgeOf, moveRows, resultOf, totalsOf, withoutCosts, type MoveLoad, type WeekTotals } from "@/lib/moves";

const load = (over: Partial<MoveLoad> = {}): MoveLoad => ({ loadId: "l", doneAt: 0, lane: "Dallas, TX → Atlanta, GA", customer: "Acme", loadedMiles: 800, drivenMiles: 900, lineHaul: 2000, fsc: 200, other: 0, expenses: 700, detention: 0, ...over });
const week = (loads: MoveLoad[]): WeekTotals => totalsOf(loads);
const sum = (b: ReturnType<typeof bridgeOf>) => Math.round(b.effects.reduce((s, e) => s + e.dollars * 100, 0));

describe("a week's result", () => {
  test("gross and billed detention, less the tracked costs; the miles and dollars are sums of the loads", () => {
    const t = week([load(), load({ lineHaul: 1000, fsc: 100, other: 50, detention: 75, expenses: 300 })]);
    expect(t).toMatchObject({ loads: 2, loadedMiles: 1600, emptyMiles: 200, drivenMiles: 1800, lineHaul: 3000, fsc: 300, other: 50, detention: 75, expenses: 1000 });
    expect(resultOf(t)).toBe(2425);
  });
  test("cents are added as cents: a hundred loads of ten cents is ten dollars", () => {
    expect(totalsOf(Array.from({ length: 100 }, () => load({ lineHaul: 0.1, fsc: 0, expenses: 0 }))).lineHaul).toBe(10);
  });
});

describe("the bridge between two weeks", () => {
  test("a hand case: a better rate, more loaded miles, fewer empty miles, dearer fuel, a bigger surcharge and a detention bill", () => {
    const a = week([load({ loadedMiles: 800, drivenMiles: 900, lineHaul: 2000, fsc: 200, expenses: 700 })]);
    const b = week([load({ loadedMiles: 1000, drivenMiles: 1050, lineHaul: 2800, fsc: 260, expenses: 945, detention: 90 })]);
    const r = bridgeOf(a, b);
    // result A = 2000 + 200 - 700 = 1500; B = 2800 + 260 + 90 - 945 = 2205
    expect(r).toMatchObject({ before: 1500, after: 2205, change: 705, method: "split" });
    const by = Object.fromEntries(r.effects.map((e) => [e.key, e.dollars]));
    // h_A = 2.5, h_B = 2.8: rate = 0.3 x 1000 = 300
    expect(by.rate).toBe(300);
    // x_A = 700/900, h_A - x_A = 2.5 - 0.7777... : miles = 200 x 1.72222... = 344.44
    expect(by.miles).toBe(344.44);
    // deadhead = -(50 - 100) x 0.7777... = +38.89 (fewer empty miles)
    expect(by.deadhead).toBe(38.89);
    // x_B = 945/1050 = 0.9: costs = -(0.9 - 0.7777...) x 1050 = -128.33
    expect(by.costs).toBe(-128.33);
    expect(by.fsc).toBe(60);
    expect(by.detention).toBe(90);
    expect(by.other).toBeUndefined();
    expect(sum(r)).toBe(70_500);
  });

  test("no change, no effects", () => {
    const a = week([load()]);
    expect(bridgeOf(a, a)).toMatchObject({ change: 0, effects: [] });
    expect(bridgeOf(ZERO_WEEK, ZERO_WEEK)).toMatchObject({ before: 0, after: 0, change: 0, effects: [] });
  });

  test("a lane that ran in only one of the weeks is one effect, not a guessed split of rate and miles", () => {
    const b = week([load({ detention: 40, other: 25 })]);
    const started = bridgeOf(ZERO_WEEK, b);
    expect(started.method).toBe("whole");
    expect(started.effects.map((e) => e.key)).toEqual(["fsc", "other", "detention", "lane"]);
    expect(started.effects.find((e) => e.key === "lane")!.dollars).toBe(1300); // 2000 line haul less 700 costs
    expect(sum(started)).toBe(Math.round(started.change * 100));
    const stopped = bridgeOf(b, ZERO_WEEK);
    expect(stopped.change).toBe(-started.change);
    expect(stopped.effects.find((e) => e.key === "lane")!.dollars).toBe(-1300);
    // A week of TONU fees only has no loaded miles: also whole.
    expect(bridgeOf(week([load()]), week([load({ loadedMiles: 0, drivenMiles: 0, lineHaul: 0, fsc: 0, other: 150, expenses: 0 })])).method).toBe("whole");
  });

  test("the effects add to the change to the cent on any pair of weeks (a fixed pseudo-random sweep, with awkward mile counts and cent amounts)", () => {
    let seed = 20261106;
    const rnd = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed / 4_294_967_296;
    };
    const wk = () => {
      const n = 1 + Math.floor(rnd() * 6);
      return week(
        Array.from({ length: n }, () => {
          const loaded = Math.round(rnd() * 1500 * 10) / 10;
          const empty = Math.round(rnd() * 300 * 10) / 10;
          return load({
            loadedMiles: loaded,
            // Now and then the miles driven are not exactly loaded plus a clean empty figure: the bridge must still add up.
            drivenMiles: rnd() < 0.15 ? loaded + empty + Math.round(rnd() * 40) : loaded + empty,
            lineHaul: Math.round(rnd() * 400_000) / 100,
            fsc: Math.round(rnd() * 40_000) / 100,
            other: rnd() < 0.2 ? Math.round(rnd() * 20_000) / 100 : 0,
            detention: rnd() < 0.2 ? Math.round(rnd() * 15_000) / 100 : 0,
            expenses: rnd() < 0.8 ? Math.round(rnd() * 150_000) / 100 : 0
          });
        })
      );
    };
    let split = 0;
    for (let i = 0; i < 2000; i++) {
      const r = bridgeOf(rnd() < 0.05 ? ZERO_WEEK : wk(), rnd() < 0.05 ? ZERO_WEEK : wk());
      if (r.method === "split") split += 1;
      expect(sum(r), `case ${i}`).toBe(Math.round(r.change * 100));
      expect(Math.round(r.change * 100)).toBe(Math.round(r.after * 100) - Math.round(r.before * 100));
      // Only non-zero effects, in the fixed order.
      expect(r.effects.every((e) => e.dollars !== 0)).toBe(true);
      expect(r.effects.map((e) => EFFECT_ORDER.indexOf(e.key))).toEqual([...r.effects.map((e) => EFFECT_ORDER.indexOf(e.key))].sort((x, y) => x - y));
    }
    expect(split).toBeGreaterThan(1500);
  });

  test("reversing the weeks reverses what happened on the revenue side that does not depend on which week prices the miles", () => {
    const a = week([load({ fsc: 100, other: 10, detention: 0 })]);
    const b = week([load({ fsc: 160, other: 40, detention: 55 })]);
    const fwd = bridgeOf(a, b);
    const back = bridgeOf(b, a);
    expect(back.change).toBe(-fwd.change);
    for (const k of ["fsc", "other", "detention"] as const) expect(back.effects.find((e) => e.key === k)?.dollars).toBe(-(fwd.effects.find((e) => e.key === k)?.dollars ?? 0));
  });
});

describe("the rows", () => {
  const A = (lane: string, over: Partial<MoveLoad> = {}) => load({ lane, ...over });
  test("grouped by lane or by customer, biggest change first, and the rows' changes add to the desk's", () => {
    const before = [A("A → B", { lineHaul: 1000, expenses: 300 }), A("C → D", { lineHaul: 500, expenses: 100, customer: "Zed" }), A("E → F", { lineHaul: 900, expenses: 300, customer: "Zed" })];
    const after = [A("A → B", { lineHaul: 1800, expenses: 350 }), A("C → D", { lineHaul: 450, expenses: 100, customer: "Zed" }), A("G → H", { lineHaul: 700, expenses: 200, customer: null })];
    const lanes = moveRows(before, after, "lane");
    // Each lane has a 200 fuel surcharge: E → F stopped (900 + 200 - 300 = 800 lost); A → B gained 750 (900 to 1650); G → H started (+700); C → D slipped by 50. Biggest move first, whichever way it went.
    expect(lanes.map((r) => [r.label, r.bridge.change])).toEqual([["E → F", -800], ["A → B", 750], ["G → H", 700], ["C → D", -50]]);
    const deskBefore = resultOf(totalsOf(before));
    const deskAfter = resultOf(totalsOf(after));
    expect(Math.round(lanes.reduce((s, r) => s + r.bridge.change * 100, 0))).toBe(Math.round((deskAfter - deskBefore) * 100));
    const customers = moveRows(before, after, "customer");
    expect(customers.map((r) => r.label).sort()).toEqual(["Acme", "No customer", "Zed"]);
    expect(Math.round(customers.reduce((s, r) => s + r.bridge.change * 100, 0))).toBe(Math.round((deskAfter - deskBefore) * 100));
  });

  test("loads with no tracked cost are counted, because the cost lines read low without them", () => {
    expect(withoutCosts([load(), load({ expenses: 0 }), load({ expenses: 0 })])).toBe(2);
  });
});
