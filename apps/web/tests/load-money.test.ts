import { describe, expect, it } from "vitest";
import { grossOf } from "../src/lib/load-gross";
import { loadLedger } from "../src/lib/load-ledger";
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

describe("Money tab ledger (loadLedger)", () => {
  const mkLoad = (overrides: Record<string, unknown> = {}) => ({
    status: "completed",
    quotedRevenue: 2000,
    actualRevenue: null,
    fuelSurcharge: 200,
    layoverPay: 0,
    tonuRevenue: null,
    expenseFuelActual: 300,
    expenseTolls: 20,
    expenseMisc: 0,
    insuranceRiderFlat: 0,
    assignmentPayEstimate: 500,
    forecastFuel: 250,
    totalMiles: 1000,
    ...overrides
  });

  it("TONU shows only fee in totalRev, keeps referenceRate outside sum, and preserves driver pay", () => {
    const out = loadLedger(mkLoad({ status: "tonu", tonuRevenue: 250, assignmentPayEstimate: 150 }), [], null, { billedExtra: 0, billable: 0 });
    expect(out.earned).toBe(250);
    expect(out.totalRev).toBe(250);
    expect(out.revTonu).toBe(250);
    expect(out.referenceRate).toBe(2200);
    expect(out.expDriver).toBe(150);
    expect(out.totalRev - out.revDetention).toBe(out.earned);
  });

  it("cancelled load has $0 earned and $0 totalRev while retaining referenceRate", () => {
    const out = loadLedger(mkLoad({ status: "cancelled", tonuRevenue: 250 }), [], null, { billedExtra: 0, billable: 0 });
    expect(out.earned).toBe(0);
    expect(out.totalRev).toBe(0);
    expect(out.referenceRate).toBe(2200);
    expect(out.totalRev - out.revDetention).toBe(out.earned);
  });

  it("short-paid load matches grossOf to the cent, tracks variance, and respects waived detention", () => {
    const out = loadLedger(
      mkLoad({ quotedRevenue: 1000, actualRevenue: 850.25, fuelSurcharge: 50, layoverPay: 100 }),
      [],
      null,
      { billedExtra: 0, billable: 75, waived: false }
    );
    expect(out.revAgreed).toBe(1000);
    expect(out.revLinehaul).toBe(850.25);
    expect(out.revVariance).toBe(-149.75);
    expect(out.revDetention).toBe(75);
    expect(out.earned).toBe(1000.25);
    expect(out.totalRev).toBe(1075.25);
    expect(Number((out.totalRev - out.revDetention).toFixed(2))).toBe(out.earned);

    const waived = loadLedger(
      mkLoad({ quotedRevenue: 1000, actualRevenue: 850.25, fuelSurcharge: 50, layoverPay: 100 }),
      [],
      null,
      { billedExtra: 0, billable: 75, waived: true }
    );
    expect(waived.revDetention).toBe(0);
    expect(waived.totalRev).toBe(waived.earned);
  });

  it("relayed load sums closed leg estimates + active assignment, uses settled amount when settled, and falls back on legacy null legs", () => {
    const activeAndClosed = loadLedger(
      mkLoad({ assignmentPayEstimate: 300 }),
      [{ status: "closed", kind: "haul", payEstimate: 200 }, { status: "active", kind: "haul", payEstimate: 300 }],
      null,
      { billedExtra: 0, billable: 0 }
    );
    expect(activeAndClosed.expDriver).toBe(500);
    expect(activeAndClosed.driverCostSource).toBe("estimate");

    const settled = loadLedger(
      mkLoad({ assignmentPayEstimate: 300 }),
      [{ status: "closed", kind: "haul", payEstimate: 200 }],
      { id: "s1", number: "ST-9", amount: 515.4 },
      { billedExtra: 0, billable: 0 }
    );
    expect(settled.expDriver).toBe(515.4);
    expect(settled.driverCostSource).toBe("settled");
    expect(settled.driverCostNote).toBe("settled on ST-9");

    const legacyRelay = loadLedger(
      mkLoad({ assignmentPayEstimate: 450 }),
      [{ status: "closed", kind: "haul", payEstimate: null }],
      null,
      { billedExtra: 0, billable: 0 }
    );
    expect(legacyRelay.expDriver).toBe(450);
  });
});
