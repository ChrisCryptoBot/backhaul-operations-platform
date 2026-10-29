import { describe, expect, test } from "vitest";
import { centralMidnight, centralParts } from "../src/lib/zoned";
import { asKpiPeriod, DAY_MS, inWindow, periodWindow, previousWindow, weekBuckets, WEEK_MS, windowLabel } from "../src/lib/kpi-periods";
import { emptyZone, resolveThresholds, THRESHOLD_DEFAULTS, validateThresholds, alertThresholds } from "../src/lib/thresholds";
import { csvCell, toCsv } from "../src/lib/csv";
import { binVariances, changeFraction, combineWeeks, deltaOf, growthOf, sparkPath, VARIANCE_BINS } from "../src/lib/kpi-view";
import { hasFilters, kpiHref, kpiQuery, parseKpiParams } from "../src/lib/kpi-params";
import { filterBoard, isBelowCost, searchBoard } from "../src/lib/board-filter";

const utc = (s: string) => Date.parse(s);

describe("Central-time calendar", () => {
  test("midnight Central is 5 hours after UTC midnight in summer and 6 in winter", () => {
    expect(centralMidnight(2026, 9, 1)).toBe(utc("2026-10-01T05:00:00Z"));
    expect(centralMidnight(2026, 11, 1)).toBe(utc("2026-12-01T06:00:00Z"));
  });

  test("across the fall change (clocks go back on 1 Nov 2026) and the spring one (8 Mar 2026)", () => {
    expect(centralMidnight(2026, 10, 1)).toBe(utc("2026-11-01T05:00:00Z")); // still daylight time at midnight
    expect(centralMidnight(2026, 10, 2)).toBe(utc("2026-11-02T06:00:00Z"));
    expect(centralMidnight(2026, 2, 8)).toBe(utc("2026-03-08T06:00:00Z"));
    expect(centralMidnight(2026, 2, 9)).toBe(utc("2026-03-09T05:00:00Z"));
  });

  test("months and days may overflow into the next one", () => {
    expect(centralMidnight(2026, 12, 1)).toBe(utc("2027-01-01T06:00:00Z"));
    expect(centralMidnight(2026, 1, 29)).toBe(centralMidnight(2026, 2, 1)); // 29 Feb 2026 does not exist
  });

  test("an instant reads as the Central date, not the UTC one", () => {
    expect(centralParts(utc("2026-11-01T04:59:00Z"))).toMatchObject({ y: 2026, m0: 9, d: 31, h: 23, min: 59 });
    expect(centralParts(utc("2026-11-01T06:30:00Z"))).toMatchObject({ m0: 10, d: 1, h: 1, min: 30 }); // 01:30 daylight time, an hour before the clocks go back
    expect(centralParts(utc("2026-11-01T08:30:00Z"))).toMatchObject({ m0: 10, d: 1, h: 2, min: 30 }); // 02:30 standard time, after
  });
});

describe("KPI periods and their comparisons", () => {
  const now = utc("2026-10-28T17:00:00Z"); // noon Central

  test("the four-week period compares with the four weeks before it, back to back", () => {
    const cur = periodWindow("4w", now);
    const prev = previousWindow("4w", now)!;
    expect(cur).toEqual({ start: now - 4 * WEEK_MS, end: now });
    expect(prev.end).toBe(cur.start! - 1);
    expect(prev.end - prev.start! + 1).toBe(4 * WEEK_MS);
  });

  test("this month starts at midnight Central on the 1st and compares with the same days of last month", () => {
    const cur = periodWindow("month", now);
    const prev = previousWindow("month", now)!;
    expect(cur.start).toBe(utc("2026-10-01T05:00:00Z"));
    expect(prev.start).toBe(utc("2026-09-01T05:00:00Z"));
    expect(prev.end - prev.start!).toBe(now - cur.start!);
  });

  test("a long month against a short one is capped so the windows never overlap", () => {
    const late = utc("2026-03-31T17:00:00Z");
    const cur = periodWindow("month", late);
    const prev = previousWindow("month", late)!;
    expect(prev.start).toBe(utc("2026-02-01T06:00:00Z"));
    expect(prev.end).toBe(cur.start! - 1);
  });

  test("year to date compares with the same dates last year", () => {
    expect(periodWindow("ytd", now).start).toBe(utc("2026-01-01T06:00:00Z"));
    const prev = previousWindow("ytd", now)!;
    expect(prev.start).toBe(utc("2025-01-01T06:00:00Z"));
    expect(prev.end).toBe(utc("2025-10-28T17:00:00Z"));
  });

  test("all time has nothing to compare against", () => {
    expect(periodWindow("all", now)).toEqual({ start: null, end: now });
    expect(previousWindow("all", now)).toBeNull();
  });

  test("a load belongs to the window its finish time falls in, both ends included", () => {
    const w = { start: 100, end: 200 };
    expect([99, 100, 200, 201].map((t) => inWindow(t, w))).toEqual([false, true, true, false]);
    expect(inWindow(-5, { start: null, end: 200 })).toBe(true);
  });

  test("an unknown period falls back to the last four weeks", () => {
    expect(asKpiPeriod("ytd")).toBe("ytd");
    expect(asKpiPeriod("decade")).toBe("4w");
    expect(asKpiPeriod(undefined)).toBe("4w");
  });

  test("twelve weekly buckets run oldest to newest with no gap", () => {
    const b = weekBuckets(now, 12);
    expect(b).toHaveLength(12);
    expect(b[11]!.end).toBe(now);
    for (let i = 1; i < b.length; i++) expect(b[i]!.start).toBe(b[i - 1]!.end);
    expect(b[0]!.end - b[0]!.start).toBe(7 * DAY_MS);
  });

  test("windows are labelled in Central dates", () => {
    expect(windowLabel({ start: utc("2026-10-01T05:00:00Z"), end: now }, now)).toBe("Oct 1 to Oct 28");
    expect(windowLabel({ start: null, end: now })).toBe("Everything up to Oct 28, 2026");
    expect(windowLabel(null)).toBe("");
    // last year's year to date carries the year, so it cannot be mistaken for this year's
    expect(windowLabel(previousWindow("ytd", now), now)).toBe("Jan 1, 2025 to Oct 28, 2025");
    expect(windowLabel(periodWindow("ytd", now), now)).toBe("Jan 1 to Oct 28");
  });
});

describe("thresholds", () => {
  test("a blank workspace gets the defaults, and stored values override them one by one", () => {
    expect(resolveThresholds(null)).toEqual(THRESHOLD_DEFAULTS);
    expect(resolveThresholds({ emptyRedPct: 40, detentionGraceMinutes: null })).toEqual({ ...THRESHOLD_DEFAULTS, emptyRedPct: 40 });
  });

  test("the alert timings are the ones the alert engine takes", () => {
    expect(alertThresholds({ ...THRESHOLD_DEFAULTS, pickupAlertHours: 12 })).toEqual({ pickupHours: 12, sentNoAnswerHours: 4, clearanceDays: 30 });
  });

  test("form input: blank means the default (null), numbers are kept", () => {
    const r = validateThresholds({ emptyAmberPct: "20", emptyRedPct: "", defaultPayTermsDays: "45", detentionGraceMinutes: "", pickupAlertHours: "", sentNoAnswerHours: "", clearanceDays: "" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.stored).toMatchObject({ emptyAmberPct: 20, emptyRedPct: null, defaultPayTermsDays: 45 });
      expect(r.resolved.emptyRedPct).toBe(35);
    }
  });

  test("rejects text, fractions where whole numbers are needed, and values out of range", () => {
    const r = validateThresholds({ emptyAmberPct: "lots", defaultPayTermsDays: "30.5", sentNoAnswerHours: "500" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.emptyAmberPct).toMatch(/number/);
      expect(r.errors.defaultPayTermsDays).toMatch(/Whole/);
      expect(r.errors.sentNoAnswerHours).toMatch(/Between 1 and 72/);
    }
  });

  test("the red line has to be above the amber line, including against the defaults", () => {
    const same = validateThresholds({ emptyAmberPct: "30", emptyRedPct: "30" });
    expect(same.ok).toBe(false);
    const high = validateThresholds({ emptyAmberPct: "40" }); // red falls back to 35
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.errors.emptyRedPct).toMatch(/above the amber/);
  });

  test("empty-mile zones switch at the lines, not before", () => {
    const t = { emptyAmberPct: 25, emptyRedPct: 35 };
    expect([0.1, 0.249, 0.25, 0.349, 0.35, 0.6].map((s) => emptyZone(s, t))).toEqual(["ok", "ok", "amber", "amber", "red", "red"]);
    expect(emptyZone(null, t)).toBeNull();
  });
});

describe("csv", () => {
  test("quotes cells that hold commas, quotes or line breaks", () => {
    expect(csvCell("Dallas, TX")).toBe('"Dallas, TX"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("plain")).toBe("plain");
  });

  test("text that a spreadsheet would run as a formula is defused, numbers are not", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1 555 0100")).toBe("'+1 555 0100");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-5 days")).toBe("'-5 days");
    expect(csvCell(-12.5)).toBe("-12.5");
  });

  test("blanks, booleans, dates and non-finite numbers", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(true)).toBe("true");
    expect(csvCell(new Date("2026-10-28T12:00:00Z"))).toBe("2026-10-28T12:00:00.000Z");
    expect(csvCell(Number.NaN)).toBe("");
  });

  test("a file has a byte order mark, a header and CRLF line ends", () => {
    const out = toCsv(["Load", "Pay"], [["DM-1", 650], ["DM-2", 1200.5]]);
    expect(out).toBe("﻿Load,Pay\r\nDM-1,650\r\nDM-2,1200.5\r\n");
  });
});

describe("chart helpers", () => {
  test("percent change: up is green unless lower is better, small moves are flat", () => {
    expect(deltaOf(1120, 1000, { kind: "pct" })).toEqual({ tone: "good", glyph: "▲", text: "+12.0%" });
    expect(deltaOf(900, 1000, { kind: "pct" })).toEqual({ tone: "bad", glyph: "▼", text: "−10.0%" });
    expect(deltaOf(18, 20, { kind: "pct", lowerIsBetter: true })).toMatchObject({ tone: "good", glyph: "▼" });
    expect(deltaOf(1002, 1000, { kind: "pct" })).toEqual({ tone: "flat", glyph: "–", text: "flat" });
  });

  test("shares move in percentage points, and a fall in empty miles is good", () => {
    expect(deltaOf(0.27, 0.3, { kind: "pts", lowerIsBetter: true })).toEqual({ tone: "good", glyph: "▼", text: "−3.0 pts" });
    expect(deltaOf(0.31, 0.3, { kind: "pts", lowerIsBetter: true })).toMatchObject({ tone: "bad", glyph: "▲" });
    expect(deltaOf(0.3, 0.3, { kind: "pts" })?.text).toBe("no change");
  });

  test("nothing to compare against gives no chip", () => {
    expect(deltaOf(5, null, { kind: "pct" })).toBeNull();
    expect(deltaOf(null, 5, { kind: "pct" })).toBeNull();
    expect(deltaOf(5, 0, { kind: "pct" })).toBeNull();
    expect(changeFraction(150, 100)).toBe(0.5);
    expect(changeFraction(5, 0)).toBeNull();
  });

  test("variance bins: each value in exactly one bin, edges go up, no market rate is counted apart", () => {
    const r = binVariances([-0.35, -0.2, -0.07, 0, 0.049, 0.05, 0.3, null, undefined]);
    expect(r.total).toBe(9);
    expect(r.unverified).toBe(2);
    expect(r.bins.map((b) => b.count)).toEqual([1, 1, 1, 0, 2, 1, 0, 1]);
    expect(r.bins.reduce((s, b) => s + b.count, 0) + r.unverified).toBe(r.total);
    expect(VARIANCE_BINS).toHaveLength(8);
  });

  test("sparkline: min at the bottom, max at the top, gaps break the line, flat sits in the middle", () => {
    const s = sparkPath([1, 3, 2], 100, 40, 0);
    expect(s.d).toBe("M0.0 40.0 L50.0 0.0 L100.0 20.0");
    expect(s.min).toBe(1);
    expect(s.max).toBe(3);
    expect(s.last).toEqual({ x: 100, y: 20 });
    expect(sparkPath([1, null, 3], 100, 40, 0).d).toBe("M0.0 40.0 M100.0 0.0");
    expect(sparkPath([5, 5, 5], 100, 40, 0).d).toBe("M0.0 20.0 L50.0 20.0 L100.0 20.0");
    expect(sparkPath([null, null], 100, 40)).toEqual({ d: "", last: null, min: null, max: null });
    expect(sparkPath([7], 100, 40, 0).d).toBe("M50.0 20.0");
  });
});

describe("growth, address params and the Loads filter", () => {
  const wk = (gross: number, loads: number, revenueMiles: number, drivenMiles: number, emptyMiles: number) => ({ gross, loads, revenueMiles, drivenMiles, emptyMiles });

  test("last four weeks against the four before, ratios taken over summed miles", () => {
    // before: 4 weeks of $1,000 over 500 miles (2.00/mi), 100 empty of 600 driven; now: 4 weeks of $1,500 over 600 miles (2.50/mi), 60 empty of 700
    const weeks = [...Array.from({ length: 4 }, () => wk(1000, 2, 500, 600, 100)), ...Array.from({ length: 4 }, () => wk(1500, 3, 600, 700, 60))];
    const { rows, scale } = growthOf(weeks, 4);
    const by = Object.fromEntries(rows.map((r) => [r.key, r.change]));
    expect(by.revenue).toBeCloseTo(0.5, 6);
    expect(by.loads).toBeCloseTo(0.5, 6);
    expect(by.rpm).toBeCloseTo(0.25, 6);
    expect(by.empty).toBeCloseTo((60 / 700 - 100 / 600) / (100 / 600), 6);
    expect(scale).toBe(0.5); // the biggest move is 50%, so the shared scale is the next round number up
    expect(rows.find((r) => r.key === "empty")!.lowerIsBetter).toBe(true);
  });

  test("a week with nothing in it is not averaged in as a zero rate", () => {
    const c = combineWeeks([wk(1000, 2, 500, 600, 100), wk(0, 0, 0, 0, 0)]);
    expect(c.rpm).toBe(2);
    expect(c.emptyShare).toBeCloseTo(100 / 600, 6);
    expect(combineWeeks([wk(0, 0, 0, 0, 0)])).toMatchObject({ rpm: null, emptyShare: null });
  });

  test("growth is unknown with fewer than two periods of data", () => {
    const { rows } = growthOf([wk(1000, 2, 500, 600, 100)], 4);
    expect(rows.every((r) => r.change == null || Number.isFinite(r.change))).toBe(true);
    expect(growthOf([], 4).rows.every((r) => r.change == null)).toBe(true);
  });

  test("the KPI address: defaults are left out, filters round-trip, bad input falls back", () => {
    const p = parseKpiParams({ period: "month", compare: "off", broker: "Northline Brokerage", driver: " ", dh: "miles" });
    expect(p).toEqual({ period: "month", compare: false, filters: { broker: "Northline Brokerage" }, dh: "miles" });
    expect(kpiQuery(p)).toBe("period=month&compare=off&broker=Northline+Brokerage&dh=miles");
    expect(kpiQuery(parseKpiParams({}))).toBe("");
    expect(parseKpiParams({ period: "decade", dh: "x" })).toEqual({ period: "4w", compare: true, filters: {}, dh: "pct" });
    expect(kpiHref("/kpi", p, { period: "4w", filters: { broker: undefined } })).toBe("/kpi?compare=off&dh=miles"); // back to a default drops it
    expect(hasFilters(p.filters)).toBe(true);
    expect(hasFilters({})).toBe(false);
    expect(parseKpiParams({ lane: ["Dallas, TX → Atlanta, GA", "x"] }).filters.lane).toBe("Dallas, TX → Atlanta, GA");
  });

  test("the Loads filter: text, status and the below-cost flag combine, and the export uses the same rows", () => {
    const r = (loadNumber: string, status: string, verdict: string | null, over: Record<string, string | null> = {}) => ({
      status, verdict, loadNumber, brokerName: "Northline", origin: "Dallas, TX", destination: "Atlanta, GA", vehicleName: "Unit 101", driverName: null as string | null, ...over
    });
    const rows = [r("A", "draft", "reject"), r("B", "draft", "accept"), r("C", "completed", "reject"), r("D", "in_progress", "reject", { driverName: "Alex Rivera", destination: "Memphis, TN" })];
    expect(filterBoard(rows, {}).map((x) => x.loadNumber)).toEqual(["A", "B", "C", "D"]);
    expect(filterBoard(rows, { status: "draft" }).map((x) => x.loadNumber)).toEqual(["A", "B"]);
    expect(filterBoard(rows, { flag: "below" }).map((x) => x.loadNumber)).toEqual(["A", "D"]); // a delivered load is never "below cost"
    expect(filterBoard(rows, { status: "draft", flag: "below" }).map((x) => x.loadNumber)).toEqual(["A"]);
    expect(filterBoard(rows, { q: "alex" }).map((x) => x.loadNumber)).toEqual(["D"]);
    expect(filterBoard(rows, { q: "memphis", status: "in_progress" }).map((x) => x.loadNumber)).toEqual(["D"]);
    expect(filterBoard(rows, { status: "nonsense" })).toHaveLength(4);
    expect(searchBoard(rows, "  ")).toHaveLength(4);
    expect(isBelowCost(rows[2]!)).toBe(false);
  });
});
