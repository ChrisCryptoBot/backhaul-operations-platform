import { describe, expect, test } from "vitest";
import { isoWeekOf, localParts, reportDue, reportNotice, weekKeyAt, type WeeklyReport } from "@/lib/weekly-report";

const CT = "America/Chicago";
const at = (iso: string) => new Date(iso).getTime();

describe("which week it is", () => {
  test("ISO weeks: Monday first, and the year's first Thursday decides week 1", () => {
    expect(isoWeekOf(2026, 11, 5)).toEqual({ year: 2026, week: 45 });
    expect(isoWeekOf(2026, 1, 1)).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf(2024, 12, 30)).toEqual({ year: 2025, week: 1 });
    expect(isoWeekOf(2021, 1, 3)).toEqual({ year: 2020, week: 53 });
    expect(isoWeekOf(2026, 11, 8)).toEqual({ year: 2026, week: 45 }); // the Sunday ends its week
    expect(isoWeekOf(2026, 11, 9)).toEqual({ year: 2026, week: 46 });
  });

  test("the carrier's clock decides the day: late Sunday evening in Chicago is still Sunday", () => {
    // 2026-11-09 03:30 UTC is Sunday 21:30 in Chicago (standard time).
    expect(localParts(at("2026-11-09T03:30:00Z"), CT)).toEqual({ y: 2026, m: 11, d: 8, hour: 21, weekday: 0 });
    expect(weekKeyAt(at("2026-11-09T03:30:00Z"), CT)).toBe("2026-W45");
    expect(weekKeyAt(at("2026-11-09T03:30:00Z"), "UTC")).toBe("2026-W46");
  });
});

describe("when the weekly report is due", () => {
  const mon7 = { reportEnabled: true, reportDay: 1, reportHour: 7 };
  test("not before the hour, due from it, and still due later in the same week (a missed run catches up)", () => {
    expect(reportDue(mon7, at("2026-11-09T12:59:00Z"), CT)).toEqual({ due: false, weekKey: "2026-W46" }); // Monday 06:59
    expect(reportDue(mon7, at("2026-11-09T13:00:00Z"), CT)).toEqual({ due: true, weekKey: "2026-W46" }); // Monday 07:00
    expect(reportDue(mon7, at("2026-11-12T18:00:00Z"), CT).due).toBe(true); // Thursday
    // Sunday evening is the end of week 45, after its Monday slot: still due for week 45 if nothing went (the ledger's week key is what stops a second one), and it is not week 46's.
    expect(reportDue(mon7, at("2026-11-09T02:00:00Z"), CT)).toEqual({ due: true, weekKey: "2026-W45" });
  });
  test("a Sunday report is the last of its week; Wednesday does not reach it, Sunday evening does", () => {
    const sun = { reportEnabled: true, reportDay: 0, reportHour: 18 };
    expect(reportDue(sun, at("2026-11-11T18:00:00Z"), CT).due).toBe(false); // Wednesday
    expect(reportDue(sun, at("2026-11-09T00:30:00Z"), CT)).toEqual({ due: true, weekKey: "2026-W45" }); // Sunday 18:30 Chicago
  });
  test("off means never", () => {
    expect(reportDue({ ...mon7, reportEnabled: false }, at("2026-11-09T14:00:00Z"), CT).due).toBe(false);
  });
});

const report = (over: Partial<WeeklyReport> = {}): WeeklyReport => ({
  weekKey: "2026-W46",
  asOf: at("2026-11-09T13:00:00Z"),
  windowLabel: "Last four weeks",
  headline: { loads: 42, gross: 63500, rpm: 2.31, emptyShare: 0.184 },
  leaks: { total: 5400, items: 9, unpriced: 2, lines: [{ label: "Empty miles", dollars: 3100, items: 5 }, { label: "Detention not billed", dollars: 2300, items: 4 }], openDwellDollars: 450, openDwellTrailers: 2 },
  health: { score: 82.4, gaps: [{ label: "Loads with no delivery time", gaps: 6 }] },
  signals: { open: { block: 3, warn: 9, info: 4 }, acknowledged: 2, oldestOpenDays: 11, newThisWeek: 7, clearedThisWeek: 5 },
  ...over
});

describe("the report as a notice", () => {
  test("lines up the desk's own figures, with the link and the week as its key", () => {
    const n = reportNotice(report(), "https://desk.example.com");
    expect(n.kind).toBe("weekly_report");
    expect(n.dedupeKey).toBe("report:2026-W46");
    expect(n.subject).toBe("Weekly report, 2026-W46: 16 open signals, $5,400 leaked");
    expect(n.text).toContain("Last four weeks: 42 finished loads, $63,500 gross, $2.31 a mile, 18.4% empty miles.");
    expect(n.text).toContain("Leak Ledger: $5,400 across 9 items (2 with no price yet).");
    expect(n.text).toContain("  Empty miles: $3,100 (5)");
    expect(n.text).toContain("Trailers waiting right now: 2, $450 owed and not billed.");
    expect(n.text).toContain("Data health: 82 out of 100.");
    expect(n.text).toContain("Signals: 16 open (3 block, 9 warn, 4 info), 2 acknowledged; 7 new and 5 cleared this week; the oldest open one is 11 days old.");
    expect(n.text).toContain("Open: https://desk.example.com/signals");
    expect(n.dollars).toBe(5400);
    expect((n.data as { report: WeeklyReport }).report.weekKey).toBe("2026-W46");
  });

  test("an empty week says so instead of showing zeros as findings", () => {
    const n = reportNotice(report({ leaks: { total: 0, items: 0, unpriced: 0, lines: [], openDwellDollars: 0, openDwellTrailers: 0 }, health: { score: null, gaps: [] }, signals: { open: { block: 0, warn: 0, info: 0 }, acknowledged: 0, oldestOpenDays: null, newThisWeek: 0, clearedThisWeek: 0 } }), null);
    expect(n.text).toContain("Leak Ledger: nothing leaked in the period.");
    expect(n.text).toContain("Data health: nothing to check yet.");
    expect(n.text).not.toContain("oldest open");
    expect(n.text).not.toContain("Open: ");
    expect(n.deskUrl).toBeNull();
  });
});
