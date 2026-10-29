import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addressReady,
  condenseFeature,
  legKinds,
  loadedLegHours,
  METERS_TO_MILES,
  parseRoute,
  parseSuggestions,
  roundMiles,
  splitRouteMiles
} from "@/lib/geo";
import { drive, geocode, geocodePermanent, mapboxConfigured, suggestPlaces } from "@/server/geo/mapbox";
import { measureQuote } from "@/server/geo/measure";
import { driveHoursFor } from "@/server/tl/evaluate";

const city = (text: string, state: string, lng: number, lat: number) => ({ text, place_type: ["place"], center: [lng, lat], context: [{ id: "region.1", text: state, short_code: `US-${state}` }] });

describe("labels", () => {
  it("condenses a city, a zip code and an address the way a dispatcher types them", () => {
    expect(condenseFeature(city("Dallas", "TX", -96.8, 32.78))).toEqual({ label: "Dallas, TX", lat: 32.78, lng: -96.8 });
    expect(
      condenseFeature({ text: "75201", place_type: ["postcode"], center: [-96.8, 32.79], context: [{ id: "place.1", text: "Dallas" }, { id: "region.1", text: "Texas", short_code: "US-TX" }] })?.label
    ).toBe("Dallas, TX 75201");
    expect(
      condenseFeature({
        text: "Pennsylvania Avenue",
        address: "1600",
        place_type: ["address"],
        center: [-82.1, 41.4],
        context: [{ id: "postcode.1", text: "44052" }, { id: "place.1", text: "Lorain" }, { id: "region.1", text: "Ohio", short_code: "US-OH" }]
      })?.label
    ).toBe("1600 Pennsylvania Avenue, Lorain, OH 44052");
  });

  it("reads a Canadian province code and keeps Mapbox's own name when there is no state", () => {
    expect(condenseFeature(city("Toronto", "ON", -79.4, 43.7))?.label).toBe("Toronto, ON");
    expect(condenseFeature({ text: "Somewhere", place_name: "Somewhere, Nowhere", center: [1, 2] })?.label).toBe("Somewhere, Nowhere");
  });

  it("skips a feature with no coordinates", () => {
    expect(condenseFeature({ text: "Nowhere" })).toBeNull();
  });

  it("gives at most five suggestions, one per label, and nothing for a non-answer", () => {
    const features = [city("Dallas", "TX", -96.8, 32.78), city("Dallas", "TX", -96.7, 32.7), ...["A", "B", "C", "D", "E", "F"].map((n, i) => city(n, "TX", i, i))];
    const out = parseSuggestions({ features });
    expect(out).toHaveLength(5);
    expect(out.map((p) => p.label).filter((l) => l === "Dallas, TX")).toHaveLength(1);
    expect(parseSuggestions(null)).toEqual([]);
    expect(parseSuggestions({ message: "Not Authorized" })).toEqual([]);
  });
});

describe("routes", () => {
  it("reads the first route and refuses a malformed one", () => {
    expect(parseRoute({ routes: [{ distance: 1000, duration: 60, legs: [{ distance: 600 }, { distance: 400 }] }] })).toEqual({ meters: 1000, seconds: 60, legsMeters: [600, 400] });
    expect(parseRoute({ routes: [] })).toBeNull();
    expect(parseRoute({ routes: [{ distance: -1, duration: 5 }] })).toBeNull();
    expect(parseRoute(null)).toBeNull();
  });

  it("is empty only from a delivery to a pickup", () => {
    expect(legKinds(["pickup", "delivery"])).toEqual(["loaded"]);
    expect(legKinds(["pickup", "pickup", "delivery", "delivery"])).toEqual(["loaded", "loaded", "loaded"]);
    expect(legKinds(["pickup", "delivery", "pickup", "delivery"])).toEqual(["loaded", "empty", "loaded"]);
  });

  it("returns the directions total bit for bit when no leg is empty", () => {
    const total = 1_261_400;
    const out = splitRouteMiles({ totalMeters: total, legsMeters: [total], roles: ["pickup", "delivery"] });
    expect(out.loadedMiles).toBe(total * METERS_TO_MILES);
    expect(out.emptyMidMiles).toBe(0);
  });

  it("counts the leg between a delivery and the next pickup as empty, never dropping it", () => {
    const out = splitRouteMiles({ totalMeters: 3000, legsMeters: [1000, 500, 1500], roles: ["pickup", "delivery", "pickup", "delivery"] });
    expect(roundMiles(out.emptyMidMiles)).toBe(roundMiles(500 * METERS_TO_MILES));
    expect(out.loadedMiles + out.emptyMidMiles).toBeCloseTo(3000 * METERS_TO_MILES, 9);
  });

  it("keeps everything loaded when the legs do not line up with the stops", () => {
    const out = splitRouteMiles({ totalMeters: 3000, legsMeters: [3000], roles: ["pickup", "delivery", "pickup", "delivery"] });
    expect(out.emptyMidMiles).toBe(0);
    expect(out.loadedMiles).toBe(3000 * METERS_TO_MILES);
  });

  it("spreads the loaded hours by their share of the route", () => {
    expect(loadedLegHours(7200, 100, 50)).toBe(1);
    expect(loadedLegHours(0, 100, 50)).toBe(0);
  });

  it("looks a stop up only once it has three characters", () => {
    expect(addressReady("da")).toBe(false);
    expect(addressReady("  dal ")).toBe(true);
  });

  it("converts meters to miles with the true factor", () => {
    expect(roundMiles(1609.344 * METERS_TO_MILES * 10)).toBe(10);
  });
});

describe("the Mapbox module", () => {
  const calls: string[] = [];
  const answers = new Map<string, unknown>();
  const original = process.env.MAPBOX_ACCESS_TOKEN;

  beforeEach(() => {
    calls.length = 0;
    answers.clear();
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(url);
        for (const [needle, body] of answers) if (url.includes(needle)) return { ok: true, json: async () => body };
        return { ok: false, json: async () => ({}) };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = original;
  });

  it("asks the temporary endpoint for suggestions, in the US and Canada, and the permanent one only to store", async () => {
    answers.set("/Dallas.json",{ features: [city("Dallas", "TX", -96.8, 32.78)] });
    expect((await suggestPlaces("Dallas"))[0]?.label).toBe("Dallas, TX");
    expect(calls[0]).toContain("/geocoding/v5/mapbox.places/Dallas.json");
    expect(calls[0]).toContain("country=us%2Cca");
    expect(calls[0]).toContain("autocomplete=true");
    expect(calls[0]).not.toContain("permanent");
    await geocodePermanent("Dallas");
    expect(calls[1]).toContain("/geocoding/v5/mapbox.places-permanent/Dallas.json");
    expect(calls[1]).toContain("autocomplete=false");
  });

  it("does not call out for a one-letter query, with no key, or with fewer than two points", async () => {
    expect(await suggestPlaces("d")).toEqual([]);
    delete process.env.MAPBOX_ACCESS_TOKEN;
    expect(mapboxConfigured()).toBe(false);
    expect(await suggestPlaces("dallas")).toEqual([]);
    expect(await geocode("dallas")).toBeNull();
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    expect(await drive([{ label: "A", lat: 1, lng: 1 }])).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("fails soft when Mapbox answers with an error or the request throws", async () => {
    expect(await suggestPlaces("nowhere")).toEqual([]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("offline"));
    expect(await geocodePermanent("somewhere")).toBeNull();
  });

  it("remembers a lookup, so a truck base is not geocoded again on every edit", async () => {
    answers.set("/Memory%20City", { features: [city("Memory City", "TX", -97, 31)] });
    await geocode("Memory City");
    await geocode("  memory city ");
    expect(calls.filter((u) => u.includes("Memory%20City"))).toHaveLength(1);
  });

  it("drives the stops in order as lng,lat pairs", async () => {
    answers.set("/directions/v5/mapbox/driving/", { routes: [{ distance: 1609.344 * 100, duration: 7200, legs: [{ distance: 1609.344 * 100 }] }] });
    const route = await drive([{ label: "A", lat: 32.78, lng: -96.8 }, { label: "B", lat: 33.75, lng: -84.39 }]);
    expect(calls[0]).toContain("/driving/-96.8,32.78;-84.39,33.75?");
    expect(calls[0]).toContain("overview=false");
    expect(route?.seconds).toBe(7200);
  });

  describe("measuring a quote", () => {
    const stops = [{ address: "Alpha, TX", role: "pickup" as const }, { address: "Bravo, GA", role: "delivery" as const }];

    it("measures loaded miles and hours, and each truck from its own base", async () => {
      answers.set("/Alpha%2C%20TX", { features: [city("Alpha", "TX", -96, 32)] });
      answers.set("/Bravo%2C%20GA", { features: [city("Bravo", "GA", -84, 33)] });
      answers.set("/Houston%2C%20TX", { features: [city("Houston", "TX", -95, 29)] });
      // Every directions call answers 100 mi in 2 h; the route itself is the only one with one leg of that length.
      answers.set("/directions/v5/mapbox/driving/", { routes: [{ distance: 1609.344 * 100, duration: 7200, legs: [{ distance: 1609.344 * 100 }] }] });
      const out = await measureQuote({ stops, homes: [{ id: "t1", address: "Houston, TX" }, { id: "t2", address: "  " }] });
      expect(out).toMatchObject({ ok: true, loadedMiles: 100, emptyMidMiles: 0, loadedHours: 2 });
      if (!out.ok) throw new Error("expected a measure");
      expect(out.perTruck.t1).toEqual({ toPickup: 100, home: 100 });
      expect(out.perTruck.t2).toBeUndefined();
    });

    it("names the stop it could not find instead of guessing", async () => {
      answers.set("/Alpha%2C%20TX", { features: [city("Alpha", "TX", -96, 32)] });
      const out = await measureQuote({ stops: [stops[0]!, { address: "Nowhereville, ZZ", role: "delivery" }], homes: [] });
      expect(out).toEqual({ ok: false, error: expect.stringContaining("Could not find Nowhereville, ZZ") });
    });

    it("says so plainly when there is no key", async () => {
      delete process.env.MAPBOX_ACCESS_TOKEN;
      const out = await measureQuote({ stops, homes: [] });
      expect(out.ok).toBe(false);
      expect(calls).toHaveLength(0);
    });
  });
});

describe("drive hours on a load", () => {
  it("spreads the measured loaded-leg hours over every mile", () => {
    // 10 h for 500 loaded miles is 50 mph; 600 miles in all is then 12 h.
    expect(driveHoursFor({ estimatedLoadedHours: "10", loadedMiles: "500" }, 600)).toBeCloseTo(12, 9);
  });

  it("uses the measured speed, not a flat 50 mph", () => {
    // 500 miles in 8 h is 62.5 mph. Flat 50 mph would say 10 h.
    expect(driveHoursFor({ estimatedLoadedHours: "8", loadedMiles: "500" }, 500)).toBeCloseTo(8, 9);
    expect(driveHoursFor({ estimatedLoadedHours: null, loadedMiles: "500" }, 500)).toBeCloseTo(10, 9);
  });

  it("falls back to 50 mph when the hours are blank, zero, or there are no loaded miles", () => {
    expect(driveHoursFor({ estimatedLoadedHours: "0", loadedMiles: "500" }, 500)).toBeCloseTo(10, 9);
    expect(driveHoursFor({ estimatedLoadedHours: "6", loadedMiles: "0" }, 500)).toBeCloseTo(10, 9);
    expect(driveHoursFor({ loadedMiles: "500" }, 250)).toBeCloseTo(5, 9);
  });
});
