import { describe, expect, it } from "vitest";
import { defaultInvoiceNumber, invoiceReadiness, reminderText, validateInvoice, type InvoiceForm, type ReadinessLoad } from "../src/lib/invoicing";

const ready = (over: Partial<ReadinessLoad> = {}): ReadinessLoad => ({ status: "completed", brokerName: "Acme", loadNumber: "AF-1", brokerEmail: "ap@acme.example", brokerPhone: null, closedWithoutPod: false, podNote: "Signed BOL", quotedRevenue: 1000, ...over });
const form = (over: Partial<InvoiceForm> = {}): InvoiceForm => ({ number: "INV-AF-1", terms: "", detention: false, lumper: "", layover: "", otherLabel: "", other: "", ...over });
const ctx = { rate: 1000, surcharge: 50, detention: 75, defaultTerms: 30 };

describe("invoiceReadiness", () => {
  it("a delivered load with a broker, a number, a rate and a contact has nothing in the way", () => {
    expect(invoiceReadiness(ready())).toEqual({ blockers: [], cautions: [] });
  });

  it("blocks what would make an invoice nobody can pay", () => {
    const r = invoiceReadiness(ready({ status: "in_progress", brokerName: " ", loadNumber: null, quotedRevenue: 0 }));
    expect(r.blockers).toHaveLength(4);
  });

  it("only cautions about contact and proof of delivery", () => {
    const none = invoiceReadiness(ready({ brokerEmail: null, brokerPhone: null, podNote: null }));
    expect(none.blockers).toEqual([]);
    expect(none.cautions).toHaveLength(2);
    expect(invoiceReadiness(ready({ closedWithoutPod: true })).cautions.join(" ")).toMatch(/without proof of delivery/);
    // A phone is enough of a contact.
    expect(invoiceReadiness(ready({ brokerEmail: null, brokerPhone: "555-0142" })).cautions).toEqual([]);
  });
});

describe("validateInvoice", () => {
  it("the lines add up to the total, with the surcharge and each extra on its own line", () => {
    const out = validateInvoice(form({ detention: true, lumper: "40", layover: "100.50", otherLabel: "Scale ticket", other: "12" }), ctx);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.lines.map((l) => l.label)).toEqual(["Line haul", "Fuel surcharge", "Detention", "Lumper", "Layover", "Scale ticket"]);
    const sum = out.value.lines.reduce((s, l) => s + l.amount, 0);
    expect(out.value.total).toBeCloseTo(sum, 2);
    expect(out.value.total).toBeCloseTo(1000 + 50 + 75 + 40 + 100.5 + 12, 2);
    expect(out.value.terms).toBe(30);
  });

  it("no surcharge and no extras is just the line haul; terms use the typed days over the default", () => {
    const out = validateInvoice(form({ terms: "45" }), { ...ctx, surcharge: 0 });
    expect(out.ok && out.value).toMatchObject({ terms: 45, total: 1000, lines: [{ label: "Line haul", amount: 1000 }] });
  });

  it("detention is only added when it is ticked and there is some to bill", () => {
    const off = validateInvoice(form({ detention: false }), ctx);
    expect(off.ok && off.value.lines.some((l) => l.label === "Detention")).toBe(false);
    const nothing = validateInvoice(form({ detention: true }), { ...ctx, detention: 0 });
    expect(nothing.ok && nothing.value.lines.some((l) => l.label === "Detention")).toBe(false);
  });

  it("names every bad field", () => {
    const out = validateInvoice(form({ number: "", terms: "200", lumper: "-3", layover: "1.234", other: "20", otherLabel: "" }), ctx);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["layover", "lumper", "number", "otherLabel", "terms"]);
  });

  it("the default number follows the load number, and falls back to the load's id", () => {
    expect(defaultInvoiceNumber("AF-1", "abcdef123456")).toBe("INV-AF-1");
    expect(defaultInvoiceNumber(null, "abcdef123456")).toBe("INV-123456");
  });
});

describe("reminderText", () => {
  const now = new Date("2026-11-20T18:00:00Z");
  const base = { broker: "Acme", invoiceNumber: "INV-AF-1", loadNumber: "AF-1", poNumber: "PO-9", amount: 1250.5, sent: new Date("2026-10-01T18:00:00Z"), due: new Date("2026-10-31T18:00:00Z"), now, origin: "Dallas, TX", destination: "Memphis, TN" };

  it("has every number the accounts team will ask for", () => {
    const text = reminderText(base);
    expect(text).toContain("Hello Acme accounts team,");
    expect(text).toContain("INV-AF-1");
    expect(text).toContain("$1,250.50");
    expect(text).toContain("20 days ago");
    expect(text).toContain("Load: AF-1   PO: PO-9");
    expect(text).toContain("Dallas, TX to Memphis, TN");
  });

  it("copes with a missing broker, PO or route", () => {
    const text = reminderText({ ...base, broker: null, poNumber: null, origin: null, destination: null });
    expect(text.startsWith("Hello,")).toBe(true);
    expect(text).toContain("Load: AF-1\n");
    expect(text).toContain("? to ?");
  });
});
