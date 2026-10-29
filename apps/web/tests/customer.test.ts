import { describe, expect, it } from "vitest";
import { BLANK_CUSTOMER, CUSTOMER_KINDS, kindLabel, toCustomerValues, validateCustomer } from "../src/lib/customer";
import { customerScorecard, type CustomerLoad } from "../src/lib/customer-scorecard";

describe("a customer record", () => {
  const good = { ...BLANK_CUSTOMER, name: "  Acme   Freight ", kind: "broker", mcNumber: "MC-123456", contactEmail: "ap@acme.example", contactPhone: "555-0142", defaultPayTermsDays: "30", notes: " pays slow in December " };

  it("tidies a good form: the name's spaces, the MC as digits, blanks as none", () => {
    const out = validateCustomer(good);
    if (!out.ok) throw new Error(JSON.stringify(out.errors));
    expect(out.value).toEqual({ name: "Acme Freight", kind: "broker", mcNumber: "123456", contactName: null, contactEmail: "ap@acme.example", contactPhone: "555-0142", defaultPayTermsDays: 30, notes: "pays slow in December" });
  });

  it("needs only a name and a kind: a shipper or direct customer has no MC and that is never a problem", () => {
    const out = validateCustomer({ ...BLANK_CUSTOMER, name: "Sample Shipper Dallas", kind: "shipper" });
    expect(out).toMatchObject({ ok: true, value: { kind: "shipper", mcNumber: null, defaultPayTermsDays: null } });
  });

  it("names each wrong field", () => {
    const out = validateCustomer({ name: "x", kind: "friend", mcNumber: "12", contactName: "n".repeat(61), contactEmail: "nope", contactPhone: "abc", defaultPayTermsDays: "30.5", notes: "z".repeat(1001) });
    if (out.ok) throw new Error("expected errors");
    expect(Object.keys(out.errors).sort()).toEqual(["contactEmail", "contactName", "contactPhone", "defaultPayTermsDays", "kind", "mcNumber", "name", "notes"]);
    expect(validateCustomer({ ...good, defaultPayTermsDays: "121" }).ok).toBe(false);
    expect(validateCustomer({ ...good, defaultPayTermsDays: "0" })).toMatchObject({ ok: true, value: { defaultPayTermsDays: 0 } }); // pays on receipt
  });

  it("has three kinds, one of them the shipper or direct customer, and shows a stored record as the form's text", () => {
    expect(CUSTOMER_KINDS.map((k) => k.key)).toEqual(["broker", "shipper", "other"]);
    expect(kindLabel("shipper")).toBe("Shipper or direct customer");
    expect(kindLabel(null)).toBe("");
    expect(toCustomerValues({ name: "A", kind: "other", mcNumber: null, contactName: null, contactEmail: null, contactPhone: null, defaultPayTermsDays: 45, notes: null })).toMatchObject({ mcNumber: "", defaultPayTermsDays: "45", notes: "" });
  });
});

describe("how a customer has paid", () => {
  const NOW = new Date("2026-10-30T15:00:00Z");
  const day = (n: number) => new Date(NOW.getTime() + n * 86_400_000);
  const inv = (over: Partial<CustomerLoad>): CustomerLoad => ({ paymentStatus: "paid", invoicedAt: day(-40), paidAt: day(-20), payTermsDays: 30, invoicedAmount: 1000, paidAmount: 1000, ...over });

  it("counts a payment inside the terms, the due day included, and one after", () => {
    const card = customerScorecard([inv({}), inv({ invoicedAt: day(-60), paidAt: day(-30) }), inv({ invoicedAt: day(-60), paidAt: day(-29) })], NOW, 30);
    expect(card).toMatchObject({ paid: 3, paidWithinTerms: 2 });
    expect(card.paidOnTimeRate).toBeCloseTo(2 / 3, 6);
  });

  it("falls back to the terms it is given when a load names none", () => {
    expect(customerScorecard([inv({ payTermsDays: null, invoicedAt: day(-50), paidAt: day(-10) })], NOW, 45).paidWithinTerms).toBe(1); // 40 days against 45
    expect(customerScorecard([inv({ payTermsDays: null, invoicedAt: day(-50), paidAt: day(-10) })], NOW, 30).paidWithinTerms).toBe(0);
  });

  it("counts a payment below the invoice, and by how much", () => {
    const card = customerScorecard([inv({ paidAmount: 940 }), inv({ paidAmount: 1000 }), inv({ paidAmount: 1010 })], NOW, 30);
    expect(card.shortPaid).toEqual({ loads: 1, dollars: 60 });
  });

  it("adds up what is still out, how much of it is late, and the oldest", () => {
    const card = customerScorecard([inv({ paymentStatus: "invoiced", paidAt: null, paidAmount: null, invoicedAt: day(-45), invoicedAmount: 700 }), inv({ paymentStatus: "invoiced", paidAt: null, paidAmount: null, invoicedAt: day(-10), invoicedAmount: 300.5 })], NOW, 30);
    expect(card.outstanding).toEqual({ count: 2, total: 1000.5, overdue: 1, oldestDaysOverdue: 15 });
  });

  it("has no rate and nothing out for a customer with no invoices", () => {
    expect(customerScorecard([], NOW, 30)).toEqual({ paid: 0, paidWithinTerms: 0, paidOnTimeRate: null, shortPaid: { loads: 0, dollars: 0 }, outstanding: { count: 0, total: 0, overdue: 0, oldestDaysOverdue: null } });
  });
});
