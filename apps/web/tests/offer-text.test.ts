import { describe, expect, it } from "vitest";
import { offerText } from "../src/lib/offer-text";

const summary = {
  stops: [
    { seq: 2, type: "delivery" as const, address: "Tulsa, OK", window_earliest: "2027-06-16T21:00:00.000Z" },
    { seq: 1, type: "pickup" as const, address: "Dallas, TX", window_earliest: "2027-06-16T13:00:00.000Z", window_latest: "2027-06-16T14:00:00.000Z", po_number: "PO-7781", dock_notes: "Door 4" }
  ],
  equipment: { trailer_type: "dry_van" },
  driver_pay: { kind: "cpm", rate: 0.55, estimate: 143 },
  reference: { load_number: "DM-40002" },
  miles: { loaded: 260 },
  weight_lbs: 38000,
  dispatcher: { name: "Maria" }
};

describe("the offer as a text message, for a driver without the app", () => {
  it("lists the stops in order with their times and refs, the freight, and the driver's own pay", () => {
    const t = offerText(summary, "America/Chicago");
    const lines = t.split("\n");
    expect(lines[0]).toBe("Load DM-40002, from Maria");
    expect(lines[1]).toMatch(/^1\. Pick up: Dallas, TX, Jun 16, 8:00 AM CT to Jun 16, 9:00 AM CT \(ref PO-7781\)$/);
    expect(lines[2]).toBe("   Door 4");
    expect(lines[3]).toMatch(/^2\. Deliver: Tulsa, OK, Jun 16, 4:00 PM CT$/);
    expect(t).toContain("dry van · 38,000 lb · 260 loaded mi");
    expect(t).toContain("Your pay: $0.55 a mile, about $143.00");
  });

  it("never says what the customer pays: only what is in the driver-safe summary goes in", () => {
    const t = offerText({ ...summary, ...({ quotedRevenue: 1500, gross: 1725 } as object) }, "America/Chicago");
    expect(t).not.toMatch(/1,?500|1,?725|gross|rate con/i);
  });
});
