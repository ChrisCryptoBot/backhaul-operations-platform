import { describe, expect, it } from "vitest";
import { stopClock, stopTime } from "@/lib/desk-format";
import { buildPlanner, buildWatchlist, planDays, timeText, type PlannerLoad } from "@/lib/planner";

// 15:00 UTC on a winter day is 9:00 AM in Chicago (CST) and 10:00 AM in New York (EST).
const T = Date.parse("2026-12-02T15:00:00Z");
const CT = "America/Chicago";
const ET = "America/New_York";

describe("a time at a dock is read there, with the carrier's clock beside it when they differ", () => {
  it("stopClock: the carrier's own clock is the bare time (the day column already says which clock)", () => {
    expect(stopClock(T, CT, CT)).toBe("9:00 AM");
    expect(stopClock(T, null, CT)).toBe("9:00 AM");
  });

  it("stopClock: another zone reads the dock first, then the carrier's in brackets", () => {
    expect(stopClock(T, ET, CT)).toBe("10:00 AM ET (9:00 AM CT)");
    expect(stopClock(T, CT, ET)).toBe("9:00 AM CT (10:00 AM ET)");
  });

  it("stopClock: no time is a dash, never a made-up one", () => {
    expect(stopClock(null, ET, CT)).toBe("—");
    expect(stopClock(undefined, ET, CT)).toBe("—");
  });

  it("stopClock and stopTime say the same thing about the same dock", () => {
    expect(stopTime(new Date(T), ET, CT)).toContain("10:00 AM ET (9:00 AM CT)");
  });

  it("a planner cell prints each end on its own dock's clock", () => {
    const base = { start: T, end: T + 30 * 3_600_000, startsHere: true, endsHere: true };
    expect(timeText({ ...base, startZone: ET, endZone: CT })).toBe("10:00 AM ET (9:00 AM CT) to 3:00 PM");
    expect(timeText({ ...base })).toBe("9:00 AM to 3:00 PM");
    expect(timeText({ ...base, startsHere: false, endsHere: true, endZone: ET })).toBe("until 4:00 PM ET (3:00 PM CT)");
    expect(timeText({ ...base, startsHere: false, endsHere: false })).toBe("all day");
  });
});

describe("the planner carries each stop's clock through", () => {
  const stops = (zones: [string, string]) => [
    { sequence: 1, type: "pickup", role: "pickup", facility: "A", city: "Boston", earliest: new Date(T), latest: new Date(T + 3_600_000), arrivedAt: null, zone: zones[0] },
    { sequence: 2, type: "delivery", role: "delivery", facility: "B", city: "Dallas", earliest: new Date(T + 24 * 3_600_000), latest: new Date(T + 26 * 3_600_000), arrivedAt: null, zone: zones[1] }
  ];
  const load: PlannerLoad = { id: "l1", loadNumber: "L1", origin: "Boston, MA", destination: "Dallas, TX", status: "accepted", driverId: "d1", driverName: "Alex", assignmentStatus: "accepted", stops: stops([ET, CT]) };

  it("a block knows the clock at its first and last stop", () => {
    const days = planDays(T, 3, T);
    const { rows } = buildPlanner([load], [{ id: "d1", name: "Alex" }], days, T);
    const item = rows[0]!.cells.flat()[0]!;
    expect(item.startZone).toBe(ET);
    expect(item.endZone).toBe(CT);
  });

  it("a stop with no known clock is left blank, which reads as the carrier's", () => {
    const days = planDays(T, 3, T);
    const { rows } = buildPlanner([{ ...load, stops: load.stops.map(({ zone: _z, ...s }) => s) }], [{ id: "d1", name: "Alex" }], days, T);
    expect(rows[0]!.cells.flat()[0]!.startZone).toBeNull();
  });

  it("a due stop carries the clock at its dock", () => {
    const due = buildWatchlist([load], T - 3_600_000);
    expect(due.length).toBeGreaterThan(0);
    expect(due.every((d) => d.zone === ET || d.zone === CT)).toBe(true);
    expect(due[0]!.zone).toBe(ET);
  });
});
