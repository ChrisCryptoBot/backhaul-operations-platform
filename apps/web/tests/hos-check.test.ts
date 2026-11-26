import { describe, expect, it } from "vitest";
import { hosCheck } from "../src/lib/hos-check";

const now = new Date("2027-03-01T12:00:00Z");
const fresh = new Date("2027-03-01T11:30:00Z");
const clocks = (drive: number | null, shift: number | null, cycle: number | null, at: Date | null = fresh) => ({ hosDriveMinutes: drive, hosShiftMinutes: shift, hosCycleMinutes: cycle, hosSyncedAt: at });

describe("whether a driver has the hours for a trip", () => {
  it("is short when the drive, shift or cycle clock does not cover it, and says by how much", () => {
    expect(hosCheck(clocks(270, 600, 3000), 7, now)).toEqual({ state: "short", note: "4.5 h drive left · trip needs ~7.0 h" });
    expect(hosCheck(clocks(600, 300, 3000), 7, now)).toEqual({ state: "short", note: "5.0 h left in the shift · trip needs ~7.0 h" });
    expect(hosCheck(clocks(660, 840, 600), 14, now)).toEqual({ state: "short", note: "10.0 h left in the cycle · trip needs ~14.0 h" });
  });

  it("asks only the first day's driving of a long trip from the daily clocks: a 20 h trip is planned over two days", () => {
    expect(hosCheck(clocks(660, 840, 3000), 20, now).state).toBe("clear");
  });

  it("says nothing about a driver with no ELD clocks, and warns when the clocks are stale", () => {
    expect(hosCheck(clocks(null, null, null, null), 7, now)).toEqual({ state: "none", note: null });
    expect(hosCheck(clocks(600, 600, 3000, new Date("2027-02-28T20:00:00Z")), 7, now)).toEqual({ state: "stale", note: "Hours last reported 16 h ago" });
  });

  it("is clear with the hours to spare", () => {
    expect(hosCheck(clocks(600, 700, 3000), 7, now)).toEqual({ state: "clear", note: "10.0 h drive left" });
  });
});
