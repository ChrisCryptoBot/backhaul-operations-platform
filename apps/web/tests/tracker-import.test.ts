import { describe, expect, test } from "vitest";
import { autoWeekMap, checkWeekRows, cleanWeekMap, laneParts, lanesOf, missingWeekFields, mondayOf, weekImportTemplate, weekKeyOf, weeksOf, type HistoryRow, type WeekMap } from "@/lib/tracker-import";
import { parseCsv } from "@/lib/import-csv";

const HEADER = ["Week Ending", "Lane", "Loads", "Revenue", "FSC", "Miles", "Deadhead"];
const NOW = Date.parse("2026-11-05T12:00:00Z");
const row = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = { "Week Ending": "2026-09-20", Lane: "Dallas, TX to Atlanta, GA", Loads: "6", Revenue: "$12,900.00", FSC: "1080", Miles: "4,686", Deadhead: "300", ...over };
  return HEADER.map((h) => base[h] ?? "");
};
const table = (...rows: string[][]) => [HEADER, ...rows];
const map = () => autoWeekMap(HEADER);
const none = new Set<string>();

describe("matching a tracker's columns", () => {
  test("a tracker's own words are matched, each column once", () => {
    const m = map();
    expect([m.week, m.lane, m.loads, m.lineHaul, m.fuelSurcharge, m.loadedMiles, m.emptyMiles]).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(missingWeekFields(m)).toEqual([]);
  });

  test("the desk's own template matches itself", () => {
    const m = autoWeekMap(parseCsv(weekImportTemplate())[0]!);
    expect(missingWeekFields(m)).toEqual([]);
  });

  test("a lane is one column, or a pickup and a delivery column; neither is named as missing", () => {
    const m = autoWeekMap(["Week", "Loads", "Line haul", "Loaded miles"]);
    expect(missingWeekFields(m).map((x) => x.key)).toEqual(["lane"]);
    const two = autoWeekMap(["Week", "Origin", "Destination", "Loads", "Line haul", "Loaded miles"]);
    expect(missingWeekFields(two)).toEqual([]);
    expect(missingWeekFields(autoWeekMap(["Week", "Origin", "Loads", "Line haul", "Loaded miles"])).map((x) => x.key)).toEqual(["lane"]);
  });

  test("a hand-edited match is cleaned", () => {
    const m = cleanWeekMap({ week: 0, lane: 0, loads: 99, lineHaul: 3 }, 4);
    expect([m.week, m.lane, m.loads, m.lineHaul]).toEqual([0, null, null, 3]);
  });
});

describe("weeks and lanes", () => {
  test("any day of a week is that week's Monday, to Sunday", () => {
    for (const d of ["2026-09-14", "2026-09-16", "2026-09-20"]) expect(mondayOf(new Date(`${d}T12:00:00Z`)).toISOString().slice(0, 10)).toBe("2026-09-14");
    expect(mondayOf(new Date("2026-09-21T12:00:00Z")).toISOString().slice(0, 10)).toBe("2026-09-21");
  });

  test("a lane is two places split on to or an arrow, spelled the desk's way", () => {
    expect(laneParts("Dallas, TX to Atlanta, GA")).toEqual(["Dallas, TX", "Atlanta, GA"]);
    expect(laneParts("dallas tx -> atlanta ga")).toEqual(["Dallas, TX", "Atlanta, GA"]);
    expect(laneParts("Dallas, TX → Atlanta, GA")).toEqual(["Dallas, TX", "Atlanta, GA"]);
    expect(laneParts("Dallas, TX")).toBeNull();
    expect(laneParts("A to B to C")).toBeNull();
    expect(laneParts(" to Atlanta")).toBeNull();
  });
});

describe("checking rows", () => {
  test("a good row is a lane's week with its figures and the lane in the desk's spelling", () => {
    const c = checkWeekRows(table(row()), map(), none, NOW);
    expect(c).toMatchObject({ total: 1, problemCount: 0, duplicates: 0 });
    const d = c.good[0]!.item;
    expect(d.weekStart.toISOString().slice(0, 10)).toBe("2026-09-14"); // a Sunday's week ending is that week's Monday
    expect(d).toMatchObject({ lane: "Dallas, TX → Atlanta, GA", loads: 6, lineHaul: 12900, fuelSurcharge: 1080, loadedMiles: 4686, emptyMiles: 300 });
    expect(c.summary).toMatchObject({ weeks: 1, lanes: 1, loads: 6, revenue: 13980, first: "2026-09-14", last: "2026-09-14" });
  });

  test("empty miles come as a total, or as before plus after", () => {
    const h = ["Week", "From", "To", "Loads", "Line haul", "Loaded miles", "Empty before pickup", "Empty after delivery"];
    const m = autoWeekMap(h);
    expect(m.origin).toBe(1);
    const c = checkWeekRows([h, ["2026-09-14", "Dallas TX", "Tulsa OK", "2", "1000", "520", "40", "60"]], m, none, NOW);
    expect(c.good[0]!.item).toMatchObject({ lane: "Dallas, TX → Tulsa, OK", emptyMiles: 100 });
  });

  test("every mistake is named with its line; a week in the future and a lane that is not two places are refused", () => {
    const c = checkWeekRows(table(row(), row({ Loads: "0" }), row({ Loads: "2.5", "Week Ending": "tomorrow" }), row({ Lane: "Dallas", Revenue: "free" }), row({ "Week Ending": "2027-03-01" })), map(), none, NOW);
    expect(c.good).toHaveLength(1);
    expect(c.problemCount).toBe(4);
    expect(c.problems[0]!.errors.join(" ")).toMatch(/Loads must be at least 1/);
    expect(c.problems[1]!.errors.join(" ")).toMatch(/Week is not a date.*Loads is not a whole number/s);
    expect(c.problems[2]!.errors.join(" ")).toMatch(/Lane must name two places.*Line haul is not a dollar amount/s);
    expect(c.problems[3]!.errors.join(" ")).toMatch(/in the future/);
  });

  test("the same lane and week already imported, or twice in the file, is left out and counted apart", () => {
    const existing = new Set([weekKeyOf(new Date("2026-09-07T00:00:00Z"), "Dallas, TX → Atlanta, GA")]);
    const c = checkWeekRows(table(row({ "Week Ending": "2026-09-13" }), row(), row({ "Week Ending": "2026-09-18" }), row({ Lane: "dallas tx to atlanta ga", "Week Ending": "2026-09-16" }), row({ Lane: "Tulsa, OK to Joplin, MO" })), map(), existing, NOW);
    expect(c.good.map((g) => g.item.lane)).toEqual(["Dallas, TX → Atlanta, GA", "Tulsa, OK → Joplin, MO"]);
    expect(c.duplicates).toBe(3);
    expect(c.summary).toMatchObject({ weeks: 1, lanes: 2 });
  });

  test("a file past the row limit is refused whole", () => {
    expect(checkWeekRows(table(...Array.from({ length: 21_500 }, () => row())), map(), none, NOW)).toMatchObject({ tooMany: true, total: 0 });
  });

  test("a match with a missing column reads that field as empty", () => {
    const m: WeekMap = { ...map(), loads: null };
    expect(checkWeekRows(table(row()), m, none, NOW).problems[0]!.errors).toContain("Loads is empty.");
  });
});

describe("what the imported history shows", () => {
  const rows: HistoryRow[] = [
    { weekStart: "2026-09-14", lane: "A → B", loads: 6, lineHaul: 12000, fuelSurcharge: 900, loadedMiles: 4000, emptyMiles: 400 },
    { weekStart: "2026-09-14", lane: "C → D", loads: 2, lineHaul: 3000, fuelSurcharge: 100, loadedMiles: 1000, emptyMiles: 0 },
    { weekStart: "2026-09-07", lane: "A → B", loads: 5, lineHaul: 10000, fuelSurcharge: 800, loadedMiles: 3500, emptyMiles: 350 },
    { weekStart: "2026-09-07", lane: "E → F", loads: 1, lineHaul: 500, fuelSurcharge: 0, loadedMiles: 0, emptyMiles: 0 }
  ];

  test("weeks are added up oldest first; per mile is over loaded miles; empty share is over every mile driven", () => {
    const w = weeksOf(rows);
    expect(w.map((x) => x.weekStart)).toEqual(["2026-09-07", "2026-09-14"]);
    expect(w[1]).toMatchObject({ loads: 8, revenue: 16000, loadedMiles: 5000, emptyMiles: 400, lanes: 2 });
    expect(w[1]!.perLoadedMile).toBeCloseTo(3.2, 6);
    expect(w[1]!.emptyShare).toBeCloseTo(400 / 5400, 6);
    expect(w[0]!.lanes).toBe(2);
  });

  test("a week or lane with no miles has no per-mile figure, never zero or infinity", () => {
    const only: HistoryRow[] = [{ weekStart: "2026-09-07", lane: "E → F", loads: 1, lineHaul: 500, fuelSurcharge: 0, loadedMiles: 0, emptyMiles: 0 }];
    expect(weeksOf(only)[0]).toMatchObject({ perLoadedMile: null, emptyShare: null });
    expect(lanesOf(only)[0]).toMatchObject({ perLoadedMile: null, emptyShare: null });
  });

  test("lanes are added up with the biggest by revenue first and the weeks each ran", () => {
    const l = lanesOf(rows);
    expect(l.map((x) => [x.lane, x.loads, x.revenue, x.weeks])).toEqual([["A → B", 11, 23700, 2], ["C → D", 2, 3100, 1], ["E → F", 1, 500, 1]]);
  });
});
