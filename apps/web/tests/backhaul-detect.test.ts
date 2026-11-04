import { describe, expect, it } from "vitest";
import { findBackhauls, type OpenPickupCandidate } from "@/lib/backhaul-detect";

describe("Backhaul detector (M1)", () => {
  const atlanta = { address: "Atlanta, GA", lat: 33.749, lng: -84.388 };

  const openLoads: OpenPickupCandidate[] = [
    {
      loadId: "load-1",
      loadNumber: "DM-5001",
      address: "Marietta, GA", // ~18 miles from Atlanta
      lat: 33.9526,
      lng: -84.5499
    },
    {
      loadId: "load-2",
      loadNumber: "DM-5002",
      address: "Macon, GA", // ~80 miles from Atlanta (outside 50mi radius)
      lat: 32.8407,
      lng: -83.6324
    },
    {
      loadId: "load-3",
      loadNumber: "DM-5003",
      address: "East Point, GA", // ~7 miles from Atlanta
      lat: 33.6795,
      lng: -84.4394
    },
    {
      loadId: "load-4",
      loadNumber: "DM-5004",
      address: "Atlanta, GA", // Unmeasured coordinates, matching by name
      lat: null,
      lng: null
    }
  ];

  it("finds open pickups within 50 miles of the delivery location sorted nearest first", () => {
    const opp = findBackhauls(atlanta, openLoads, 50);
    expect(opp.count).toBe(3); // East Point (7mi), Marietta (18mi), Atlanta (name match)
    expect(opp.matches[0].loadNumber).toBe("DM-5003");
    expect(opp.matches[0].distanceMiles).toBeCloseTo(5.7, 0);
    expect(opp.matches[1].loadNumber).toBe("DM-5001");
    expect(opp.matches[1].distanceMiles).toBeCloseTo(17.0, 0);
    // Macon (80mi) was excluded
    expect(opp.matches.find((m) => m.loadNumber === "DM-5002")).toBeUndefined();
  });

  it("returns zero matches when delivery address is blank or nowhere near candidates", () => {
    const blank = findBackhauls({ address: "" }, openLoads);
    expect(blank.count).toBe(0);

    const far = findBackhauls({ address: "Seattle, WA", lat: 47.6062, lng: -122.3321 }, openLoads);
    expect(far.count).toBe(0);
  });
});
