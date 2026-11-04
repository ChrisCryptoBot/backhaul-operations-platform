import { describe, expect, test } from "vitest";
import { BAND_LABEL, BLANK_QUOTE, gateTitle, grossPerLoadedMile, OVERRIDE_REASONS, quoteWarnings, readQuote, surchargeDollars, validateQuote, type QuoteValues } from "../src/lib/quote";
import { perMile } from "../src/lib/desk-format";
import { isQuote, notQuote, QUOTE_STATUS } from "../src/lib/quote-status";

const good: QuoteValues = {
  ...BLANK_QUOTE,
  stops: [
    { role: "pickup", address: "Dallas, TX", appointment: "2027-01-12T08:00" },
    { role: "delivery", address: "Tulsa, OK", appointment: "2027-01-12T17:00" }
  ],
  broker: "Acme Freight",
  offer: "1,500",
  loadedMiles: "260",
  emptyToPickup: "40",
  emptyHome: "240",
  marketRate: "1500"
};
const errorsOf = (over: Partial<QuoteValues>) => {
  const r = validateQuote({ ...good, ...over });
  return r.ok ? {} : r.errors;
};

describe("the quote form", () => {
  test("a good form reads as numbers, with commas allowed and times read on the Dallas clock", () => {
    const r = validateQuote(good);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.input).toMatchObject({ offer: 1500, loadedMiles: 260, emptyToPickup: 40, emptyHome: 240, marketTotal: 1500, broker: "Acme Freight", fscUnit: "percent", loadBack: false });
    expect(r.input.stops[0]!.appointment).toBe(Date.parse("2027-01-12T14:00:00Z")); // January is standard time, UTC-6
    expect(r.input.stops[1]!.appointment).toBe(Date.parse("2027-01-12T23:00:00Z"));
    expect(r.warnings).toEqual([]);
  });

  test("the route must be a pickup first and a delivery last, with somewhere to go", () => {
    expect(errorsOf({ stops: [good.stops[0]!] }).stops).toBe("A load needs a pickup and a delivery.");
    expect(errorsOf({ stops: [{ role: "delivery", address: "A, TX", appointment: "" }, good.stops[1]!] }).stops).toBe("The first stop is the pickup.");
    expect(errorsOf({ stops: [good.stops[0]!, { role: "pickup", address: "B, TX", appointment: "" }] }).stops).toBe("The last stop is a delivery.");
    expect(errorsOf({ stops: [{ ...good.stops[0]!, address: "" }, good.stops[1]!] }).stop0).toMatch(/Where is this stop/);
    expect(errorsOf({ stops: [good.stops[0]!, { ...good.stops[1]!, appointment: "tomorrow" }] }).stop1Time).toBe("A real date and time.");
    // A middle stop can be either.
    const three = validateQuote({ ...good, stops: [good.stops[0]!, { role: "pickup", address: "Waco, TX", appointment: "" }, good.stops[1]!] });
    expect(three.ok).toBe(true);
  });

  test("an offer and loaded miles are needed, and each number is held to a sensible range", () => {
    expect(errorsOf({ offer: "" }).offer).toBe("Type what the load pays.");
    expect(errorsOf({ offer: "0" }).offer).toBe("Type what the load pays.");
    expect(errorsOf({ offer: "250000" }).offer).toMatch(/a lot/);
    expect(errorsOf({ loadedMiles: "" }).loadedMiles).toBe("Type the loaded miles.");
    expect(errorsOf({ loadedMiles: "9000" }).loadedMiles).toBe("Under 5,000 miles.");
    expect(errorsOf({ emptyToPickup: "-5" }).emptyToPickup).toMatch(/0 to 5,000/);
    expect(errorsOf({ emptyByTruck: { t1: "abc" } })["empty:t1"]).toMatch(/0 to 5,000/);
    expect(errorsOf({ fsc: "120", fscUnit: "percent" }).fsc).toBe("A percent from 0 to 100.");
    expect(errorsOf({ fsc: "-1" }).fsc).toBe("A number, 0 or more.");
    expect(errorsOf({ marketRate: "0" }).marketRate).toMatch(/total for the load/);
    expect(errorsOf({ payTermsDays: "30.5" }).payTermsDays).toBe("Whole days, 0 to 120.");
    expect(errorsOf({ factoringPct: "140" }).factoringPct).toBe("A percent from 0 to 100.");
  });

  test("the live price needs only an offer and loaded miles, and ignores a field that is not right yet", () => {
    expect(readQuote(BLANK_QUOTE)).toBeNull();
    expect(readQuote({ ...BLANK_QUOTE, offer: "900" })).toBeNull();
    const r = readQuote({ ...BLANK_QUOTE, offer: "900", loadedMiles: "200", fsc: "abc", payTermsDays: "x", emptyToPickup: "-3", factoringPct: "400" });
    expect(r).toMatchObject({ offer: 900, loadedMiles: 200, fsc: 0, emptyToPickup: 0, payTermsDays: null, factoringFraction: null });
  });

  test("a surcharge is added in dollars whichever way it was typed", () => {
    const base = { offer: 1000, loadedMiles: 250 };
    expect(surchargeDollars({ ...base, fsc: 8, fscUnit: "percent" })).toBe(80);
    expect(surchargeDollars({ ...base, fsc: 0.3, fscUnit: "per_mile" })).toBe(75);
    expect(surchargeDollars({ ...base, fsc: 0, fscUnit: "percent" })).toBe(0);
  });

  test("a market rate that works out to a per-mile figure, or a per-mile surcharge over $3, is questioned", () => {
    const r = readQuote({ ...good, marketRate: "2.4" })!;
    expect(quoteWarnings(r)[0]).toMatch(/total for the load, not a rate per mile/);
    expect(quoteWarnings(readQuote({ ...good, marketRate: "99999" })!)[0]).toMatch(/\$\d+\.\d\d a mile/);
    expect(quoteWarnings(readQuote({ ...good, fsc: "4", fscUnit: "per_mile" })!)[0]).toMatch(/above the usual range/);
    expect(quoteWarnings(readQuote(good)!)).toEqual([]);
  });

  test("the phone's wording is kept: every band has a label, and each gate asks its own question", () => {
    expect(Object.keys(BAND_LABEL).sort()).toEqual(["above_market", "at_market", "below_floor", "needs_fuel", "negotiate", "no_benchmark", "strong_caution"]);
    expect(BAND_LABEL.below_floor).toEqual({ label: "Below your cost", tone: "bad" });
    expect(gateTitle("needs_fuel")).toBe("Book without knowing the fuel cost?");
    expect(gateTitle("no_market")).toBe("Book without knowing the market rate?");
    expect(gateTitle("under_market")).toBe("Book this below-market load?");
    expect(gateTitle("under_market", "lane")).toBe("Book this well under what the lane pays you?");
    expect(gateTitle("below_floor")).toBe("Why book a load that does not cover its costs?");
    expect([...OVERRIDE_REASONS]).toEqual(["Relationship", "Positioning for return load", "Cash flow", "Other"]);
  });
});

describe("the quote status", () => {
  test("one predicate keeps quotes out of every general query", () => {
    expect(QUOTE_STATUS).toBe("quote");
    expect(notQuote).toEqual({ status: { not: "quote" } });
    expect(isQuote("quote")).toBe(true);
    expect(isQuote("draft")).toBe(false);
    expect(isQuote(null)).toBe(false);
  });
});

describe("what the load is: weight, size, hazmat and what it needs", () => {
  test("left blank, the load says nothing about itself", () => {
    const r = readQuote(good)!;
    expect(r.specs).toEqual({ weightLbs: null, lengthFt: null, widthFt: null, heightIn: null, hazmatClass: null, requiresLiftgate: false, requiresRamp: false, requiresPalletJack: false });
    expect(validateQuote(good).ok).toBe(true);
  });

  test("typed, they are read as numbers and flags", () => {
    const r = readQuote({ ...good, weightLbs: "12,500", lengthFt: "26", widthFt: "8.5", heightIn: "96", hazmatClass: " 3 ", requiresLiftgate: true, requiresPalletJack: true })!;
    expect(r.specs).toEqual({ weightLbs: 12500, lengthFt: 26, widthFt: 8.5, heightIn: 96, hazmatClass: "3", requiresLiftgate: true, requiresRamp: false, requiresPalletJack: true });
  });

  test("a figure that cannot be right is refused, in words", () => {
    expect(errorsOf({ weightLbs: "abc" }).weightLbs).toMatch(/whole number/);
    expect(errorsOf({ weightLbs: "12.5" }).weightLbs).toMatch(/whole number/);
    expect(errorsOf({ weightLbs: "300000" }).weightLbs).toMatch(/200,000/);
    expect(errorsOf({ lengthFt: "0" }).lengthFt).toMatch(/above 0/);
    expect(errorsOf({ widthFt: "45" }).widthFt).toMatch(/30/);
    expect(errorsOf({ heightIn: "-4" }).heightIn).toMatch(/above 0/);
    expect(errorsOf({ hazmatClass: "x".repeat(21) }).hazmatClass).toMatch(/20/);
    expect(errorsOf({ weightLbs: "44000", lengthFt: "53", widthFt: "8.5", heightIn: "162" })).toEqual({});
  });
});

describe("the gross rate per loaded mile, the line under the Offer field", () => {
  test("is the typed offer over the typed loaded miles, and reads as a rate a mile", () => {
    expect(grossPerLoadedMile("6000", "2055")).toBeCloseTo(2.9197, 4);
    expect(perMile(grossPerLoadedMile("6000", "2055"))).toBe("$2.92/mi");
    expect(perMile(grossPerLoadedMile("1,500", "260"))).toBe("$5.77/mi");
  });

  test("takes the numbers as the form holds them: commas, spaces and decimals", () => {
    expect(grossPerLoadedMile(" 6,000 ", "2,055")).toBeCloseTo(2.9197, 4);
    expect(grossPerLoadedMile("1250.50", "400.5")).toBeCloseTo(1250.5 / 400.5, 10);
  });

  test("shows nothing until both fields are typed and mean something", () => {
    expect(grossPerLoadedMile("", "2055")).toBeNull();
    expect(grossPerLoadedMile("6000", "")).toBeNull();
    expect(grossPerLoadedMile("0", "2055")).toBeNull();
    expect(grossPerLoadedMile("-6000", "2055")).toBeNull();
    expect(grossPerLoadedMile("6000", "0")).toBeNull();
    expect(grossPerLoadedMile("6000", "-5")).toBeNull();
    expect(grossPerLoadedMile("abc", "2055")).toBeNull();
    expect(grossPerLoadedMile("6000", "Infinity")).toBeNull();
  });

  test("shows nothing under a mile of loaded run, where a rate a mile is noise", () => {
    expect(grossPerLoadedMile("500", "0.4")).toBeNull();
    expect(grossPerLoadedMile("500", "0.99")).toBeNull();
    expect(grossPerLoadedMile("500", "1")).toBe(500);
  });

  test("is the typed offer only: the fuel surcharge field is not part of it", () => {
    const v = { ...good, offer: "6000", loadedMiles: "2055", fsc: "300" };
    expect(grossPerLoadedMile(v.offer, v.loadedMiles)).toBeCloseTo(6000 / 2055, 10);
  });
});
