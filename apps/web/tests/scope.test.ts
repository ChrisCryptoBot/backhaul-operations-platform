import { describe, expect, test } from "vitest";
import { UNASSIGNED, allowedNames, buildMenu, choiceFor, choiceText, chosenNames, parseChoice, resolveScope, termList, termsOf, type RegionInfo, type ScopeChoice, type ScopeLimit } from "@/lib/scope";

const TERMS = ["Dallas", "Houston", "Austin", "Memphis", "Nashville", "Tulsa"];
const REGIONS: RegionInfo[] = [
  { id: "rTX", name: "Texas", terminals: ["Dallas", "Houston", "Austin"] },
  { id: "rSE", name: "Southeast", terminals: ["Memphis", "Nashville"] },
  { id: "rEmpty", name: "Empty", terminals: [] }
]; // Tulsa is in no region
const ALL: ScopeLimit = { kind: "all" };
const some = (regionIds: string[], terminals: string[] = []): ScopeLimit => ({ kind: "some", regionIds, terminals });
const pick = (names: string[]): ScopeChoice => ({ kind: "terminals", names });
const resolve = (choice: ScopeChoice | null, limit: ScopeLimit, admin = false) => resolveScope({ choice, limit, regions: REGIONS, terminals: TERMS, admin });

describe("the scope cookie", () => {
  test("a choice survives the cookie both ways", () => {
    for (const c of [{ kind: "all" }, { kind: "region", id: "rTX" }, { kind: "terminals", names: ["Dallas", "New Orleans"] }] as ScopeChoice[]) expect(parseChoice(choiceText(c))).toEqual(c);
    expect(parseChoice(encodeURIComponent("t:Dallas|New Orleans"))).toEqual({ kind: "terminals", names: ["Dallas", "New Orleans"] });
  });

  test("an older cookie holding one terminal's name still works; nothing and nonsense are no choice", () => {
    expect(parseChoice("Dallas")).toEqual({ kind: "terminals", names: ["Dallas"] });
    expect(parseChoice("")).toBeNull();
    expect(parseChoice(null)).toBeNull();
    expect(parseChoice("r:")).toBeNull();
    expect(parseChoice("t:| |")).toBeNull();
  });

  test("a terminal or several are a list, and none is everything", () => {
    expect(termList("Dallas")).toEqual(["Dallas"]);
    expect(termList(["A", "B"])).toEqual(["A", "B"]);
    expect(termList(null)).toBeNull();
  });
});

describe("what a person is allowed", () => {
  test("not limited is everything; limited is the union of the regions and terminals named, those that exist", () => {
    expect(allowedNames(ALL, REGIONS, TERMS)).toBeNull();
    expect(allowedNames(some(["rTX"]), REGIONS, TERMS)).toEqual(["Dallas", "Houston", "Austin"]);
    expect(allowedNames(some(["rSE"], ["tulsa", "Gone"]), REGIONS, TERMS)).toEqual(["Memphis", "Nashville", "Tulsa"]);
    expect(allowedNames(some(["rGone"]), REGIONS, TERMS)).toEqual([]);
  });
});

describe("the effective scope: a choice inside a limit, never past it", () => {
  test("someone not limited who has chosen nothing sees everything; an admin who has chosen nothing is never shown all silently", () => {
    expect(resolve(null, ALL)).toMatchObject({ names: null, label: "All terminals", limited: false });
    const a = resolve(null, ALL, true);
    expect(a).toMatchObject({ names: ["Memphis", "Nashville"], label: "Southeast region", chosen: false, limited: false });
    expect(resolve(null, ALL, true).regionId).toBe("rSE"); // first by name
    expect(resolve({ kind: "all" }, ALL, true)).toMatchObject({ names: null, chosen: true }); // "All" one click away
  });

  test("an admin of a fleet with no regions is simply on all", () => {
    expect(resolveScope({ choice: null, limit: ALL, regions: [], terminals: TERMS, admin: true })).toMatchObject({ names: null, chosen: true }); // nothing to pick from, so nothing to prompt
  });

  test("a choice narrows what a person sees: a region, the unassigned ones, or terminals picked", () => {
    expect(resolve({ kind: "region", id: "rTX" }, ALL)).toMatchObject({ names: ["Dallas", "Houston", "Austin"], kind: "region", label: "Texas region", regionId: "rTX" });
    expect(resolve({ kind: "region", id: UNASSIGNED }, ALL)).toMatchObject({ names: ["Tulsa"], label: "Tulsa terminal" });
    expect(resolve(pick(["dallas", "Memphis"]), ALL)).toMatchObject({ names: ["Dallas", "Memphis"], kind: "terminals", label: "2 terminals" });
    expect(resolve(pick(["Gone"]), ALL)).toMatchObject({ names: null }); // a terminal nobody uses any more is dropped, not an empty desk
  });

  test("a dispatcher pointed at Texas sees Texas, can narrow to one of its terminals, and cannot choose their way to Memphis", () => {
    const tx = some(["rTX"]);
    expect(resolve(null, tx)).toMatchObject({ names: ["Dallas", "Houston", "Austin"], label: "Texas region", limited: true });
    expect(resolve(pick(["Houston"]), tx)).toMatchObject({ names: ["Houston"], label: "Houston terminal", limited: true });
    expect(resolve(pick(["Memphis"]), tx).names).toEqual(["Dallas", "Houston", "Austin"]); // outside the limit: the whole limit
    expect(resolve({ kind: "region", id: "rSE" }, tx).names).toEqual(["Dallas", "Houston", "Austin"]);
    expect(resolve(pick(["Houston", "Memphis"]), tx).names).toEqual(["Houston"]); // the part of the choice that is inside
    expect(resolve({ kind: "all" }, tx)).toMatchObject({ names: ["Dallas", "Houston", "Austin"], limited: true }); // "All" for a limited person is everything they may see
  });

  test("Dallas and Houston assigned: the label says two terminals, and Memphis is out of reach", () => {
    const r = resolve(null, some([], ["Dallas", "Houston"]));
    expect(r).toMatchObject({ names: ["Dallas", "Houston"], label: "2 terminals", kind: "terminals" });
    expect(resolve(pick(["Memphis"]), some([], ["Dallas", "Houston"])).names).toEqual(["Dallas", "Houston"]);
  });

  test("limited to a region that is gone or to nothing real: an empty scope, never everything", () => {
    expect(resolve(null, some(["rGone"]))).toMatchObject({ names: [], label: "No terminals", limited: true });
    expect(resolve({ kind: "all" }, some([], ["Gone"])).names).toEqual([]);
  });

  test("the value a scoped function takes", () => {
    expect(termsOf(resolve(null, ALL))).toBeNull();
    expect(termsOf(resolve(pick(["Houston"]), ALL))).toBe("Houston");
    expect(termsOf(resolve({ kind: "region", id: "rTX" }, ALL))).toEqual(["Dallas", "Houston", "Austin"]);
    expect(termsOf(resolve(null, some(["rGone"])))).toEqual([]);
  });

  test("chosenNames reads a choice on its own", () => {
    expect(chosenNames(null, REGIONS, TERMS)).toBeUndefined();
    expect(chosenNames({ kind: "region", id: "rEmpty" }, REGIONS, TERMS)).toBeUndefined();
    expect(chosenNames({ kind: "all" }, REGIONS, TERMS)).toBeNull();
  });
});

describe("the header menu", () => {
  const counts = new Map([["dallas", { trucks: 40, drivers: 50 }], ["houston", { trucks: 60, drivers: 70 }], ["austin", { trucks: 5, drivers: 5 }], ["memphis", { trucks: 9, drivers: 8 }], ["tulsa", { trucks: 2, drivers: 3 }]]);

  test("everyone not limited is offered all, each region with what is based there, and the unassigned ones", () => {
    const m = buildMenu({ regions: REGIONS, terminals: TERMS, counts, allowed: null });
    expect(m.canAll).toBe(true);
    expect(m.regions.map((r) => [r.name, r.trucks, r.drivers])).toEqual([["Southeast", 9, 8], ["Texas", 105, 125]]);
    expect(m.unassigned).toEqual([{ name: "Tulsa", trucks: 2, drivers: 3 }]);
    expect(m.total).toEqual({ trucks: 9 + 105 + 2, drivers: 8 + 125 + 3 });
  });

  test("a limited person is offered only what they may see, and no all", () => {
    const m = buildMenu({ regions: REGIONS, terminals: TERMS, counts, allowed: ["Dallas", "Houston"] });
    expect(m.canAll).toBe(false);
    expect(m.regions).toHaveLength(1);
    expect(m.regions[0]!.terminals.map((t) => t.name)).toEqual(["Dallas", "Houston"]);
    expect(m.unassigned).toEqual([]);
  });

  test("ticked terminals turn back into the simplest choice", () => {
    expect(choiceFor(TERMS, REGIONS, TERMS)).toEqual({ kind: "all" });
    expect(choiceFor([], REGIONS, TERMS)).toEqual({ kind: "all" });
    expect(choiceFor(["Houston", "Dallas", "Austin"], REGIONS, TERMS)).toEqual({ kind: "region", id: "rTX" });
    expect(choiceFor(["Dallas", "Memphis"], REGIONS, TERMS)).toEqual({ kind: "terminals", names: ["Dallas", "Memphis"] });
  });
});
