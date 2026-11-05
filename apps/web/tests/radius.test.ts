import { describe, expect, it } from "vitest";
import { boundsAround, radiusRing, clampRadius, countsText, milesText, siteKey, within } from "@/lib/radius";
import { haversineMiles } from "@/lib/geo";

const DALLAS = { lat: 32.78, lng: -96.8 };
const at = (id: string, lat: number, lng: number) => ({ id, lat, lng });

describe("radius search", () => {
  it("keeps what is inside the radius, nearest first, with its distance", () => {
    const units = [at("fortworth", 32.75, -97.33), at("denton", 33.21, -97.13), at("houston", 29.76, -95.37), at("here", 32.78, -96.8), at("tyler", 32.35, -95.3)];
    const got = within(units, DALLAS, 50);
    expect(got.map((g) => g.item.id)).toEqual(["here", "fortworth", "denton"]);
    expect(got[0]!.miles).toBeCloseTo(0, 1);
    expect(got[1]!.miles).toBeGreaterThan(25);
    expect(got[1]!.miles).toBeLessThan(35);
    expect(within(units, DALLAS, 300).map((g) => g.item.id)).toContain("houston");
  });

  it("the box never drops a unit the exact test would keep", () => {
    // A ring of points right on the 100 mile boundary, east, west, north, south and between.
    const r = 100;
    const pts: Array<ReturnType<typeof at>> = [];
    for (let a = 0; a < 360; a += 15) {
      const lat = DALLAS.lat + (r * 0.999 / 69) * Math.cos((a * Math.PI) / 180);
      const lng = DALLAS.lng + ((r * 0.999) / (69 * Math.cos((DALLAS.lat * Math.PI) / 180))) * Math.sin((a * Math.PI) / 180);
      pts.push(at(`p${a}`, lat, lng));
    }
    const exact = pts.filter((p) => haversineMiles(DALLAS, p) <= r).length;
    expect(within(pts, DALLAS, r)).toHaveLength(exact);
    const b = boundsAround(DALLAS, r);
    expect(pts.every((p) => p.lat >= b.minLat && p.lat <= b.maxLat && p.lng >= b.minLng && p.lng <= b.maxLng)).toBe(true);
  });

  it("a unit just past the radius is out, and one exactly on it is in", () => {
    const north = at("n", DALLAS.lat + 50 / 69.09, DALLAS.lng);
    const d = haversineMiles(DALLAS, north);
    expect(within([north], DALLAS, Math.floor(d) - 1)).toHaveLength(0);
    expect(within([north], DALLAS, Math.ceil(d))).toHaveLength(1);
  });

  it("clamps a typed radius to a whole number of miles from 1 to 1,000, and falls back to 50", () => {
    expect(clampRadius("25")).toBe(25);
    expect(clampRadius(33.6)).toBe(34);
    expect(clampRadius("")).toBe(50);
    expect(clampRadius("abc")).toBe(50);
    expect(clampRadius(-5)).toBe(50);
    expect(clampRadius(5000)).toBe(1000);
    expect(clampRadius(0.2)).toBe(1); // a positive fraction is the smallest radius, not nothing
  });

  it("the circle is closed and every point on it is the radius from the centre", () => {
    const ring = radiusRing(DALLAS, 50);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const [lng, lat] of ring.slice(0, -1)) expect(haversineMiles(DALLAS, { lat, lng })).toBeGreaterThan(48.5), expect(haversineMiles(DALLAS, { lat, lng })).toBeLessThan(51.5);
  });

  it("says counts and distances plainly, and groups units at one place", () => {
    expect(countsText(14, 9)).toBe("23 units (14 trucks, 9 trailers)");
    expect(countsText(1, 0)).toBe("1 unit (1 truck, 0 trailers)");
    expect(milesText(0.44)).toBe("0.4 mi");
    expect(milesText(4)).toBe("4 mi");
    expect(milesText(142.6)).toBe("143 mi");
    expect(siteKey({ lat: 32.78012, lng: -96.80049 })).toBe(siteKey({ lat: 32.78049, lng: -96.80001 }));
    expect(siteKey({ lat: 32.78, lng: -96.8 })).not.toBe(siteKey({ lat: 32.79, lng: -96.8 }));
  });
});
