import { describe, expect, it } from "vitest";
import { summarizeCustomerPay, type CustomerLoadPayRecord } from "@/lib/customer-pay";

describe("Customer payment performance (M3)", () => {
  const dayMs = 86_400_000;
  const now = new Date("2026-11-04T12:00:00Z");

  it("identifies a fast-paying customer with zero overdue invoices", () => {
    const records: CustomerLoadPayRecord[] = [
      {
        brokerName: "Prompt Freight",
        paymentStatus: "paid",
        invoicedAt: new Date(now.getTime() - 40 * dayMs),
        paidAt: new Date(now.getTime() - 20 * dayMs), // paid in 20 days
        invoicedAmount: 1800,
        payTermsDays: 30
      },
      {
        brokerName: "Prompt Freight",
        paymentStatus: "paid",
        invoicedAt: new Date(now.getTime() - 30 * dayMs),
        paidAt: new Date(now.getTime() - 8 * dayMs), // paid in 22 days
        invoicedAmount: 2200,
        payTermsDays: 30
      }
    ];

    const summary = summarizeCustomerPay(records, now);
    const pf = summary.get("prompt freight");
    expect(pf).toBeDefined();
    expect(pf?.avgDaysToPay).toBe(21);
    expect(pf?.overdueCount).toBe(0);
    expect(pf?.overdueBalance).toBe(0);
    expect(pf?.isSlowPay).toBe(false);
  });

  it("identifies a customer with overdue unpaid invoices as slow-pay", () => {
    const records: CustomerLoadPayRecord[] = [
      {
        brokerName: "Late Logistics",
        paymentStatus: "invoiced",
        invoicedAt: new Date(now.getTime() - 45 * dayMs), // 45 days ago, Net 30 -> 15 days overdue
        paidAt: null,
        invoicedAmount: 3400,
        payTermsDays: 30
      }
    ];

    const summary = summarizeCustomerPay(records, now);
    const ll = summary.get("late logistics");
    expect(ll).toBeDefined();
    expect(ll?.overdueCount).toBe(1);
    expect(ll?.overdueBalance).toBe(3400);
    expect(ll?.isSlowPay).toBe(true);
  });

  it("identifies a customer taking over 45 days to pay as slow-pay even without active overdue invoices", () => {
    const records: CustomerLoadPayRecord[] = [
      {
        brokerName: "Slow Payers LLC",
        paymentStatus: "paid",
        invoicedAt: new Date(now.getTime() - 80 * dayMs),
        paidAt: new Date(now.getTime() - 25 * dayMs), // paid in 55 days
        invoicedAmount: 4000,
        payTermsDays: 60
      }
    ];

    const summary = summarizeCustomerPay(records, now);
    const sp = summary.get("slow payers llc");
    expect(sp).toBeDefined();
    expect(sp?.avgDaysToPay).toBe(55);
    expect(sp?.overdueCount).toBe(0);
    expect(sp?.isSlowPay).toBe(true);
  });
});
