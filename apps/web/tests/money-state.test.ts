import { describe, expect, it } from "vitest";
import { billedOf } from "../src/lib/billed";
import { moneyState } from "../src/lib/money-state";

/** One set of words for where an invoice's money stands, and one figure for what it bills, on every screen. */
describe("what an invoice bills", () => {
  const base = { invoicedAmount: null, status: "completed", quotedRevenue: 1000, fuelSurcharge: 50, tonuRevenue: null };
  it("is the amount stored when it was made", () => {
    expect(billedOf({ ...base, invoicedAmount: 1175.5 })).toBe(1175.5);
  });
  it("is, for an invoice from before amounts were kept, the agreed rate plus the surcharge, or a TONU's fee", () => {
    expect(billedOf(base)).toBe(1050);
    expect(billedOf({ ...base, status: "tonu", tonuRevenue: 150 })).toBe(150);
    expect(billedOf({ ...base, status: "tonu", tonuRevenue: null })).toBe(0);
  });
  it("is whole cents", () => {
    expect(billedOf({ ...base, quotedRevenue: 100.1, fuelSurcharge: 0.2 })).toBe(100.3);
  });
});

describe("where the money stands, in words", () => {
  const out = { paymentStatus: "invoiced", billed: 1000, received: null as number | null };
  it("says an invoice that is out and not late is out and waiting", () => {
    expect(moneyState(out)).toMatchObject({ key: "out", label: "Out and waiting", tone: "warn", detail: null, balance: 1000 });
  });
  it("says how late one is", () => {
    expect(moneyState({ ...out, overdueDays: 1 })).toMatchObject({ key: "overdue", label: "Overdue", tone: "bad", detail: "1 day overdue" });
    expect(moneyState({ ...out, overdueDays: 12 }).detail).toBe("12 days overdue");
    expect(moneyState({ ...out, overdueDays: 0 }).key).toBe("out");
  });
  it("says what is in and what is to come on a part payment", () => {
    expect(moneyState({ ...out, received: 600 })).toMatchObject({ key: "part", label: "Part paid", detail: "$600.00 in, $400.00 to come", balance: 400 });
    expect(moneyState({ ...out, received: 600, overdueDays: 3 })).toMatchObject({ key: "part_overdue", tone: "bad", detail: "$600.00 in, $400.00 to come · 3 days overdue" });
  });
  it("says paid, paid short, over, and closed short with what was written off and why", () => {
    const paid = { paymentStatus: "paid", billed: 1000 };
    expect(moneyState({ ...paid, received: 1000 })).toMatchObject({ key: "paid", label: "Paid", tone: "ok", balance: 0 });
    expect(moneyState({ ...paid, received: 940 })).toMatchObject({ key: "paid_short", label: "Paid short", detail: "$60.00 short of $1,000.00" });
    expect(moneyState({ ...paid, received: 1020 })).toMatchObject({ key: "paid_over", detail: "$20.00 over $1,000.00" });
    expect(moneyState({ ...paid, received: 940, writeOffAmount: 60, writeOffReason: "Lumper deducted" })).toMatchObject({ key: "closed_short", label: "Closed short", detail: "$60.00 written off: Lumper deducted" });
  });
  it("says a load not invoiced is not invoiced yet", () => {
    expect(moneyState({ paymentStatus: null, billed: 0, received: null })).toMatchObject({ key: "not_invoiced", label: "Not invoiced yet" });
  });
});
