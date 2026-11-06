import { describe, expect, test } from "vitest";
import { AT_MILES, STALE_MINUTES, closestStop, coordsText, isStanding, unitTip, whereIs, type Fix, type KnownStop, type Town, type UnitWhere } from "@/lib/whereabouts";

const NOW = Date.UTC(2026, 10, 5, 18, 0, 0);
const DOCK: KnownStop = { name: "Acme Foods dock", lat: 35.1495, lng: -90.049 };
// 0.001 degree of latitude is about 111 metres.
const standingAt = (dLat: number): Fix => ({ lat: DOCK.lat + dLat, lng: DOCK.lng, speedMph: 0, engine: "off", headingDeg: null, locatedAt: new Date(NOW - 5 * 60_000) });
const town = (label: string, miles: number): Town => () => ({ label, miles });
const noTown: Town = () => null;

describe("where a unit is", () => {
  test("standing inside 300 m of a stop on file is AT that facility, with its town", () => {
    const w = whereIs(standingAt(0.002), [DOCK], town("Memphis, TN", 2), NOW);
    expect(w.tier).toBe("at");
    expect(w.label).toBe("At Acme Foods dock, Memphis, TN");
    expect(w.facility).toBe("Acme Foods dock");
  });

  test("the reach is 300 metres: just inside is at, just outside is not", () => {
    expect(AT_MILES).toBeCloseTo(0.186, 3);
    expect(whereIs(standingAt(0.0026), [DOCK], noTown, NOW).tier).toBe("at"); // about 290 m
    const out = whereIs(standingAt(0.0034), [DOCK], noTown, NOW); // about 380 m
    expect(out.tier).not.toBe("at");
    expect(out.nearestStop?.name).toBe("Acme Foods dock");
  });

  test("a truck passing a dock at highway speed is never AT it", () => {
    const passing: Fix = { ...standingAt(0.001), speedMph: 62, engine: "moving", headingDeg: 90 };
    const w = whereIs(passing, [DOCK], town("Memphis, TN", 2), NOW);
    expect(w.tier).toBe("near_stop");
    expect(w.label).toBe("Passing Acme Foods dock, Memphis, TN");
    expect(w.standing).toBe(false);
  });

  test("a dropped trailer is standing whatever its (missing) speed says", () => {
    const trailer: Fix = { lat: DOCK.lat, lng: DOCK.lng, speedMph: null, engine: null, headingDeg: null, locatedAt: null, standing: true };
    expect(whereIs(trailer, [DOCK], noTown, NOW).tier).toBe("at");
  });

  test("with no stop, the town speaks in the phone's tiers: near, within 25, then distance", () => {
    const fix = standingAt(0.5);
    expect(whereIs(fix, [], town("Dallas, TX", 3), NOW).label).toBe("Near Dallas, TX");
    expect(whereIs(fix, [], town("Dallas, TX", 12), NOW).label).toBe("Within 25 mi of Dallas, TX");
    expect(whereIs(fix, [], town("Dallas, TX", 41), NOW).label).toBe("41 mi from Dallas, TX");
    expect(whereIs(fix, [], town("Dallas, TX", 41), NOW).tier).toBe("town");
  });

  test("a facility far from any listed town is not given that town's name", () => {
    const w = whereIs(standingAt(0.001), [DOCK], town("Little Rock, AR", 40), NOW);
    expect(w.label).toBe("At Acme Foods dock");
    expect(w.town).toBe("Little Rock, AR");
  });

  test("a moving unit says its highway; a standing one never does", () => {
    const moving: Fix = { lat: 35.05, lng: -89.5, speedMph: 65, engine: "moving", headingDeg: 90, locatedAt: new Date(NOW) };
    const m = whereIs(moving, [], town("Memphis, TN", 20), NOW);
    expect(m.road).toBeTruthy();
    expect(m.label.startsWith("On ")).toBe(true);
    expect(whereIs({ ...moving, speedMph: 0, engine: "off" }, [], town("Memphis, TN", 20), NOW).road).toBeNull();
  });

  test("with no stop and no town it still answers with the point, never throws", () => {
    const w = whereIs(standingAt(0.5), [], noTown, NOW);
    expect(w.tier).toBe("point");
    expect(w.label).toBe("Position only");
    expect(w.coords).toBe(coordsText(DOCK.lat + 0.5, DOCK.lng));
    expect(w.town).toBeNull();
    expect(whereIs(standingAt(0.5), [], null, NOW).tier).toBe("point");
  });

  test("blank-named stops are never a place; the nearer of two is chosen", () => {
    const blank: KnownStop = { name: "  ", lat: DOCK.lat, lng: DOCK.lng };
    const far: KnownStop = { name: "Beta Cold Storage", lat: DOCK.lat + 0.0015, lng: DOCK.lng };
    expect(closestStop(DOCK, [blank], 5)).toBeNull();
    expect(closestStop(DOCK, [far, DOCK], 5)?.stop.name).toBe("Acme Foods dock");
    expect(whereIs(standingAt(0), [blank, far], noTown, NOW).facility).toBe("Beta Cold Storage");
  });

  test("a stop further than 5 miles is not even mentioned as nearby", () => {
    const w = whereIs(standingAt(0.2), [DOCK], noTown, NOW); // about 14 miles
    expect(w.nearestStop).toBeNull();
  });

  test("the age of the fix is said in words and an old one is flagged", () => {
    const fresh = whereIs(standingAt(0.5), [], noTown, NOW);
    expect(fresh.ageText).toBe("5m ago");
    expect(fresh.stale).toBe(false);
    const old = whereIs({ ...standingAt(0.5), locatedAt: new Date(NOW - (STALE_MINUTES + 1) * 60_000) }, [], noTown, NOW);
    expect(old.stale).toBe(true);
    expect(old.ageText).toBe("1h 31m ago");
    const none = whereIs({ ...standingAt(0.5), locatedAt: null }, [], noTown, NOW);
    expect(none.ageText).toBeNull();
    expect(none.stale).toBe(false);
  });

  test("standing: the caller's word first, then speed, then engine, and no signal counts as standing", () => {
    expect(isStanding({ speedMph: 70, engine: "moving", standing: true })).toBe(true);
    expect(isStanding({ speedMph: 2, engine: "moving" })).toBe(true);
    expect(isStanding({ speedMph: 40, engine: "off" })).toBe(false);
    expect(isStanding({ speedMph: null, engine: "moving" })).toBe(false);
    expect(isStanding({ speedMph: null, engine: "idle" })).toBe(true);
    expect(isStanding({ speedMph: null, engine: null })).toBe(true);
  });
});

describe("the hover tooltip", () => {
  const base: Omit<UnitWhere, "where"> = { kind: "truck", id: "t1", name: "Truck 12", sub: "Freightliner Cascadia", lat: 32.7, lng: -96.8, icon: "t-parked", headingDeg: 0, state: "Parked", speed: null, idle: null, dwell: null, driver: "Ana Ruiz", load: { id: "l1", number: "L-100", route: "Dallas, TX → Atlanta, GA" }, typedPlace: null, hitched: { kind: "trailer", id: "tr1", name: "TR-7" } };

  test("says where first, then the facts a dispatcher looking for equipment asks for", () => {
    const where = whereIs(standingAt(0.001), [DOCK], town("Dallas, TX", 2), NOW);
    const tip = unitTip({ ...base, where });
    expect(tip.title).toBe("Truck 12");
    expect(tip.rows!.map(([k]) => k)).toEqual(["Where", "Position", "Status", "Driver", "Load", "Pulling", "Last fix"]);
    expect(tip.rows![0]).toEqual(["Where", "At Acme Foods dock, Dallas, TX"]);
    expect(tip.rows!.find(([k]) => k === "Load")![1]).toBe("L-100 · Dallas, TX → Atlanta, GA");
    expect(tip.note).toBeUndefined();
  });

  test("a unit with no position says so and never invents a place; an old fix is flagged", () => {
    const none = unitTip({ ...base, where: null, lat: null, lng: null, hitched: null });
    expect(none.rows).toBeUndefined();
    expect(none.note).toMatch(/No position on file/);
    const old = whereIs({ ...standingAt(0.001), locatedAt: new Date(NOW - 5 * 3_600_000) }, [], noTown, NOW);
    expect(unitTip({ ...base, where: old }).note).toMatch(/may have moved/);
  });

  test("a trailer's own lines (dwell, the yard a person typed) appear only when they exist", () => {
    const where = whereIs(standingAt(0.001), [], noTown, NOW);
    const t = unitTip({ ...base, kind: "trailer", name: "TR-7", sub: "53V", state: "Dropped", dwell: "SITTING 1.3 DAYS", typedPlace: "Yard B", driver: null, load: null, hitched: null, where });
    expect(t.rows!.map(([k]) => k)).toEqual(["Where", "Position", "Status", "Dwell", "Noted as", "Last fix"]);
  });
});
