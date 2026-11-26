import { describe, expect, test } from "vitest";
import { BLANK_QUOTE, floorOffer, readQuote, validateQuote, type QuoteValues } from "@/lib/quote";
import { zonedValues } from "@/server/tl/quote";
import { rateConDraftToQuote } from "@/lib/rate-con-to-quote";
import { parseBrokerSnippet } from "@/lib/quote-parser";
import { buildBrief } from "@/lib/quote-brief";

/**
 * Quote, review round two (Q2): a stop's time is the dock's time, on the clock where the stop is; the counter-offer floor is the audited figure; a rate confirmation's printed miles are
 * the contract's; a pasted email's ZIP code is not a weight.
 */
const CHICAGO = "America/Chicago";
const base = (over: Partial<QuoteValues> = {}): QuoteValues => ({ ...BLANK_QUOTE, offer: "1500", loadedMiles: "780", ...over });

describe("a stop's time is read on its own dock's clock", () => {
  test("the server works the clock out from where the stop is, whatever the browser sent", () => {
    const v = zonedValues(
      base({
        stops: [
          { role: "pickup", address: "Dallas, TX", appointment: "", zone: "Pacific/Honolulu" },
          { role: "delivery", address: "Atlanta, GA", appointment: "" },
          { role: "delivery", address: "El Paso, TX", appointment: "", lat: 31.7619, lng: -106.485 }
        ]
      }),
      CHICAGO
    );
    // Texas spans two zones: with no point, the carrier's clock; El Paso's point says Mountain. Georgia is one zone.
    expect(v.stops.map((s) => s.zone)).toEqual([CHICAGO, "America/New_York", "America/Denver"]);
    expect(zonedValues(base({ stops: [{ role: "pickup", address: "Dallas, TX", appointment: "" }, { role: "delivery", address: "Tulsa, OK", appointment: "" }] }), "America/New_York").stops[0]!.zone).toBe("America/New_York");
  });

  test("08:00 at an Atlanta dock is 13:00 UTC in January, wherever the carrier is", () => {
    const v = zonedValues(base({ stops: [{ role: "pickup", address: "Dallas, TX", appointment: "2027-01-11T08:00" }, { role: "delivery", address: "Atlanta, GA", appointment: "2027-01-12T08:00" }] }), CHICAGO);
    const input = readQuote(v)!;
    expect(new Date(input.stops[1]!.appointment!).toISOString()).toBe("2027-01-12T13:00:00.000Z");
    expect(new Date(input.stops[0]!.appointment!).toISOString()).toBe("2027-01-11T14:00:00.000Z");
  });

  test("the order of the stops is checked on the instants, so a later-looking Eastern time can still be before a Central one", () => {
    const v = zonedValues(base({ stops: [{ role: "pickup", address: "Memphis, TN", appointment: "2027-01-12T08:00", lat: 35.1495, lng: -90.049 }, { role: "delivery", address: "Atlanta, GA", appointment: "2027-01-12T08:30" }] }), CHICAGO);
    // 08:30 Eastern is 07:30 Central: before the 08:00 Central pickup.
    expect(validateQuote(v)).toMatchObject({ ok: false, errors: { stop1Time: expect.stringMatching(/before the stop ahead/) } });
  });
});

describe("the counter-offer floor is the audited figure, taken back to an offer", () => {
  test("a percent surcharge rides on the offer; a rate a mile does not; rounded up", () => {
    expect(floorOffer({ payNeeded: 1650, gross: 1500, marginPerMile: -0.1, fsc: 10, fscUnit: "percent", loadedMiles: 500 })).toBe(1500);
    expect(floorOffer({ payNeeded: 1651, gross: 1500, marginPerMile: -0.1, fsc: 10, fscUnit: "percent", loadedMiles: 500 })).toBe(1501);
    expect(floorOffer({ payNeeded: 1800, gross: 1700, marginPerMile: -0.1, fsc: 0.4, fscUnit: "per_mile", loadedMiles: 500 })).toBe(1600);
    expect(floorOffer({ payNeeded: 1507, gross: 1500, marginPerMile: -0.01, fsc: 0, fscUnit: "percent", loadedMiles: 780 })).toBe(1507);
  });

  test("a load that already clears has no floor button", () => {
    expect(floorOffer({ payNeeded: 1500, gross: 1500, marginPerMile: 0.2, fsc: 0, fscUnit: "percent", loadedMiles: 780 })).toBeNull();
    expect(floorOffer({ payNeeded: null, gross: 1500, marginPerMile: -0.2, fsc: 0, fscUnit: "percent", loadedMiles: 780 })).toBeNull();
  });
});

describe("a rate confirmation dropped on Quote", () => {
  const draft = (loadedMiles: number | null) => ({
    load: { quotedRevenue: 2400, loadedMiles, brokerName: "Acme Logistics" },
    stops: [
      { stopRole: "pickup", addressString: "Dallas, TX", timeWindowEarliest: "2027-01-11T14:00:00.000Z", timeWindowLatest: null, zone: CHICAGO },
      { stopRole: "delivery", addressString: "Atlanta, GA", timeWindowEarliest: "2027-01-12T13:00:00.000Z", timeWindowLatest: null, zone: "America/New_York" }
    ]
  });

  test("keeps the printed miles as the contract's, and shows each time on its dock's clock", () => {
    const out = rateConDraftToQuote(draft(812) as never, BLANK_QUOTE);
    expect(out.values.loadedMiles).toBe("812");
    expect(out.values.manual).toContain("loadedMiles");
    expect(out.values.stops[1]).toMatchObject({ appointment: "2027-01-12T08:00", zone: "America/New_York" });
    expect(out.values.stops[0]).toMatchObject({ appointment: "2027-01-11T08:00", zone: CHICAGO });
  });

  test("with no printed miles, the map measures them", () => {
    const out = rateConDraftToQuote(draft(null) as never, { ...BLANK_QUOTE, manual: ["loadedMiles", "loadedHours", "emptyHome"] });
    expect(out.values.manual).toEqual(["emptyHome"]);
  });
});

describe("a pasted broker email", () => {
  test("a ZIP code or a year is not a weight; a unit or the word makes it one", () => {
    expect(parseBrokerSnippet("Dallas, TX 75201 to Atlanta, GA 30303 paying $1,850").weightLbs).toBeUndefined();
    expect(parseBrokerSnippet("Pickup 01/12/2026 Dallas, TX to Atlanta, GA").weightLbs).toBeUndefined();
    expect(parseBrokerSnippet("Weight: 15000 Dallas, TX to Atlanta, GA").weightLbs).toBe("15000");
    expect(parseBrokerSnippet("Dallas, TX to Atlanta, GA 40,000 lbs").weightLbs).toBe("40000");
  });

  test("the origin does not swallow the lines above it", () => {
    const res = parseBrokerSnippet("Hi team,\nNeed a truck tomorrow\nDallas, TX to Atlanta, GA $1850");
    expect(res.origin).toBe("Dallas, TX");
    expect(res.destination).toBe("Atlanta, GA");
  });
});

describe("the copied brief", () => {
  test("says each dock's clock when the stops know it", () => {
    const text = buildBrief("customer", {
      stops: [
        { role: "pickup", address: "Dallas, TX", appointment: "2027-01-11T08:00", zone: CHICAGO },
        { role: "delivery", address: "Atlanta, GA", appointment: "2027-01-12T08:00", zone: "America/New_York" }
      ],
      loadedMiles: "780",
      weightLbs: "",
      trailer: "",
      offer: "1500",
      customer: "Acme",
      loadNumber: "",
      poNumber: ""
    });
    expect(text).toMatch(/8:00 AM CT/);
    expect(text).toMatch(/8:00 AM ET/);
    expect(text).toMatch(/each dock's local time/);
  });
});
