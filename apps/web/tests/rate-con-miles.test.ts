import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldMeasureMiles, sourceAfterTyping } from "../src/lib/rate-con-miles";
import { POST } from "@/app/(desk)/geo/measure/route";

describe("miles on a rate confirmation's review", () => {
  it("reads blank as handing the box back to the map, and anything else as typed", () => {
    expect(sourceAfterTyping("")).toBe("none");
    expect(sourceAfterTyping("   ")).toBe("none");
    expect(sourceAfterTyping("452")).toBe("typed");
  });

  it("measures only an empty box or an earlier measurement, once the stops can be looked up and the route is new", () => {
    expect(shouldMeasureMiles({ source: "none", ready: true, routeChanged: true })).toBe(true);
    expect(shouldMeasureMiles({ source: "measured", ready: true, routeChanged: true })).toBe(true); // a stop changed after a measurement
    expect(shouldMeasureMiles({ source: "none", ready: true, routeChanged: false })).toBe(false); // already measured this route
    expect(shouldMeasureMiles({ source: "none", ready: false, routeChanged: true })).toBe(false); // an address is not typed yet
  });

  it("never replaces miles the document printed or a person typed", () => {
    expect(shouldMeasureMiles({ source: "document", ready: true, routeChanged: true })).toBe(false);
    expect(shouldMeasureMiles({ source: "typed", ready: true, routeChanged: true })).toBe(false);
  });
});

describe("the measure route, for a screen with no trucks", () => {
  const original = process.env.MAPBOX_ACCESS_TOKEN;
  const urls: string[] = [];
  const city = (text: string, state: string, lng: number, lat: number) => ({ features: [{ text, place_type: ["place"], center: [lng, lat], context: [{ id: "region.1", text: state, short_code: `US-${state}` }] }] });

  beforeEach(() => {
    urls.length = 0;
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("/directions/")) return { ok: true, json: async () => ({ routes: [{ distance: 1609.344 * 1400, duration: 3600 * 21, legs: [{ distance: 1609.344 * 1400 }] }] }) };
        const body = url.includes("MilesTestAtlanta") ? city("Atlanta", "GA", -84.39, 33.75) : city("Denver", "CO", -104.99, 39.74);
        return { ok: true, json: async () => body };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = original;
  });

  const post = (body: unknown) => POST(new Request("http://localhost/geo/measure", { method: "POST", body: JSON.stringify(body) }));
  const stops = [
    { address: "MilesTestAtlanta, GA", role: "pickup" },
    { address: "MilesTestDenver, CO", role: "delivery" }
  ];

  it("measures just the stops when asked for no trucks: two lookups and one drive, nothing else", async () => {
    const out = await (await post({ stops, homes: false })).json();
    expect(out).toMatchObject({ ok: true, loadedMiles: 1400, emptyMidMiles: 0, loadedHours: 21, perTruck: {} });
    expect(urls).toHaveLength(3);
    expect(urls.filter((u) => u.includes("/geocoding/"))).toHaveLength(2);
  });

  it("still refuses a route that is not two to ten stops", async () => {
    expect((await post({ stops: [stops[0]], homes: false })).status).toBe(400);
  });
});
