import { describe, expect, it } from "vitest";
import { US_STATES } from "@/lib/basemap/us-states";
import { findPlace } from "@/lib/gazetteer/place-index";
import { STATES } from "@/lib/gazetteer/states";
import { REGIONS, REGION_KEYS, boxAround, firstRegion, mapLng, regionCounts, regionOf, within } from "@/lib/radar-regions";

const inside = (b: [number, number, number, number], lat: number, lng: number) => lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];

describe("the map's three regions", () => {
  it("every state's centre is inside the clamp of the region it belongs to", () => {
    for (const s of STATES) {
      const r = regionOf(s.lat, s.lng);
      expect(inside(REGIONS[r].clamp, s.lat, s.lng), s.abbr).toBe(true);
    }
    expect(regionOf(64.2, -152)).toBe("alaska");
    expect(regionOf(20.8, -156.3)).toBe("hawaii");
    expect(regionOf(32.78, -96.8)).toBe("lower48");
  });

  it("the places the gazetteer knows in Alaska and Hawaii land in their own regions", () => {
    for (const [text, want] of [["Anchorage, AK", "alaska"], ["Fairbanks, AK", "alaska"], ["Juneau, AK", "alaska"], ["Honolulu, HI", "hawaii"], ["Hilo, HI", "hawaii"], ["Seattle, WA", "lower48"], ["Miami, FL", "lower48"]] as const) {
      const f = findPlace(text);
      expect(f, text).not.toBeNull();
      expect(regionOf(f!.lat, f!.lng), text).toBe(want);
      expect(inside(REGIONS[want].clamp, f!.lat, mapLng(f!.lat, f!.lng)), text).toBe(true);
    }
  });

  it("the western Aleutians, east of 180, still belong to Alaska though the flat map ends at -180", () => {
    expect(mapLng(52.9, 172.9)).toBeCloseTo(-187.1, 1); // Attu
    expect(regionOf(52.9, 172.9)).toBe("alaska");
    expect(mapLng(61.2, -149.9)).toBe(-149.9); // Anchorage is untouched
    expect(mapLng(-33.9, 151.2)).toBe(151.2); // nothing south of 50 is moved
  });

  it("a fit box and a clamp box are ordered, and every fit sits inside its own clamp", () => {
    for (const k of REGION_KEYS) {
      const { clamp, fit } = REGIONS[k];
      expect(clamp[0] < clamp[2] && clamp[1] < clamp[3], k).toBe(true);
      expect(fit[0] >= clamp[0] && fit[1] >= clamp[1] && fit[2] <= clamp[2] && fit[3] <= clamp[3], k).toBe(true);
    }
  });

  it("counts units per region, opens on the busiest, and the lower 48 when there is a tie or nothing", () => {
    const pts = [
      { lat: 61.2, lng: -149.9 },
      { lat: 64.8, lng: -147.7 },
      { lat: 21.3, lng: -157.8 },
      { lat: 32.8, lng: -96.8 }
    ];
    expect(regionCounts(pts)).toEqual({ lower48: 1, alaska: 2, hawaii: 1 });
    expect(firstRegion(pts)).toBe("alaska");
    expect(firstRegion([])).toBe("lower48");
    expect(firstRegion([{ lat: 61.2, lng: -149.9 }, { lat: 32.8, lng: -96.8 }])).toBe("lower48");
  });

  it("a box around points is padded, never thinner than the minimum, and held inside a clamp", () => {
    const b = boxAround([{ lat: 21.3, lng: -157.8 }])!;
    expect(b[2] - b[0]).toBeGreaterThanOrEqual(3);
    expect(b[3] - b[1]).toBeGreaterThanOrEqual(3);
    expect(boxAround([])).toBeNull();
    const clamped = within([-200, 10, -100, 80], "alaska");
    expect(clamped).toEqual([-180, 47, -123, 75]);
  });
});

describe("the basemap draws all fifty states", () => {
  it("has Alaska and Hawaii, and nothing past the edge of the world", () => {
    const names = US_STATES.map((s) => s.name);
    expect(names).toContain("Alaska");
    expect(names).toContain("Hawaii");
    expect(US_STATES.length).toBe(51); // fifty states and DC
    const lngs = US_STATES.flatMap((s) => s.rings.flatMap((r) => r.map((p) => p[0])));
    const lats = US_STATES.flatMap((s) => s.rings.flatMap((r) => r.map((p) => p[1])));
    expect(Math.min(...lngs)).toBeGreaterThanOrEqual(-180);
    expect(Math.max(...lngs)).toBeLessThan(-66);
    expect(Math.min(...lats)).toBeGreaterThan(18);
    expect(Math.max(...lats)).toBeLessThan(72.5);
  });
});
