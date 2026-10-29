import { describe, expect, it } from "vitest";
import type { PayKind } from "../src/lib/pay";
import { addDays, basisText, computeStatement, linePay, parseHours, periodBounds, periodCovering, periodPresets, periodText, statementOf, validatePeriod, type SettlementLoad } from "../src/lib/settlement";
import { payEstimate } from "../src/server/tl/projector";

const load = (over: Partial<SettlementLoad> = {}): SettlementLoad => ({
  loadId: "L1",
  loadNumber: "DM-1",
  origin: "Dallas, TX",
  destination: "Memphis, TN",
  deliveredAt: "2026-10-14T20:00:00.000Z",
  loadedMiles: 245,
  payKind: "cpm",
  payRate: 0.5,
  rateConTotal: 1150,
  assignedHours: null,
  brokerStatus: "paid",
  ...over
});

describe("what a load pays the driver", () => {
  it("follows the assignment's pay: a mile rate on the loaded miles, a set amount, hourly, or a percent of the rate confirmation", () => {
    expect(linePay("cpm", 0.5, 245, null, 1150)).toBe(122.5);
    expect(linePay("flat", 450, 245, null, 1150)).toBe(450);
    expect(linePay("percent", 25, 245, null, 1150)).toBe(287.5);
    expect(linePay("hourly", 24, 245, 8.5, 1150)).toBe(204);
    expect(linePay("hourly", 24, 245, null, 1150)).toBeNull(); // no hours yet
  });

  it("rounds exactly as the pay estimate on an assignment does, for every kind (0.051 a mile over 185 miles is $9.44, not $9.43)", () => {
    expect(linePay("cpm", 0.051, 185, null, 0)).toBe(9.44);
    expect(payEstimate({ kind: "cpm", rate: 0.051 }, 185, null)).toBe(9.44);
    let seed = 11;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const kinds: PayKind[] = ["cpm", "flat", "hourly", "percent"];
    for (let i = 0; i < 3000; i++) {
      const kind = kinds[i % 4]!;
      const rate = kind === "percent" ? Math.round(next() * 9999) / 100 : kind === "flat" ? Math.round(next() * 200000) / 100 : Math.round(next() * 50000) / 10000;
      const miles = Math.round(next() * 30000) / 10;
      const hours = Math.round(next() * 4000) / 100;
      const total = Math.round(next() * 500000) / 100;
      expect(linePay(kind, rate, miles, hours, total), `${kind} ${rate} ${miles} ${hours} ${total}`).toBe(payEstimate({ kind, rate }, miles, hours, total));
    }
  });

  it("says how each was worked out", () => {
    expect(basisText("cpm", 0.5, 245, null, 1150)).toBe("$0.50 a mile × 245 mi");
    expect(basisText("flat", 450, 245, null, 1150)).toBe("Set amount for the load");
    expect(basisText("percent", 25, 245, null, 1150)).toBe("25% of $1,150.00");
    expect(basisText("hourly", 24, 245, 8.5, 1150)).toBe("$24.00 an hour × 8.5 hr");
    expect(basisText("hourly", 24, 245, null, 1150)).toMatch(/enter the hours/);
  });
});

describe("hours", () => {
  it("blank falls back to the assignment's; a typed number wins; nonsense is refused", () => {
    expect(parseHours("")).toEqual({ value: null });
    expect(parseHours("  ")).toEqual({ value: null });
    expect(parseHours("9.5")).toEqual({ value: 9.5 });
    for (const bad of ["0", "-2", "abc", "401", "1.234"]) expect(parseHours(bad).error, bad).toBeDefined();
  });
});

describe("a statement", () => {
  const mixed = [
    load({ loadId: "A", loadNumber: "A" }),
    load({ loadId: "B", loadNumber: "B", payKind: "flat", payRate: 450 }),
    load({ loadId: "C", loadNumber: "C", payKind: "percent", payRate: 25 }),
    load({ loadId: "D", loadNumber: "D", payKind: "hourly", payRate: 24, assignedHours: 8.5 })
  ];

  it("adds the load lines and the adjustments, to the cent", () => {
    const st = computeStatement({ loads: mixed, hours: { D: "9" }, adjustments: [{ label: "Advance", amount: "-100" }, { label: "Reimbursed tolls", amount: "$42.35" }] });
    expect(st.lines.map((l) => l.amount)).toEqual([122.5, 450, 287.5, 216]);
    expect(st.loadsTotal).toBe(1076);
    expect(st.adjustments).toEqual([{ label: "Advance", amount: -100 }, { label: "Reimbursed tolls", amount: 42.35 }]);
    expect(st.adjustmentsTotal).toBe(-57.65);
    expect(st.total).toBe(1018.35);
    expect(st.blockers).toEqual([]);
  });

  it("starts an hourly load from the assignment's hours and lets typed hours replace them", () => {
    expect(computeStatement({ loads: mixed, hours: {}, adjustments: [] }).lines[3]!.amount).toBe(204);
    expect(computeStatement({ loads: mixed, hours: { D: "10" }, adjustments: [] }).lines[3]!.amount).toBe(240);
  });

  it("will not finalize an hourly load that has no hours at all", () => {
    const st = computeStatement({ loads: [load({ loadId: "H", loadNumber: "H-9", payKind: "hourly", payRate: 20 })], hours: {}, adjustments: [] });
    expect(st.lines[0]!.amount).toBeNull();
    expect(st.blockers).toEqual(["Enter the hours for H-9."]);
    expect(st.total).toBe(0);
  });

  it("names a bad number next to its field and ignores a blank row", () => {
    const st = computeStatement({
      loads: mixed,
      hours: { D: "abc" },
      adjustments: [{ label: "", amount: "" }, { label: "Fuel card", amount: "12.345" }, { label: "", amount: "50" }, { label: "Bonus", amount: "" }, { label: "Zero", amount: "0" }]
    });
    expect(Object.keys(st.errors).sort()).toEqual(["adj1.amount", "adj2.label", "adj3.amount", "adj4.amount", "hours.D"]);
    expect(st.blockers[0]).toBe("Fix what is marked.");
    expect(st.adjustments).toEqual([]);
  });

  it("refuses an empty statement, and cautions about a negative one and about loads the broker has not paid", () => {
    expect(computeStatement({ loads: [], hours: {}, adjustments: [] }).blockers).toEqual(["There is nothing to pay on this statement."]);
    const neg = computeStatement({ loads: [load({ brokerStatus: "invoiced" })], hours: {}, adjustments: [{ label: "Advance", amount: "-500" }] });
    expect(neg.total).toBe(-377.5);
    expect(neg.cautions.join(" ")).toMatch(/negative amount/);
    expect(neg.cautions.join(" ")).toMatch(/1 of these loads is not paid by the broker yet/);
    expect(neg.blockers).toEqual([]); // a caution, not a stop
    const clean = computeStatement({ loads: [load()], hours: {}, adjustments: [] });
    expect(clean.cautions).toEqual([]);
  });

  it("keeps more than the allowed adjustment lines out", () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ label: `L${i}`, amount: "1" }));
    expect(computeStatement({ loads: [], hours: {}, adjustments: rows }).errors.adjustments).toBeDefined();
  });

  it("a frozen statement adds up the same way", () => {
    const st = computeStatement({ loads: mixed, hours: {}, adjustments: [{ label: "Advance", amount: "-100" }] });
    const frozen = statementOf(st.lines, st.adjustments);
    expect(frozen.total).toBe(st.total);
    expect(frozen.blockers).toEqual([]);
  });
});

describe("the period", () => {
  it("is two real dates, in order, and not longer than a quarter", () => {
    expect(validatePeriod("2026-10-12", "2026-10-18")).toEqual({ ok: true, start: "2026-10-12", end: "2026-10-18" });
    expect(validatePeriod("2026-10-12", "2026-10-12").ok).toBe(true);
    const bad = validatePeriod("2026-02-30", "nope");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["end", "start"]);
    expect(validatePeriod("2026-10-18", "2026-10-12")).toMatchObject({ ok: false, errors: { end: expect.stringMatching(/before/) } });
    expect(validatePeriod("2026-01-01", "2026-04-03")).toMatchObject({ ok: false, errors: { end: expect.stringMatching(/92 days/) } });
    expect(validatePeriod("2026-01-01", "2026-04-02").ok).toBe(true); // 92 days, counting both ends
  });

  it("runs from midnight to midnight on the Dallas clock, including the day the clocks go back", () => {
    const week = periodBounds("2026-10-12", "2026-10-18")!;
    expect(week.from.toISOString()).toBe("2026-10-12T05:00:00.000Z"); // CDT
    expect(week.to.toISOString()).toBe("2026-10-19T05:00:00.000Z");
    const across = periodBounds("2026-10-31", "2026-11-01")!;
    expect(across.from.toISOString()).toBe("2026-10-31T05:00:00.000Z");
    expect(across.to.toISOString()).toBe("2026-11-02T06:00:00.000Z"); // CST after the change: the period is 49 hours
  });

  it("reads as people write it", () => {
    expect(periodText("2026-10-12", "2026-10-25")).toBe("Oct 12 to Oct 25, 2026");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("offers the usual periods, weeks running Monday to Sunday", () => {
    // Thursday 29 October 2026, 10:00 in Dallas.
    const presets = periodPresets(Date.parse("2026-10-29T15:00:00Z"));
    const by = Object.fromEntries(presets.map((p) => [p.key, [p.start, p.end]]));
    expect(by.week).toEqual(["2026-10-19", "2026-10-25"]);
    expect(by["two-weeks"]).toEqual(["2026-10-12", "2026-10-25"]);
    expect(by["month-so-far"]).toEqual(["2026-10-01", "2026-10-29"]);
    expect(by["last-month"]).toEqual(["2026-09-01", "2026-09-30"]);
    // A Monday morning: last week is the one that just ended yesterday.
    const monday = Object.fromEntries(periodPresets(Date.parse("2026-10-26T14:00:00Z")).map((p) => [p.key, [p.start, p.end]]));
    expect(monday.week).toEqual(["2026-10-19", "2026-10-25"]);
    // A Sunday late evening in Dallas is already Monday in UTC: Dallas's own calendar decides.
    const sunday = Object.fromEntries(periodPresets(Date.parse("2026-10-26T03:30:00Z")).map((p) => [p.key, [p.start, p.end]]));
    expect(sunday.week).toEqual(["2026-10-12", "2026-10-18"]);
  });

  it("covers a driver's unsettled deliveries, trimmed to the longest a statement can be", () => {
    expect(periodCovering([])).toBeNull();
    expect(periodCovering([new Date("2026-10-13T20:00:00Z"), new Date("2026-10-20T20:00:00Z")])).toEqual({ start: "2026-10-13", end: "2026-10-20" });
    const long = periodCovering([new Date("2026-05-01T20:00:00Z"), new Date("2026-10-20T20:00:00Z")])!;
    expect(long.end).toBe("2026-10-20");
    expect(long.start).toBe("2026-07-21");
    expect(validatePeriod(long.start, long.end).ok).toBe(true);
  });
});
