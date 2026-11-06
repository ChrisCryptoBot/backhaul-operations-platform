import { describe, expect, test } from "vitest";
import { STAY_MIN_MINUTES, longEnough, stepStay, type OpenStay, type StayFix } from "@/lib/stays";
import { arrivalEntry, byDay, callEntry, callStatusOf, historyDays, loadEntry, moveEntry, sortHistory, stayEntry } from "@/lib/asset-history";

const T0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const min = (m: number) => T0 + m * 60_000;
const HERE = { lat: 32.7767, lng: -96.797 };
const standing = (m: number, at = HERE): StayFix => ({ ...at, at: min(m), speedMph: 0, engine: "off" });
const moving = (m: number, at = HERE): StayFix => ({ ...at, at: min(m), speedMph: 60, engine: "moving" });
const open = (arrived: number, seen: number): OpenStay => ({ id: "s1", ...HERE, arrivedAt: min(arrived), lastSeenAt: min(seen) });

describe("stays", () => {
  test("a standing fix with no stay open starts one; a moving fix starts nothing", () => {
    expect(stepStay(null, standing(0))).toEqual({ kind: "open", ...HERE, at: min(0) });
    expect(stepStay(null, moving(0))).toEqual({ kind: "none" });
  });

  test("standing in the same place extends the stay, and GPS wander inside a quarter mile is the same place", () => {
    expect(stepStay(open(0, 15), standing(30))).toEqual({ kind: "extend", id: "s1", at: min(30) });
    const wander = { lat: HERE.lat + 0.002, lng: HERE.lng }; // about 140 m
    expect(stepStay(open(0, 15), standing(30, wander)).kind).toBe("extend");
  });

  test("moving off closes it, and a long enough stay is kept", () => {
    expect(STAY_MIN_MINUTES).toBe(20);
    expect(stepStay(open(0, 90), moving(105))).toEqual({ kind: "close", id: "s1", leftAt: min(105), keep: true, next: null });
  });

  test("a red-light stop is not kept: a stay under twenty minutes is dropped when it closes", () => {
    expect(longEnough(min(0), min(19))).toBe(false);
    expect(longEnough(min(0), min(20))).toBe(true);
    expect(stepStay(open(0, 10), moving(25))).toMatchObject({ kind: "close", keep: false });
  });

  test("standing somewhere else closes the old stay and opens the next in one step", () => {
    const far = { lat: 33.2, lng: -96.9 };
    expect(stepStay(open(0, 60), standing(120, far))).toEqual({ kind: "close", id: "s1", leftAt: min(120), keep: true, next: { ...far, at: min(120) } });
  });

  test("a fix older than the stay's last sighting never moves it backwards", () => {
    expect(stepStay(open(0, 60), standing(30))).toEqual({ kind: "none" });
    expect(stepStay(open(0, 60), moving(60))).toEqual({ kind: "none" });
  });
});

describe("the history list", () => {
  const fmt = (ms: number) => `T+${Math.round((ms - T0) / 60_000)}m`;

  test("a stay says where and for how long, and 'so far' while it is still there", () => {
    const done = stayEntry({ id: "a", arrivedAt: min(0), lastSeenAt: min(190), leftAt: min(194) }, "Acme Foods dock, Memphis, TN");
    // Measured to the last fix that put it there (190), not to the fix that showed it gone (194).
    expect(done).toMatchObject({ kind: "stay", title: "Stopped · Acme Foods dock, Memphis, TN", detail: "3h 10m", ongoing: false, until: min(190) });
    const now = stayEntry({ id: "b", arrivedAt: min(0), lastSeenAt: min(45), leftAt: null }, "Near Dallas, TX");
    expect(now).toMatchObject({ detail: "45m so far", ongoing: true, until: min(45) });
  });

  test("a check call keeps what was said, the ETA on the screen's clock, who spoke and who logged it", () => {
    const c = callEntry({ id: "c", at: min(10), place: "I-40 past Amarillo", etaAt: min(300), status: "late", note: "Flat tire, tow on the way", spokeWith: "Ana Ruiz", loggedBy: "Sam", loadNumber: "L-100" }, fmt);
    expect(c.title).toBe("Check call · Running late");
    expect(c.detail).toBe("Said: I-40 past Amarillo · ETA T+300m · Flat tire, tow on the way");
    expect(c.meta).toBe("Spoke with Ana Ruiz · Logged by Sam · Load L-100");
    const bare = callEntry({ id: "d", at: min(10), place: null, etaAt: null, status: null, note: null, spokeWith: null, loggedBy: "Sam", loadNumber: null }, fmt);
    expect(bare).toMatchObject({ title: "Check call", detail: null, meta: "Logged by Sam" });
  });

  test("a drop reads how long the trailer sat; a hook says which tractor", () => {
    expect(moveEntry({ id: "m1", kind: "hooked", at: min(0), tractor: "Unit 101", place: "Dallas Distribution", by: "Sam" }, null)).toMatchObject({ title: "Hooked to Unit 101", detail: "At Dallas Distribution" });
    const drop = moveEntry({ id: "m2", kind: "dropped", at: min(0), tractor: "Unit 101", place: "Charlotte yard", by: "Sam" }, { until: min(60 * 30), ongoing: true });
    expect(drop).toMatchObject({ title: "Dropped by Unit 101", detail: "At Charlotte yard · Sitting 1.3 days", ongoing: true });
    expect(moveEntry({ id: "m3", kind: "dropped", at: min(0), tractor: null, place: null, by: "Sam" }, null).title).toBe("Dropped");
  });

  test("an arrival names the stop, the load and the driver, and links to the load", () => {
    expect(arrivalEntry({ id: "x", at: min(5), role: "delivery", place: "Atlanta Receiving", loadId: "l1", loadNumber: "L-9", driver: "Ana Ruiz" })).toMatchObject({ title: "Arrived · Atlanta Receiving", detail: "Delivery · Load L-9", meta: "Driver Ana Ruiz", href: "/loads/l1" });
    expect(loadEntry({ id: "l2", at: min(5), loadNumber: "L-10", route: "Dallas, TX → Atlanta, GA", status: "accepted", driver: null })).toMatchObject({ title: "Load L-10", detail: "Dallas, TX → Atlanta, GA · accepted", meta: null });
  });

  test("newest first, a call before an arrival before a stay at the same instant, then grouped by day", () => {
    const e = [
      stayEntry({ id: "s", arrivedAt: min(0), lastSeenAt: min(40), leftAt: min(45) }, "Yard"),
      arrivalEntry({ id: "a", at: min(0), role: "pickup", place: "Dock", loadId: "l", loadNumber: "L", driver: null }),
      callEntry({ id: "c", at: min(0), place: null, etaAt: null, status: null, note: null, spokeWith: null, loggedBy: "Sam", loadNumber: null }, fmt),
      callEntry({ id: "n", at: min(24 * 60), place: null, etaAt: null, status: null, note: null, spokeWith: null, loggedBy: "Sam", loadNumber: null }, fmt)
    ];
    expect(sortHistory(e).map((x) => x.key)).toEqual(["call:n", "call:c", "arrive:a", "stay:s"]);
    const days = byDay(e, (ms) => (ms >= min(24 * 60) ? "Nov 6" : "Nov 5"));
    expect(days.map((d) => [d.day, d.entries.length])).toEqual([["Nov 6", 1], ["Nov 5", 3]]);
  });

  test("a call's status and the range are read safely", () => {
    expect(callStatusOf("late")).toBe("late");
    expect(callStatusOf("anything else")).toBeNull();
    expect(historyDays("90")).toBe(90);
    expect(historyDays("5")).toBe(30);
    expect(historyDays(undefined)).toBe(30);
  });
});
