import { describe, expect, test } from "vitest";
import { balanceOf, invoiceStateLabel, isShortCode, lineKindOf, projectToLoads } from "../src/lib/invoice-records";

describe("invoice line kinds", () => {
  test("the labels the invoice dialog writes read back as their kinds", () => {
    expect(lineKindOf("Line haul")).toBe("linehaul");
    expect(lineKindOf(" fuel surcharge ")).toBe("fuel_surcharge");
    expect(lineKindOf("Detention")).toBe("detention");
    expect(lineKindOf("Lumper")).toBe("lumper");
    expect(lineKindOf("Layover")).toBe("layover");
    expect(lineKindOf("TONU fee")).toBe("tonu");
    expect(lineKindOf("Stop-off")).toBe("stop_off");
  });
  test("anything a person typed is other", () => {
    expect(lineKindOf("Pallet exchange")).toBe("other");
    expect(lineKindOf("")).toBe("other");
  });
  test("short-pay codes are a closed list", () => {
    expect(isShortCode("quick_pay_fee")).toBe(true);
    expect(isShortCode("whatever")).toBe(false);
    expect(isShortCode(undefined)).toBe(false);
  });
});

describe("an invoice's balance and state", () => {
  test("open owes the total less what came in, never below zero", () => {
    expect(balanceOf({ total: 1000, paidTotal: 400, status: "open" })).toBe(600);
    expect(balanceOf({ total: 1000, paidTotal: 1200, status: "open" })).toBe(0);
    expect(balanceOf({ total: "1000.10", paidTotal: "0.05", status: "open" })).toBe(1000.05);
  });
  test("paid and void owe nothing", () => {
    expect(balanceOf({ total: 1000, paidTotal: 0, status: "paid" })).toBe(0);
    expect(balanceOf({ total: 1000, paidTotal: 0, status: "void" })).toBe(0);
  });
  test("words", () => {
    expect(invoiceStateLabel({ total: 1000, paidTotal: 0, status: "open" })).toBe("Open");
    expect(invoiceStateLabel({ total: 1000, paidTotal: 1, status: "open" })).toBe("Part paid");
    expect(invoiceStateLabel({ total: 1000, paidTotal: 1000, status: "paid" })).toBe("Paid");
    expect(invoiceStateLabel({ total: 1000, paidTotal: 0, status: "void" })).toBe("Void");
  });
});

describe("what each load shows for its invoice (rule A)", () => {
  const issuedAt = new Date("2026-11-01T12:00:00Z");
  const paidAt = new Date("2026-11-20T12:00:00Z");

  test("one load: its invoice total and what came in", () => {
    const [p] = projectToLoads({ number: "INV-1", status: "open", issuedAt, termsDays: 30, paidTotal: 400, paidAt: null, loads: [{ loadId: "a", amount: 1000 }] });
    expect(p).toMatchObject({ loadId: "a", invoiceNumber: "INV-1", invoicedAmount: 1000, paidAmount: 400, paymentStatus: "invoiced", payTermsDays: 30, paidAt: null });
  });

  test("several loads: each shows its own lines, money in is shared first load first, and the loads add up to the invoice", () => {
    const out = projectToLoads({
      number: "INV-9",
      status: "open",
      issuedAt,
      termsDays: 30,
      paidTotal: 4500,
      paidAt: null,
      loads: [
        { loadId: "a", amount: 3000 },
        { loadId: "b", amount: 3000 },
        { loadId: "c", amount: 3000 }
      ]
    });
    expect(out.map((p) => p.invoicedAmount)).toEqual([3000, 3000, 3000]);
    expect(out.map((p) => p.paidAmount)).toEqual([3000, 1500, null]);
    expect(out.every((p) => p.invoiceNumber === "INV-9" && p.paymentStatus === "invoiced")).toBe(true);
  });

  test("an overpayment lands on the last load, so nothing is lost", () => {
    const out = projectToLoads({ number: "INV-2", status: "paid", issuedAt, termsDays: 15, paidTotal: 2100, paidAt, loads: [{ loadId: "a", amount: 1000 }, { loadId: "b", amount: 1000 }] });
    expect(out.map((p) => p.paidAmount)).toEqual([1000, 1100]);
    expect(out.every((p) => p.paymentStatus === "paid" && p.paidAt === paidAt)).toBe(true);
  });

  test("cents are kept exactly", () => {
    const out = projectToLoads({ number: "INV-3", status: "open", issuedAt, termsDays: 0, paidTotal: "100.03", paidAt: null, loads: [{ loadId: "a", amount: "50.01" }, { loadId: "b", amount: "50.02" }] });
    expect(out.map((p) => p.paidAmount)).toEqual([50.01, 50.02]);
  });

  test("a void invoice clears the loads' invoice fields", () => {
    const [p] = projectToLoads({ number: "INV-4", status: "void", issuedAt, termsDays: 30, paidTotal: 0, paidAt: null, loads: [{ loadId: "a", amount: 1000 }] });
    expect(p).toMatchObject({ invoiceNumber: null, invoicedAmount: null, paidAmount: null, paymentStatus: null });
  });
});
