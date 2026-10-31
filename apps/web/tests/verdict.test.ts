import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { FLOOR_AT, VERDICT_TONE, VERDICT_WORD, bookingGate, groundOf, marketPerMile, readVerdict, rulerOf, verdictState, type VerdictFacts } from "@/lib/verdict";

const facts = (over: Partial<VerdictFacts> = {}): VerdictFacts => ({ band: "above_market", gate: null, allInPerMile: 2.34, floorPerMile: 1.5, marginPerMile: 0.84, leftOver: 287, totalMiles: 342, gross: 800, marketDollars: 379, marketPct: 0.9, payNeeded: 513, thinMargin: false, timeTrap: false, profitPerHour: 40, hourlyTarget: 25, ...over });

describe("the four states", () => {
  test("every band lands in one state, and the audited rules are not judged again", () => {
    expect(verdictState(facts({ band: "above_market" }))).toBe("take");
    expect(verdictState(facts({ band: "at_market" }))).toBe("take");
    expect(verdictState(facts({ band: "negotiate" }))).toBe("think");
    expect(verdictState(facts({ band: "strong_caution", gate: "under_market" }))).toBe("reject"); // more than 20% under: the audited hard stop
    expect(verdictState(facts({ band: "no_benchmark", gate: "no_market" }))).toBe("take"); // no market rate: judged on cost alone
    expect(verdictState(facts({ band: "below_floor", gate: "below_floor" }))).toBe("reject");
    expect(verdictState(facts({ band: "needs_fuel", gate: "needs_fuel" }))).toBe("unjudged");
  });

  test("Reject is the audited hard stops and nothing else: ten percent and twenty percent under are Think twice, past twenty is Reject", () => {
    expect(verdictState(facts({ band: "at_market" }))).toBe("take");
    expect(verdictState(facts({ band: "negotiate" }))).toBe("think");
    expect(verdictState(facts({ band: "strong_caution", gate: "under_market" }))).toBe("reject");
    // thin or slow money never rejects: they are a second look, not a stop
    expect(verdictState(facts({ thinMargin: true }))).toBe("think");
    expect(verdictState(facts({ timeTrap: true }))).toBe("think");
  });

  test("a good load the rules would pause on is never Take it: a gate, a thin margin, or slow money", () => {
    expect(verdictState(facts({ gate: "under_market" }))).toBe("think");
    expect(verdictState(facts({ thinMargin: true }))).toBe("think");
    expect(verdictState(facts({ timeTrap: true }))).toBe("think");
  });

  test("the market can never rescue a load below its cost, however far above the market it pays", () => {
    expect(verdictState(facts({ band: "below_floor", gate: "below_floor", marketPct: 2 }))).toBe("reject");
  });

  test("with the fuel unknown there is no cost to judge, so a far-under-market load is not rejected on the market alone", () => {
    expect(verdictState(facts({ band: "needs_fuel", gate: "needs_fuel", marketPct: -0.4 }))).toBe("unjudged");
  });

  test("each state has its own word; the one with nothing to judge has no tone at all", () => {
    expect(Object.keys(VERDICT_WORD).sort()).toEqual(["reject", "take", "think", "unjudged"]);
    expect(new Set(Object.values(VERDICT_WORD)).size).toBe(4);
    expect(VERDICT_TONE).toEqual({ take: "ok", think: "warn", reject: "bad", unjudged: "none" });
  });
});

describe("the sentence", () => {
  test("says the verdict with the money in it", () => {
    expect(readVerdict(facts()).sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip, and pays above the market.");
    expect(readVerdict(facts({ band: "at_market" })).sentence).toContain("about what the market does");
  });

  test("names what is wrong with a load worth a second look", () => {
    expect(readVerdict(facts({ band: "negotiate", marketPct: -0.14 })).sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip, but pays 14% under the market. Ask for more.");
    expect(readVerdict(facts({ band: "strong_caution", gate: "under_market", marketPct: -0.31 })).sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip, but pays 31% under the market. Too far under to take.");
    expect(readVerdict(facts({ band: "strong_caution", gate: "under_market", marketPct: -0.31 })).word).toBe("Reject");
    expect(readVerdict(facts({ band: "at_market", thinMargin: true })).sentence).toBe("It clears your cost, but by less than five cents a mile.");
    expect(readVerdict(facts({ band: "at_market", timeTrap: true, profitPerHour: 12 })).sentence).toContain("$12 an hour against your $25 target");
  });

  test("below cost, it says how far and what would cover it", () => {
    const v = readVerdict(facts({ band: "below_floor", gate: "below_floor", marginPerMile: -0.31, leftOver: -106, payNeeded: 906 }));
    expect(v.word).toBe("Reject");
    expect(v.sentence).toBe("Short of your cost by $0.31/mi, $106 on this trip. It would have to pay $906 to cover it.");
  });

  test("with nothing to judge it says what is missing, not a guess", () => {
    const v = readVerdict(facts({ band: "needs_fuel", gate: "needs_fuel", marginPerMile: null, leftOver: null }));
    expect(v.sentence).toContain("no mpg or fuel price");
    expect(v.sentence).not.toMatch(/\$/);
  });
});

describe("a load with no market rate", () => {
  const blank = facts({ band: "no_benchmark", gate: "no_market", marketDollars: null, marketPct: null });

  test("is judged on its cost alone: it can be Take it, and the card says the market was not checked", () => {
    const v = readVerdict(blank);
    expect(v.state).toBe("take");
    expect(v.sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip. Market not checked.");
    expect(v.ruler!.market).toBeNull();
  });

  test("needs no reason to book; every other gate still does", () => {
    expect(bookingGate("no_market")).toBeNull();
    for (const g of ["below_floor", "needs_fuel", "under_market"] as const) expect(bookingGate(g)).toBe(g);
    expect(bookingGate(null)).toBeNull();
  });

  test("gets no free pass: below its cost, thin, or slow money it says so as it would with a market rate", () => {
    expect(verdictState({ ...blank, band: "below_floor", gate: "below_floor" })).toBe("reject");
    expect(verdictState({ ...blank, thinMargin: true })).toBe("think");
    expect(verdictState({ ...blank, timeTrap: true })).toBe("think");
    expect(verdictState({ ...blank, band: "needs_fuel", gate: "needs_fuel" })).toBe("unjudged");
  });
});

describe("a load read against its own lane", () => {
  const lane = (over: Partial<VerdictFacts> = {}) => facts({ benchmark: "lane", ...over });

  test("says whose number it is: the lane's, never the market's", () => {
    expect(readVerdict(lane()).sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip, and pays above your lane average.");
    expect(readVerdict(lane({ band: "at_market" })).sentence).toContain("about what this lane usually pays you");
    expect(readVerdict(lane({ band: "negotiate", marketPct: -0.14 })).sentence).toBe("Clears your cost by $0.84/mi, $287 on this trip, but pays 14% under your lane average. Ask for more.");
    expect(readVerdict(lane({ band: "strong_caution", gate: "under_market", marketPct: -0.31 })).sentence).toContain("31% under your lane average. Too far under to take.");
    expect(readVerdict(lane()).ruler!.marketName).toBe("Your lane");
    expect(readVerdict(facts()).ruler!.marketName).toBe("Market");
  });

  test("moves a good load as a market rate would, and can never rescue one below its cost", () => {
    expect(readVerdict(lane({ band: "strong_caution", gate: "under_market" })).state).toBe("reject");
    expect(readVerdict(lane({ band: "below_floor", gate: "below_floor", marketPct: 2 })).state).toBe("reject");
  });

  test("is the desk's own record, so it is not taken on trust", () => {
    const market = groundOf({ miles: "measured", fuel: "own", market: { laneLoads: 3, laneDays: 90 }, driver: true })[2]!;
    expect(market).toEqual({ label: "Your 3 loads on this lane in the last 90 days", firm: true });
    expect(groundOf({ miles: "measured", fuel: "own", market: { laneLoads: 5, laneDays: 30 }, driver: true })[2]!.label).toBe("Your 5 loads on this lane in the last 30 days");
  });
});

describe("the ruler", () => {
  test("the floor is always in the same place, so a load is read by where it lands", () => {
    for (const [floor, offer] of [[1.5, 2.34], [1.5, 1.0], [0.9, 4], [3, 3.01]] as const) expect(rulerOf({ floor, offer, market: null }).floor.at).toBe(FLOOR_AT);
  });

  test("right of the floor pays and left of it loses, and every mark stays on the line", () => {
    const pays = rulerOf({ floor: 1.5, offer: 2.34, market: 1.23 });
    expect(pays.offer.at).toBeGreaterThan(FLOOR_AT);
    expect(pays.market!.at).toBeLessThan(FLOOR_AT);
    const loses = rulerOf({ floor: 1.5, offer: 1.2, market: 2.9 });
    expect(loses.offer.at).toBeLessThan(FLOOR_AT);
    expect(loses.market!.at).toBeGreaterThan(FLOOR_AT);
    for (const r of [pays, loses, rulerOf({ floor: 2, offer: 0.1, market: 50 })]) for (const m of [r.offer, r.market!]) {
      expect(m.at).toBeGreaterThanOrEqual(0);
      expect(m.at).toBeLessThanOrEqual(100);
    }
  });

  test("a dollar is the same length on both sides of the floor", () => {
    const r = rulerOf({ floor: 2, offer: 2.5, market: 1.5 });
    expect(r.offer.at - r.floor.at).toBeCloseTo(r.floor.at - r.market!.at, 5);
  });

  test("it does not zoom in: two cents over the floor looks like two cents", () => {
    const r = rulerOf({ floor: 2, offer: 2.02, market: null });
    expect(r.offer.at - FLOOR_AT).toBeLessThan(5);
  });

  test("with no market rate there is no market mark, and with no known cost there is no ruler", () => {
    expect(rulerOf({ floor: 1, offer: 2, market: null }).market).toBeNull();
    expect(readVerdict(facts({ band: "needs_fuel", gate: "needs_fuel" })).ruler).toBeNull();
    expect(readVerdict(facts({ allInPerMile: null })).ruler).toBeNull();
  });

  test("the market is put on the same footing as the load: its total over the same miles", () => {
    expect(marketPerMile({ gross: 800, marketDollars: 379, totalMiles: 342 })).toBeCloseTo(421 / 342, 5);
    expect(marketPerMile({ gross: 800, marketDollars: null, totalMiles: 342 })).toBeNull();
    expect(marketPerMile({ gross: 800, marketDollars: 100, totalMiles: 0 })).toBeNull();
  });
});

describe("what a verdict stands on", () => {
  test("says which inputs are firm and which are taken on trust, and a typed market rate is never firm", () => {
    expect(groundOf({ miles: "measured", fuel: "own", market: "typed", driver: true }).map((g) => g.firm)).toEqual([true, true, false, true]);
    const shaky = groundOf({ miles: "typed", fuel: "none", market: "none", driver: false });
    expect(shaky.every((g) => !g.firm)).toBe(true);
    expect(shaky.map((g) => g.label)).toEqual(["Miles as typed", "No fuel price", "Market not checked", "No driver on this truck"]);
  });
});

describe("the card's skeleton (docs/VERDICT_CARD.md)", () => {
  const src = (p: string) => readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");
  const desk = src("src/components/desk/quote-desk.tsx");
  const card = src("src/components/desk/verdict-card.tsx");
  const css = src("src/app/(desk)/desk.css");
  const panel = desk.slice(desk.indexOf("function VerdictPanel("));

  test("keeps its order: the word and why, the figure, the ruler, the working, what it rests on", () => {
    const at = ["<VerdictHead", 'className="qt-big"', "<VerdictRuler", 'className="rc-facts"', 'className="vc-trust"'].map((s) => panel.indexOf(s));
    expect(at.every((n) => n >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  test("each state has its own road shape, and the empty one is a ring with no fill", () => {
    expect(card).toContain('<circle className="vc-fill"');
    expect(card).toContain('d="M18 1.5L34.5 18 18 34.5 1.5 18z"'); // the diamond
    expect(card).toContain('d="M11.2 2h13.6L34 11.2v13.6L24.8 34H11.2L2 24.8V11.2z"'); // the octagon
    expect(card).toContain('className="vc-ring"');
  });

  test("hue never carries the verdict alone: the word and the figure are plain text colour, the sign keeps a light edge, and there is one light", () => {
    expect(css).toMatch(/\.vc-word \{[^}]*color: var\(--db-fg\);/);
    expect(css).toMatch(/\.vc-fill \{[^}]*stroke:/);
    expect(css).not.toMatch(/\.qt-side \.qt-big \{[^}]*text-shadow/);
    expect(css).not.toMatch(/\.qt-side::after/);
  });

  test("the buttons say the verdict too: on a Reject, rejecting is the main button and booking is Book anyway", () => {
    const actions = desk.slice(desk.indexOf('<div className="qt-actions">'), desk.indexOf("</aside>"));
    expect(actions).toMatch(/verdict\?\.state === "reject" \? \(\s*<button type="button" className="tl-btn primary"[^>]*onClick=\{onOpenPass\}>\s*Reject it/);
    expect(actions).toContain("Book anyway");
    expect(desk).toContain('"Book with a reason"');
  });
});
