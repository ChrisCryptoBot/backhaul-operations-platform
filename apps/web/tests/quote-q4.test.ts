import { describe, expect, test } from "vitest";
import { BLANK_QUOTE, pricingKeyOf, type QuoteValues } from "@/lib/quote";

/** Quote, review round four (Q4): the live price runs again only when something it depends on changes. */
const base: QuoteValues = {
  ...BLANK_QUOTE,
  stops: [
    { role: "pickup", address: "Dallas, TX", appointment: "2027-01-11T08:00" },
    { role: "delivery", address: "Atlanta, GA", appointment: "2027-01-12T08:00" }
  ],
  broker: "Acme",
  offer: "1500",
  loadedMiles: "780"
};

describe("what the live price depends on", () => {
  test("paperwork and stop contacts do not price the fleet again", () => {
    const k = pricingKeyOf(base);
    expect(pricingKeyOf({ ...base, poNumber: "PO-1", loadNumber: "LD-9", bolNumber: "B", proNumber: "P", rateConNumber: "R", notes: "call first", brokerPhone: "555-0100", brokerEmail: "a@b.co", brokerMc: "123456", commodity: "Paper", pieceCount: "3", palletCount: "20", paymentTerms: "Net 30", detentionFreeMinutes: "120", detentionHourlyRate: "50", hazmatUnNumber: "UN1203", reeferMode: "continuous" })).toBe(k);
    expect(pricingKeyOf({ ...base, stops: base.stops.map((s) => ({ ...s, facility: "Dock 4", contactName: "Bob", contactPhone: "555-0101", notes: "Gate 2", refs: "PU-1", zone: "America/New_York" })) })).toBe(k);
  });

  test("the money, the miles, the route, the times, the customer and the load's size do", () => {
    const k = pricingKeyOf(base);
    for (const changed of [
      { ...base, offer: "1600" },
      { ...base, loadedMiles: "800" },
      { ...base, broker: "Other" },
      { ...base, weightLbs: "44000" },
      { ...base, hazmatClass: "3" },
      { ...base, fuelPrice: "3.50" },
      { ...base, stops: [base.stops[0]!, { ...base.stops[1]!, address: "Macon, GA" }] },
      { ...base, stops: [base.stops[0]!, { ...base.stops[1]!, appointment: "2027-01-12T09:00" }] },
      { ...base, stops: [base.stops[0]!, { ...base.stops[1]!, lat: 33.75, lng: -84.39 }] },
      { ...base, emptyByTruck: { t1: "40" } }
    ]) {
      expect(pricingKeyOf(changed)).not.toBe(k);
    }
  });
});
