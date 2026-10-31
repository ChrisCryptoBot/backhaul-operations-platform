import { describe, expect, it } from "vitest";
import { grossOf } from "../src/lib/load-gross";
import { daysPastDue, dueAt, isOverdue } from "../src/lib/overdue";
import { invoiceReadiness } from "../src/lib/invoicing";

/** One definition of what a load earned, one rule for when an invoice is late, and the invoice caution for a short pay. */
const base = { status: "completed", quotedRevenue: 1000, actualRevenue: null, fuelSurcharge: null, layoverPay: null, tonuRevenue: null };

describe("what a load earned", () => {
  it("is the agreed rate plus surcharge and layover until a linehaul paid is entered", () => {
    expect(grossOf(base)).toBe(1000);
    expect(grossOf({ ...base, fuelSurcharge: 45.5, layoverPay: 100 })).toBe(1145.5);
  });
  it("uses the linehaul actually paid in place of the agreed rate, not on top of it", () => {
    expect(grossOf({ ...base, actualRevenue: 850.25, fuelSurcharge: 50 })).toBe(900.25);
  });
  it("is the fee for a TONU and nothing for a cancelled load", () => {
    expect(grossOf({ ...base, status: "tonu", tonuRevenue: 150, quotedRevenue: 2000 })).toBe(150);
    expect(grossOf({ ...base, status: "cancelled" })).toBe(0);
  });
});

describe("when an invoice is late", () => {
  const sent = new Date("2026-03-01T20:00:00Z");
  it("is due on calendar days, so a change of clocks does not move it a day", () => {
    const due = dueAt(sent, 30)!;
    // 30 days across the March clock change is an hour short of 30 x 24 h in UTC, still the same calendar day.
    expect(Math.abs(due.getTime() - sent.getTime() - 30 * 86_400_000)).toBeLessThanOrEqual(3_600_000);
  });
  it("is late from the day after it is due, not the hour after", () => {
    const due = dueAt(sent, 30)!;
    expect(isOverdue(sent, 30, new Date(due.getTime() + 3_600_000))).toBe(false);
    expect(isOverdue(sent, 30, new Date(due.getTime() + 36 * 3_600_000))).toBe(true);
    expect(daysPastDue(sent, 30, due)).toBe(0);
  });
  it("has no answer without an invoice date", () => {
    expect(dueAt(null, 30)).toBeNull();
    expect(isOverdue(null, 30)).toBe(false);
  });
});

describe("the invoice bills the agreed rate", () => {
  const load = { loadNumber: "L1", brokerName: "Acme", brokerEmail: "ap@acme.test", brokerPhone: null, deliveredAt: new Date(), status: "completed", pod: "received", podNote: null, quotedRevenue: 1000 };
  const cautions = (extra: Record<string, unknown>) => invoiceReadiness({ ...load, ...extra } as never).cautions.join(" ");
  it("says so when the linehaul paid was different", () => {
    expect(cautions({ paidLinehaul: 850 })).toMatch(/paid at delivery was \$850\.00, not the agreed \$1,000\.00.*short/);
    expect(cautions({ paidLinehaul: 1100 })).toMatch(/over/);
  });
  it("says nothing when it matches within a dollar, or was not entered", () => {
    expect(cautions({ paidLinehaul: 1000.4 })).not.toMatch(/paid at delivery/);
    expect(cautions({ paidLinehaul: null })).not.toMatch(/paid at delivery/);
  });
});
