import { describe, expect, test } from "vitest";
import { asLimit, nearestTrucks, NEAREST_DEFAULT, type NearestTruck } from "@/lib/quote-nearest";
import { trailerFit } from "@/lib/trailer-fit";

const T = (id: string, located = true): NearestTruck => ({ id, name: `Truck ${id}`, located });

describe("which trucks a quote is priced for", () => {
  test("the nearest by measured empty miles come first, whatever their margin or name", () => {
    const trucks = [T("9"), T("2"), T("5"), T("1")];
    const p = nearestTrucks(trucks, { "9": 12, "2": 340, "5": 60, "1": 75 }, 25);
    expect(p).toMatchObject({ ranked: "distance", measured: 4, available: 4 });
    expect(p.ids).toEqual(["9", "5", "1", "2"]);
  });

  test("it prices the nearest N only, and says how many more could be shown", () => {
    const trucks = Array.from({ length: 40 }, (_, i) => T(String(i + 1)));
    const dh = Object.fromEntries(trucks.map((t, i) => [t.id, (40 - i) * 10]));
    const p = nearestTrucks(trucks, dh, 25);
    expect(p.ids).toHaveLength(25);
    expect(p.ids[0]).toBe("40"); // 10 miles
    expect(p.available).toBe(40);
    expect(nearestTrucks(trucks, dh, 50).ids).toHaveLength(40);
  });

  test("a truck with a base that was not measured is far: it is never priced as if it were as near as the typed figure", () => {
    const p = nearestTrucks([T("a"), T("b"), T("far")], { a: 20, b: 35 }, 25);
    expect(p.ids).toEqual(["a", "b"]);
    expect(p.available).toBe(2);
  });

  test("trucks with no base on file fill the page after the measured ones, by name", () => {
    const p = nearestTrucks([T("a"), T("n2", false), T("n1", false)], { a: 20 }, 25);
    expect(p.ids).toEqual(["a", "n1", "n2"]);
    expect(p.available).toBe(3);
    expect(nearestTrucks([T("a"), T("n2", false), T("n1", false)], { a: 20 }, 2).ids).toEqual(["a", "n1"]);
  });

  test("with nothing measured the first trucks by name are priced, and it is not a distance ranking", () => {
    const p = nearestTrucks([T("10"), T("2"), T("1")], {}, 2);
    expect(p).toMatchObject({ ranked: "name", measured: 0, available: 3 });
    expect(p.ids).toEqual(["1", "2"]); // numeric-aware: 1, 2, 10
  });

  test("a typed figure counts as measured, and zero miles is the nearest", () => {
    const p = nearestTrucks([T("a"), T("b")], { b: 0 }, 25);
    expect(p.ids[0]).toBe("b");
  });

  test("the number asked for is a whole number from 25 to 100, 25 when it is not a number", () => {
    expect(asLimit(undefined)).toBe(NEAREST_DEFAULT);
    expect(asLimit("abc")).toBe(25);
    expect(asLimit(3)).toBe(25);
    expect(asLimit(50)).toBe(50);
    expect(asLimit("75")).toBe(75);
    expect(asLimit(5000)).toBe(100);
    expect(asLimit(60.9)).toBe(60);
    expect(asLimit(NaN)).toBe(25);
  });
});

describe("a longer trailer takes a shorter load", () => {
  const trailer = (lengthFt: number | null) => ({ number: "T-1", type: "dry_van", maxPayloadLbs: null, lengthFt, currentVehicleId: null, status: "available", registrationExpiry: null, inspectionExpiry: null });
  const load = (lengthFt: number | null) => ({ trailerType: "dry_van", weightLbs: null, lengthFt, vehicleId: null });
  const now = new Date("2026-11-05T12:00:00Z");

  test("53 ft takes a 48 ft load; 48 ft does not take a 53 ft load; equal lengths fit; an unknown length is no blocker", () => {
    expect(trailerFit(load(48), trailer(53), now, 30).blocker).toBeNull();
    expect(trailerFit(load(53), trailer(48), now, 30).blocker).toMatch(/53 ft long; T-1 is 48 ft/);
    expect(trailerFit(load(48), trailer(48), now, 30).blocker).toBeNull();
    expect(trailerFit(load(48), trailer(null), now, 30).blocker).toBeNull();
    expect(trailerFit(load(null), trailer(53), now, 30).blocker).toBeNull();
  });
});
