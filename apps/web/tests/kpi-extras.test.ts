import { describe, expect, it } from "vitest";
import { changeOf, dieselAt, laneScore, leadDaysOf, mixLabel, mixOf, tenderStats } from "@/lib/kpi-extras";

const D = (s: string) => new Date(`${s}T12:00:00Z`);

describe("lead time: how long ahead a load was booked", () => {
  it("is days from booking to pickup, to a fraction, and nothing when the pickup is missing or before the booking", () => {
    expect(leadDaysOf(D("2026-11-01"), D("2026-11-04"))).toBe(3);
    expect(leadDaysOf(D("2026-11-01"), new Date("2026-11-01T18:00:00Z"))).toBeCloseTo(0.25, 5);
    expect(leadDaysOf(D("2026-11-05"), D("2026-11-01"))).toBeNull(); // keyed in after the fact
    expect(leadDaysOf(D("2026-11-01"), null)).toBeNull();
  });
});

describe("load mix", () => {
  it("gives each group's share of loads and of revenue, biggest revenue first, with the unrecorded in its own line", () => {
    const rows = mixOf(
      [
        { key: "dry_van", gross: 1000 },
        { key: "dry_van", gross: 2000 },
        { key: "reefer", gross: 4000 },
        { key: null, gross: 1000 },
        { key: "  ", gross: 0 }
      ],
      mixLabel
    );
    expect(rows.map((r) => r.label)).toEqual(["Reefer", "Dry van", "Not recorded"]);
    expect(rows[0]).toMatchObject({ loads: 1, loadShare: 0.2, gross: 4000 });
    expect(rows[0]!.grossShare).toBeCloseTo(4000 / 8000, 10);
    expect(rows[1]).toMatchObject({ loads: 2, gross: 3000 });
    expect(rows[2]).toMatchObject({ key: "none", loads: 2 });
    expect(rows.reduce((s, r) => s + r.loadShare, 0)).toBeCloseTo(1, 10);
    expect(mixOf([], mixLabel)).toEqual([]);
    expect(mixLabel("step_deck")).toBe("Step deck");
    expect(mixLabel("some_new_kind")).toBe("Some new kind");
  });
});

describe("tender acceptance: offers received against loads booked", () => {
  const w = { start: D("2026-11-01").getTime(), end: D("2026-11-08").getTime() };
  const at = (s: string) => D(s).getTime();
  it("counts the offers in the window, and the share booked of those received", () => {
    const rows = [
      { at: at("2026-11-02"), kind: "booked" as const },
      { at: at("2026-11-03"), kind: "booked" as const },
      { at: at("2026-11-03"), kind: "passed" as const },
      { at: at("2026-11-04"), kind: "open" as const },
      { at: at("2026-10-20"), kind: "booked" as const } // outside
    ];
    expect(tenderStats(rows, w)).toEqual({ received: 4, booked: 2, passed: 1, open: 1, acceptance: 0.5 });
  });
  it("is null, not 0%, when nothing came in", () => {
    expect(tenderStats([], w)).toEqual({ received: 0, booked: 0, passed: 0, open: 0, acceptance: null });
  });
});

describe("the lane scorecard against a target", () => {
  it("is BELOW under the target, OK at it or over, and no target with none set or no loads", () => {
    expect(laneScore(1363, 1700)).toBe("below");
    expect(laneScore(1700, 1700)).toBe("ok");
    expect(laneScore(2000, 1700)).toBe("ok");
    expect(laneScore(1363, null)).toBe("no_target");
    expect(laneScore(1363, 0)).toBe("no_target");
    expect(laneScore(null, 1700)).toBe("no_target");
  });
});

describe("the diesel price in force, and change", () => {
  const pts = [
    { weekOf: "2026-10-19", price: 3.81 },
    { weekOf: "2026-10-26", price: 3.9 },
    { weekOf: "2026-11-02", price: 3.95 }
  ];
  it("is the newest week on or before the moment, and null before the first", () => {
    expect(dieselAt(pts, D("2026-10-28").getTime())).toBe(3.9);
    expect(dieselAt(pts, D("2026-11-02").getTime())).toBe(3.95);
    expect(dieselAt(pts, D("2026-11-20").getTime())).toBe(3.95);
    expect(dieselAt(pts, D("2026-10-01").getTime())).toBeNull();
    expect(dieselAt([], D("2026-10-01").getTime())).toBeNull();
  });
  it("change is a fraction of what it was, and null with nothing to compare", () => {
    expect(changeOf(110, 100)).toBeCloseTo(0.1, 10);
    expect(changeOf(90, 100)).toBeCloseTo(-0.1, 10);
    expect(changeOf(5, 0)).toBeNull();
    expect(changeOf(null, 4)).toBeNull();
    expect(changeOf(4, null)).toBeNull();
  });
});
