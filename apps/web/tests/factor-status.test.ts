import { describe, expect, test } from "vitest";
import { amountOf, readFactorStatus, statusOf, STATUS_FILE_MAX_ROWS } from "@/lib/factor-status";
import { reconcile, type ReconRow } from "@/lib/factoring-reconciliation";

describe("a factor's status file, read", () => {
  test("columns are found by the names factors use, a byte order mark and quoted cells are fine", () => {
    const text = '﻿Invoice #,Verification,Invoice Status,Funded Amount,Notes\r\nINV-1,FB-0001,Funded,"$1,350.00",\r\n"INV-2",,Charged Back,(300.00),"Customer did not pay, 90 days"\r\n';
    const r = readFactorStatus(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.columns.sort()).toEqual(["amount", "invoice", "reason", "reference", "status"]);
    expect(r.rows.map((x) => [x.line, x.invoice, x.reference, x.status, x.amount, x.reason, x.errors])).toEqual([
      [2, "INV-1", "FB-0001", "funded", 1350, null, []],
      [3, "INV-2", null, "chargeback", 300, "Customer did not pay, 90 days", []]
    ]);
  });

  test("the words factors use for a state", () => {
    expect([statusOf("Advanced"), statusOf("PURCHASED"), statusOf("declined"), statusOf("Non-factorable"), statusOf("Paid by debtor"), statusOf("Collected"), statusOf("Recourse"), statusOf("Under review")]).toEqual([
      "funded",
      "funded",
      "rejected",
      "rejected",
      "paid",
      "paid",
      "chargeback",
      "submitted"
    ]);
    expect(statusOf("maybe")).toBeNull();
    expect(statusOf("")).toBeNull();
  });

  test("amounts in dollars and cents, as factors write them", () => {
    expect([amountOf("1,250.5"), amountOf("$900"), amountOf("(12.34)"), amountOf(""), amountOf("1.234"), amountOf("abc")]).toEqual([1250.5, 900, 12.34, null, "bad", "bad"]);
  });

  test("each line says what is wrong with it; a file with no Status or no Invoice column is refused whole", () => {
    const r = readFactorStatus("Invoice,Status,Amount\n,funded,\nINV-3,maybe,\nINV-4,paid,lots\n");
    expect(r.ok && r.rows.map((x) => x.errors.length)).toEqual([1, 1, 1]);
    expect(readFactorStatus("Invoice,Amount\nINV-1,5")).toMatchObject({ ok: false, error: expect.stringContaining("Status") });
    expect(readFactorStatus("Status,Amount\nfunded,5")).toMatchObject({ ok: false, error: expect.stringContaining("Invoice") });
    expect(readFactorStatus("Invoice,Status\n")).toMatchObject({ ok: false });
    expect(readFactorStatus(`Invoice,Status\n${"I,funded\n".repeat(STATUS_FILE_MAX_ROWS + 1)}`)).toMatchObject({ ok: false, error: expect.stringContaining("Split it") });
  });
});

describe("factoring reconciliation totals", () => {
  const row = (over: Partial<ReconRow>): ReconRow => ({ invoiceId: "i", loadId: "l", number: "N", customer: "C", factoring: "funded", invoiceStatus: "open", total: 1000, advance: null, fee: null, reserve: null, reserveReleased: null, chargeback: null, paidByCustomer: 0, reference: null, updatedAt: null, ...over });

  test("totals are the sum of the rows, in whole cents, each figure counted where it belongs", () => {
    const t = reconcile([
      row({ factoring: "submitted", total: 500.1 }),
      row({ factoring: "requested", total: 499.9 }),
      row({ factoring: "funded", advance: 900, fee: 25, reserve: 100 }),
      row({ factoring: "paid", invoiceStatus: "paid", advance: 1800, fee: 50, reserve: 200, reserveReleased: 150, paidByCustomer: 2000 }),
      row({ factoring: "rejected", advance: 450.55, fee: 12.5, chargeback: 450.55 }),
      row({ factoring: "rejected" })
    ]);
    expect(t).toEqual({
      count: 6,
      withFactor: { count: 2, total: 1000 },
      funded: { count: 3, advances: 3150.55, fees: 87.5 },
      reserveHeld: 100,
      reserveReleased: 150,
      chargebacks: { count: 1, amount: 450.55 },
      paidByCustomers: 2000,
      netFromFactor: 2850
    });
  });

  test("no rows, no money", () => {
    expect(reconcile([])).toMatchObject({ count: 0, reserveHeld: 0, netFromFactor: 0 });
  });
});
