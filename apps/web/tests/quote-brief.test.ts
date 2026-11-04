import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { BRIEF_LABEL, buildBrief, type BriefInput, type BriefKind } from "../src/lib/quote-brief";

/**
 * Copy Brief: three texts for three readers. The customer's email and the driver's text must never carry our own figures (the truck and
 * the margin); only the dispatch note, which is for the team, may.
 */
const input: BriefInput = {
  stops: [
    { role: "pickup", address: "Dallas, TX", appointment: "2027-01-12T08:00" },
    { role: "delivery", address: "Atlanta, GA", appointment: "2027-01-13T17:00" }
  ],
  loadedMiles: "800",
  weightLbs: "42000",
  trailer: "dry_van",
  offer: "1850",
  customer: "Acme Freight",
  loadNumber: "ACM-1001",
  poNumber: "PO-55",
  internal: { truckName: "Unit 101", allInPerMile: 1.8, marginPerMile: 0.31 }
};

const blank: BriefInput = { stops: [{ role: "pickup", address: "", appointment: "" }, { role: "delivery", address: "", appointment: "" }], loadedMiles: "", weightLbs: "", trailer: "", offer: "", customer: "", loadNumber: "", poNumber: "" };

describe("the customer email", () => {
  test("says where, when, what and how much, in lines a person can read", () => {
    expect(buildBrief("customer", input)).toBe(
      [
        "Quote for Acme Freight",
        "",
        "Pickup: Dallas, TX, 01/12/2027 8:00 AM",
        "Delivery: Atlanta, GA, 01/13/2027 5:00 PM",
        "Times are Dallas time.",
        "Loaded miles: 800 mi",
        "Equipment: 42,000 lb dry van",
        "Rate: $1,850 ($2.31/mi loaded)",
        "Load #: ACM-1001",
        "PO #: PO-55"
      ].join("\n")
    );
  });

  test("a stop between is listed with its kind", () => {
    const text = buildBrief("customer", { ...input, stops: [input.stops[0]!, { role: "pickup", address: "Memphis, TN", appointment: "" }, input.stops[1]!] });
    expect(text).toContain("Stop 2 (pickup): Memphis, TN");
  });

  test("the rate shows cents when there are some, and no rate a mile without miles", () => {
    expect(buildBrief("customer", { ...input, offer: "1,250.50" })).toContain("Rate: $1,250.50 ($1.56/mi loaded)");
    expect(buildBrief("customer", { ...input, loadedMiles: "" })).toContain("Rate: $1,850\n");
  });

  test("with nothing filled in it still reads, and invents nothing", () => {
    expect(buildBrief("customer", blank)).toBe("Quote\n\nPickup: TBD\nDelivery: TBD");
  });
});

describe("the driver text", () => {
  test("is the trip in a few short lines, with no money in it", () => {
    expect(buildBrief("driver", input)).toBe(["Dallas, TX to Atlanta, GA - 800 mi", "PU 01/12/2027 8:00 AM, DEL 01/13/2027 5:00 PM (Dallas time)", "42k lb dry van - Load# ACM-1001 - PO PO-55"].join("\n"));
  });

  test("lists the stops between, and drops lines it has nothing for", () => {
    const text = buildBrief("driver", { ...input, stops: [{ ...input.stops[0]!, appointment: "" }, { role: "pickup", address: "Memphis, TN", appointment: "" }, { ...input.stops[1]!, appointment: "" }], weightLbs: "", trailer: "", loadNumber: "", poNumber: "" });
    expect(text).toBe("Dallas, TX to Atlanta, GA via Memphis, TN - 800 mi");
  });

  test("is short enough for a text message: at most four lines, plain characters only", () => {
    const text = buildBrief("driver", input);
    expect(text.split("\n").length).toBeLessThanOrEqual(4);
    expect(text).toMatch(/^[\x20-\x7E\n]*$/);
  });

  test("a light load is given in pounds, not as 0k", () => {
    expect(buildBrief("driver", { ...input, weightLbs: "800" })).toContain("800 lb dry van");
  });

  test("with nothing filled in it is only the lane placeholders", () => {
    expect(buildBrief("driver", blank)).toBe("Origin to Destination");
  });
});

describe("the dispatch note", () => {
  test("is the one-liner the button has always made, truck and margin included", () => {
    expect(buildBrief("dispatch", input)).toBe("Dallas, TX -> Atlanta, GA · 800 mi · 42k dry van · $1850 ($1.80/mi) · Unit 101 (+$0.31/mi)");
  });

  test("shows a margin below zero with its sign, and leaves out what it does not have", () => {
    expect(buildBrief("dispatch", { ...input, internal: { truckName: "Unit 102", allInPerMile: null, marginPerMile: -0.12 } })).toBe("Dallas, TX -> Atlanta, GA · 800 mi · 42k dry van · $1850 · Unit 102 (-$0.12/mi)");
    expect(buildBrief("dispatch", { ...input, internal: undefined })).toBe("Dallas, TX -> Atlanta, GA · 800 mi · 42k dry van · $1850");
  });

  test("with nothing filled in it is the placeholders", () => {
    expect(buildBrief("dispatch", blank)).toBe("Origin -> Destination · ? mi · Truck · Unpriced");
  });

  test("a weight typed with a comma is read, not printed as NaN", () => {
    expect(buildBrief("dispatch", { ...input, weightLbs: "42,000" })).toContain("· 42k dry van ·");
  });
});

describe("nothing of ours reaches the customer or the driver", () => {
  const ours = ["Unit 101", "0.31", "1.80", "margin", "floor", "all-in", "truck"];

  test.each(["customer", "driver"] as const)("the %s text carries no truck, no margin and no all-in figure", (kind) => {
    const text = buildBrief(kind, input).toLowerCase();
    for (const secret of ours) expect(text).not.toContain(secret.toLowerCase());
  });

  test("the driver text has no money at all: no dollar sign, no rate, no pay", () => {
    const text = buildBrief("driver", input);
    expect(text).not.toContain("$");
    expect(text.toLowerCase()).not.toMatch(/rate|pay|offer/);
  });

  test("the customer and driver builders never read `internal`: only the dispatch note does", () => {
    const src = fs.readFileSync(path.join(__dirname, "../src/lib/quote-brief.ts"), "utf8");
    const forThem = src.slice(src.indexOf("function customerEmail"), src.indexOf("/** The one-liner the Copy Brief button"));
    expect(forThem.length).toBeGreaterThan(500);
    expect(forThem).not.toMatch(/internal/);
    const dispatch = src.slice(src.indexOf("function dispatchNote"), src.indexOf("export function buildBrief"));
    expect(dispatch).toMatch(/i\.internal/);
  });

  test("the same holds when the truck has a very different name and a loss", () => {
    const text = buildBrief("customer", { ...input, internal: { truckName: "Big Blue", allInPerMile: 0.5, marginPerMile: -2.5 } });
    expect(text).not.toContain("Big Blue");
    expect(text).not.toContain("2.5");
  });
});

describe("the words", () => {
  test("every kind has a menu label, and the internal one says so", () => {
    const kinds: BriefKind[] = ["customer", "driver", "dispatch"];
    expect(kinds.map((k) => BRIEF_LABEL[k])).toEqual(["Customer email", "Driver text", "Dispatch note (internal)"]);
  });

  test("the desk says Customer, never broker, in what it writes", () => {
    for (const kind of ["customer", "driver", "dispatch"] as const) {
      expect(buildBrief(kind, input).toLowerCase()).not.toContain("broker");
      expect(BRIEF_LABEL[kind].toLowerCase()).not.toContain("broker");
    }
  });
});
