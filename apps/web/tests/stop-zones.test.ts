import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { instantInZone, zoneAt, zoneLabel } from "@/truelane/lib/rateCon/stopTime";
import { normalizeExtraction } from "@/truelane/rate-con/core";
import { DEMO_RATE_CON_READINGS } from "@/server/ratecon/fixtures";
import { extractionToLoadDraft, stopTime } from "@/server/ratecon/map";
import { printedLabel, resolveStopZones, zoneForAddress } from "@/server/geo/zones";

const iso = (d: Date | null) => d?.toISOString() ?? null;

describe("a printed wall time becomes the instant it means at the stop", () => {
  it("reads an Eastern stop in July as daylight time (the old fixed offset was an hour out)", () => {
    expect(iso(stopTime("2026-07-15", "09:00", "America/New_York"))).toBe("2026-07-15T13:00:00.000Z"); // EDT, UTC-4
  });

  it("reads the same stop in January as standard time", () => {
    expect(iso(stopTime("2027-01-15", "09:00", "America/New_York"))).toBe("2027-01-15T14:00:00.000Z"); // EST, UTC-5
  });

  it("reads a Central stop in July as CDT, where the old guess said CST all year", () => {
    expect(iso(stopTime("2026-07-14", "08:00", "America/Chicago"))).toBe("2026-07-14T13:00:00.000Z"); // CDT, UTC-5
    expect(iso(stopTime("2027-01-14", "08:00", "America/Chicago"))).toBe("2027-01-14T14:00:00.000Z"); // CST, UTC-6
  });

  it("reads a Pacific stop, and Arizona with no daylight time", () => {
    expect(iso(stopTime("2026-07-15", "08:00", "America/Los_Angeles"))).toBe("2026-07-15T15:00:00.000Z"); // PDT, UTC-7
    expect(iso(stopTime("2026-07-15", "08:00", "America/Phoenix"))).toBe("2026-07-15T15:00:00.000Z"); // MST all year, UTC-7
    expect(iso(stopTime("2026-01-15", "08:00", "America/Phoenix"))).toBe("2026-01-15T15:00:00.000Z");
  });

  it("puts a time that does not exist (spring forward) just after the gap", () => {
    expect(instantInZone("2027-03-14", "02:30", "America/New_York")).toBe(Date.parse("2027-03-14T07:30:00.000Z")); // 03:30 EDT
  });

  it("is null for a missing date or time, or a time that is not one", () => {
    expect(stopTime(null, "09:00", "America/Chicago")).toBeNull();
    expect(stopTime("2026-07-14", null, "America/Chicago")).toBeNull();
    expect(stopTime("2026-07-14", "25:99", "America/Chicago")).toBeNull();
  });
});

describe("the zone of a place", () => {
  it("comes from coordinates, including places that sit on a boundary", () => {
    expect(zoneAt(46.18, -103.39)).toBe("America/Denver"); // Bowman, ND
    expect(zoneAt(31.76, -106.49)).toBe("America/Denver"); // El Paso, TX
    expect(zoneAt(32.78, -96.8)).toBe("America/Chicago"); // Dallas
    expect(zoneAt(Number.NaN, -96.8)).toBeNull();
  });

  it("falls back to the state when the whole state is one zone, else assumes Central and says so", () => {
    expect(zoneForAddress("1450 Marietta Blvd NW, Atlanta, GA 30318")).toEqual({ zone: "America/New_York", source: "state" });
    expect(zoneForAddress("4800 Brighton Blvd, Denver, CO 80216")).toEqual({ zone: "America/Denver", source: "state" });
    expect(zoneForAddress("Phoenix, AZ")).toEqual({ zone: "America/Phoenix", source: "state" });
    expect(zoneForAddress("2300 Irving Blvd, Dallas, TX 75207")).toEqual({ zone: "America/Chicago", source: "assumed" }); // Texas is split
    expect(zoneForAddress("")).toEqual({ zone: "America/Chicago", source: "assumed" });
    expect(zoneForAddress(null)).toEqual({ zone: "America/Chicago", source: "assumed" });
  });
});

describe("the time as the document printed it", () => {
  it("is read back with the stop's own zone, in twelve-hour time", () => {
    expect(printedLabel("09:00", null, "America/New_York")).toBe("9:00 AM ET");
    expect(printedLabel("13:00", "16:00", "America/Denver")).toBe("1:00 PM to 4:00 PM MT");
    expect(printedLabel("07:05", null, "America/Phoenix")).toBe("7:05 AM MST");
    expect(printedLabel("00:30", null, "America/Chicago")).toBe("12:30 AM CT");
    expect(printedLabel(null, null, "America/Chicago")).toBeNull();
    expect(zoneLabel("America/Chicago")).toBe("CT");
  });
});

describe("a rate confirmation that crosses zones", () => {
  const sample = () => extractionToLoadDraft(normalizeExtraction(DEMO_RATE_CON_READINGS["RC-SLG-55102"]!))!;

  it("is read in each stop's own zone, in daylight time, with no miles invented", () => {
    const d = sample();
    expect(d.stops.map((s) => [iso(s.timeWindowEarliest), iso(s.timeWindowLatest)])).toEqual([
      ["2027-03-16T12:00:00.000Z", "2027-03-16T12:00:00.000Z"], // 8:00 EDT
      ["2027-03-18T19:00:00.000Z", "2027-03-18T22:00:00.000Z"] // 1:00 to 4:00 MDT
    ]);
    expect(d.stops.map((s) => [s.zone, s.zoneSource, s.printed])).toEqual([
      ["America/New_York", "state", "8:00 AM ET"],
      ["America/Denver", "state", "1:00 PM to 4:00 PM MT"]
    ]);
    expect(d.load.loadedMiles).toBeNull();
  });

  it("takes zones worked out from coordinates over the state fallback", () => {
    const raw = normalizeExtraction(DEMO_RATE_CON_READINGS["RC-SLG-55102"]!);
    const d = extractionToLoadDraft(raw, [{ zone: "America/Chicago", source: "coordinates" }, undefined])!;
    expect(iso(d.stops[0]!.timeWindowEarliest)).toBe("2027-03-16T13:00:00.000Z"); // 8:00 CDT
    expect(d.stops[0]).toMatchObject({ zone: "America/Chicago", zoneSource: "coordinates" });
    expect(d.stops[1]).toMatchObject({ zone: "America/Denver", zoneSource: "state" }); // no zone given: the fallback
  });

  it("reads a Texas stop in July as daylight time (the sample is dated November, in standard time)", () => {
    const raw = structuredClone(DEMO_RATE_CON_READINGS["RC-AFB-482913"]!) as { stops: Array<{ appointmentDate: string }> };
    for (const s of raw.stops) s.appointmentDate = "2026-07-14";
    const d = extractionToLoadDraft(normalizeExtraction(raw))!;
    expect(iso(d.stops[0]!.timeWindowEarliest)).toBe("2026-07-14T14:00:00.000Z"); // 09:00 CDT; the old fixed -06:00 said 15:00Z
    expect(d.stops[0]).toMatchObject({ zone: "America/Chicago", zoneSource: "assumed" }); // no coordinates here, and Texas is split
  });
});

describe("working out the zones of a document's stops", () => {
  const original = process.env.MAPBOX_ACCESS_TOKEN;
  const urls: string[] = [];
  const place = (text: string, state: string, lng: number, lat: number) => ({ features: [{ text, place_type: ["place"], center: [lng, lat], context: [{ id: "region.1", text: state, short_code: `US-${state}` }] }] });

  beforeEach(() => {
    urls.length = 0;
    process.env.MAPBOX_ACCESS_TOKEN = "pk.test-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.includes("ZoneTestElPaso") ? place("El Paso", "TX", -106.49, 31.76) : { features: [] };
        return { ok: true, json: async () => body };
      })
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (original === undefined) delete process.env.MAPBOX_ACCESS_TOKEN;
    else process.env.MAPBOX_ACCESS_TOKEN = original;
  });

  it("geocodes each stop on the temporary endpoint, reads the zone from the point, and falls back per stop when a place is not found", async () => {
    const out = await resolveStopZones(["ZoneTestElPaso 1 Dock Rd, El Paso, TX", "ZoneTestNowhere, GA"]);
    expect(out).toEqual([
      { zone: "America/Denver", source: "coordinates" },
      { zone: "America/New_York", source: "state" }
    ]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/geocoding/v5/mapbox.places/");
    expect(urls[0]).not.toContain("permanent"); // nothing is stored, so the temporary endpoint is the licensed one
    expect(urls[0]).toContain("access_token=");
  });

  it("makes no request without a key or without an address, and still answers", async () => {
    delete process.env.MAPBOX_ACCESS_TOKEN;
    expect(await resolveStopZones(["ZoneTestNoKey, CO", ""])).toEqual([
      { zone: "America/Denver", source: "state" },
      { zone: "America/Chicago", source: "assumed" }
    ]);
    expect(urls).toHaveLength(0);
  });
});
