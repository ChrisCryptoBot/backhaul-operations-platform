import { describe, expect, it } from "vitest";
import { ACCOUNT_KEYS, checkAccountsForm, resolveAccounts, unmappedOf, unmappedSentence } from "@/lib/accounting-map";
import { buildJournal, factoringWindow, journalCsv, releasedAt, writeOffAccount, type JEntry, type JInvoice, type JSettlement } from "@/lib/journal";
import { FEE_SHORT_CODES, isFeeShortCode, LINE_KINDS, SHORT_CODES } from "@/lib/invoice-records";

/** The accounts (rules D and E) and the double-entry journal (docs/MONEY_PLAN.md, Wave 3), pure and in cents. */
const ZONE = "America/Chicago";
const at = (iso: string) => new Date(iso);
const noFactoring = { fundedAt: null, advance: null, fee: null, reserveReleased: null, chargeback: null, reserveReleasedAt: null, chargedBackAt: null, updatedAt: null };
const inv = (o: Partial<JInvoice> & { id: string }): JInvoice => ({ number: o.id.toUpperCase(), kind: "invoice", billTo: "Acme", issuedAt: at("2026-11-02T18:00:00Z"), total: 100000, paidAt: null, writeOff: null, writeOffCode: null, lines: [{ kind: "linehaul", amount: 100000 }], payments: [], factoring: noFactoring, ...o });
const balanced = (e: JEntry) => e.lines.reduce((s, l) => s + l.debit, 0) === e.lines.reduce((s, l) => s + l.credit, 0);
const net = (entries: JEntry[], key: string) => entries.flatMap((e) => e.lines).filter((l) => l.key === key).reduce((s, l) => s + l.debit - l.credit, 0);

describe("the accounts", () => {
  it("cover every invoice line kind, with rule D's defaults, and leave Other and Credit for the fleet to choose", () => {
    const map = resolveAccounts([]);
    for (const k of LINE_KINDS) expect(ACCOUNT_KEYS.some((a) => a.key === k), k).toBe(true);
    expect([map.linehaul?.account, map.fuel_surcharge?.account, map.detention?.account, map.lumper?.account, map.layover?.account, map.stop_off?.account, map.tonu?.account]).toEqual(["Freight Income", "Fuel Surcharge Income", "Accessorial Income", "Accessorial Income", "Accessorial Income", "Accessorial Income", "Accessorial Income"]);
    expect([map.other, map.credit]).toEqual([null, null]);
    expect(map.driver_pay_1099).toEqual({ account: "Driver Pay", number: null, fallback: true });
  });

  it("take the fleet's own name over the default, and name what is unmapped (an unknown kind too)", () => {
    const map = resolveAccounts([{ key: "linehaul", account: " Linehaul Revenue ", number: "4000" }, { key: "other", account: "Misc Income", number: null }, { key: "nonsense", account: "x", number: null }]);
    expect(map.linehaul).toEqual({ account: "Linehaul Revenue", number: "4000", fallback: false });
    expect(map.other?.account).toBe("Misc Income");
    expect(unmappedOf(["linehaul", "credit", "other", "mystery_kind"], map)).toEqual(["credit", "mystery_kind"]);
    expect(unmappedSentence(["credit"])).toContain("Credits and allowances");
  });

  it("check the form: no colon (QuickBooks sub-accounts), a sensible number, and a number needs a name", () => {
    expect(checkAccountsForm({ linehaul: { account: "Freight: Linehaul", number: "" } })).toMatchObject({ ok: false, errors: { "linehaul.account": expect.any(String) } });
    expect(checkAccountsForm({ fuel: { account: "", number: "6100" } })).toMatchObject({ ok: false, errors: { "fuel.account": expect.any(String) } });
    expect(checkAccountsForm({ fuel: { account: "Fuel", number: "61 00" } })).toMatchObject({ ok: false, errors: { "fuel.number": expect.any(String) } });
    expect(checkAccountsForm({ fuel: { account: " Diesel ", number: "6100" }, other: { account: "", number: "" } })).toEqual({ ok: true, rows: [{ key: "other", account: null, number: null }, { key: "fuel", account: "Diesel", number: "6100" }] });
  });
});

describe("the journal", () => {
  it("books an invoice by line kind, a payment as cash, and receivables add up to the invoice", () => {
    const out = buildJournal({ invoices: [inv({ id: "a", total: 125000, lines: [{ kind: "linehaul", amount: 100000 }, { kind: "fuel_surcharge", amount: 15000 }, { kind: "detention", amount: 10000 }], payments: [{ id: "p1", amount: 125000, paidAt: at("2026-11-20T18:00:00Z"), source: "desk" }] })], settlements: [], fuel: [] }, { zone: ZONE });
    expect(out.problems).toEqual([]);
    expect(out.entries.map((e) => [e.day, e.source])).toEqual([["2026-11-02", "invoice"], ["2026-11-20", "payment"]]);
    expect(out.entries[0]!.lines).toEqual([{ key: "accounts_receivable", debit: 125000, credit: 0 }, { key: "linehaul", debit: 0, credit: 100000 }, { key: "fuel_surcharge", debit: 0, credit: 15000 }, { key: "detention", debit: 0, credit: 10000 }]);
    expect(net(out.entries, "accounts_receivable")).toBe(0);
    expect(out.check).toEqual({ invoiced: 125000, credited: 0, arFromInvoices: 125000, received: 125000, cashFromPayments: 125000 });
    expect(out.entries.every(balanced)).toBe(true);
  });

  it("books a credit memo once: the memo takes receivables down, and applying it to the invoice is not booked again", () => {
    const memo = inv({ id: "m", kind: "credit_memo", total: -20000, lines: [{ kind: "credit", amount: -20000 }] });
    const original = inv({ id: "a", payments: [{ id: "c1", amount: 20000, paidAt: at("2026-11-05T18:00:00Z"), source: "credit" }, { id: "p1", amount: 80000, paidAt: at("2026-11-20T18:00:00Z"), source: "desk" }] });
    const out = buildJournal({ invoices: [original, memo], settlements: [], fuel: [] }, { zone: ZONE });
    expect(out.entries.map((e) => e.source).sort()).toEqual(["credit_memo", "invoice", "payment"]);
    expect(out.entries.find((e) => e.source === "credit_memo")!.lines).toEqual([{ key: "accounts_receivable", debit: 0, credit: 20000 }, { key: "credit", debit: 20000, credit: 0 }]);
    expect(net(out.entries, "accounts_receivable")).toBe(0);
    expect(out.check).toMatchObject({ invoiced: 100000, credited: -20000, arFromInvoices: 80000, cashFromPayments: 80000 });
  });

  it("books a short pay written off to its expense", () => {
    const out = buildJournal({ invoices: [inv({ id: "a", paidAt: at("2026-11-20T18:00:00Z"), writeOff: 5000, payments: [{ id: "p1", amount: 95000, paidAt: at("2026-11-20T18:00:00Z"), source: "desk" }] })], settlements: [], fuel: [] }, { zone: ZONE });
    expect(net(out.entries, "write_off")).toBe(5000);
    expect(net(out.entries, "accounts_receivable")).toBe(0);
  });

  it("books a factored invoice: advance and reserve at funding, the fee out of the reserve, the release when the customer pays; the customer's payment to the factor is not the fleet's cash", () => {
    const f = inv({
      id: "f",
      paidAt: at("2026-12-01T18:00:00Z"),
      payments: [{ id: "pf", amount: 100000, paidAt: at("2026-12-01T18:00:00Z"), source: "factor" }],
      factoring: { fundedAt: at("2026-11-03T18:00:00Z"), advance: 90000, fee: 2500, reserveReleased: 7500, chargeback: null, reserveReleasedAt: at("2026-12-01T18:00:00Z"), chargedBackAt: null, updatedAt: at("2026-12-01T18:00:00Z") }
    });
    const out = buildJournal({ invoices: [f], settlements: [], fuel: [] }, { zone: ZONE });
    expect(out.entries.map((e) => e.source)).toEqual(["invoice", "factoring_fee", "factoring_funded", "factoring_release"]);
    expect(net(out.entries, "cash")).toBe(97500);
    expect(net(out.entries, "factoring_fee")).toBe(2500);
    expect(net(out.entries, "factor_reserve")).toBe(0);
    expect(net(out.entries, "accounts_receivable")).toBe(0);
    expect(out.check.cashFromPayments).toBe(0);
    expect(out.check.received).toBe(100000);
  });

  it("books a chargeback as the funding undone: the invoice is the fleet's again, and a payment after it is the fleet's cash", () => {
    const c = inv({
      id: "c",
      payments: [{ id: "late", amount: 100000, paidAt: at("2027-02-10T18:00:00Z"), source: "desk" }],
      factoring: { fundedAt: at("2026-11-03T18:00:00Z"), advance: null, fee: null, reserveReleased: null, chargeback: 90000, reserveReleasedAt: null, chargedBackAt: at("2027-02-01T18:00:00Z"), updatedAt: at("2027-02-01T18:00:00Z") }
    });
    const out = buildJournal({ invoices: [c], settlements: [], fuel: [] }, { zone: ZONE });
    expect(out.entries.map((e) => e.source)).toEqual(["invoice", "factoring_funded", "factoring_chargeback", "payment"]);
    expect([net(out.entries, "cash"), net(out.entries, "factor_reserve"), net(out.entries, "accounts_receivable")]).toEqual([100000, 0, 0]);
  });

  it("gap 6, rule 2: a quick-pay or factor fee taken short is Factoring Fees, any other short pay stays Short pays written off; gross is never touched", () => {
    expect(FEE_SHORT_CODES).toEqual(["quick_pay_fee", "factor_fee"]);
    expect(SHORT_CODES.filter(isFeeShortCode)).toEqual(["quick_pay_fee", "factor_fee"]);
    expect([writeOffAccount("quick_pay_fee"), writeOffAccount("factor_fee"), writeOffAccount("customer_deduction"), writeOffAccount("other"), writeOffAccount(null), writeOffAccount("nonsense")]).toEqual(["factoring_fee", "factoring_fee", "write_off", "write_off", "write_off", "write_off"]);
    const paid = (id: string, code: string | null) => inv({ id, paidAt: at("2026-11-20T18:00:00Z"), writeOff: 2000, writeOffCode: code, payments: [{ id: `p${id}`, amount: 98000, paidAt: at("2026-11-20T18:00:00Z"), source: "desk" }] });
    const out = buildJournal({ invoices: [paid("q", "quick_pay_fee"), paid("f", "factor_fee"), paid("d", "damage_claim"), paid("n", null)], settlements: [], fuel: [] }, { zone: ZONE });
    expect(net(out.entries, "factoring_fee")).toBe(4000);
    expect(net(out.entries, "write_off")).toBe(4000);
    expect(net(out.entries, "accounts_receivable")).toBe(0);
    // The entry keeps its id (write_off:<invoice>) so an export already taken lines up; only the account and the memo say what it is.
    const q = out.entries.find((e) => e.id === "write_off:q")!;
    expect(q.memo).toBe("Quick-pay fee taken short on Q");
    expect(q.lines).toEqual([{ key: "factoring_fee", debit: 2000, credit: 0 }, { key: "accounts_receivable", debit: 0, credit: 2000 }]);
    expect(out.entries.find((e) => e.id === "write_off:f")!.memo).toBe("Factor fee taken short on F");
    expect(out.entries.find((e) => e.id === "write_off:d")!.memo).toBe("Short pay written off on D");
  });

  it("dates the release and the chargeback by their own stored days, not by the last factoring change", () => {
    const f = inv({
      id: "r",
      paidAt: at("2026-12-01T18:00:00Z"),
      payments: [{ id: "pr", amount: 100000, paidAt: at("2026-12-01T18:00:00Z"), source: "factor" }],
      // A later factoring change (a status re-sent, say) must not move the release.
      factoring: { fundedAt: at("2026-11-03T18:00:00Z"), advance: 90000, fee: 2500, reserveReleased: 7500, chargeback: null, reserveReleasedAt: at("2026-12-04T18:00:00Z"), chargedBackAt: null, updatedAt: at("2027-01-15T18:00:00Z") }
    });
    expect(releasedAt(f)).toEqual(at("2026-12-04T18:00:00Z"));
    expect(buildJournal({ invoices: [f], settlements: [], fuel: [] }, { zone: ZONE }).entries.find((e) => e.source === "factoring_release")!.day).toBe("2026-12-04");
    // A record from before the column falls back exactly as before: the day it closed, the last factoring change, the funding.
    expect(releasedAt({ ...f, factoring: { ...f.factoring, reserveReleasedAt: null } })).toEqual(at("2026-12-01T18:00:00Z"));
    expect(releasedAt({ paidAt: null, factoring: { ...f.factoring, reserveReleasedAt: null } })).toEqual(at("2027-01-15T18:00:00Z"));
    expect(releasedAt({ paidAt: null, factoring: { ...f.factoring, reserveReleasedAt: null, updatedAt: null } })).toEqual(at("2026-11-03T18:00:00Z"));

    const charged = { ...noFactoring, fundedAt: at("2026-11-03T18:00:00Z"), chargeback: 90000, chargedBackAt: at("2027-02-01T18:00:00Z"), updatedAt: at("2027-03-01T18:00:00Z") };
    const w = factoringWindow(charged);
    expect(w.chargedAt).toEqual(at("2027-02-01T18:00:00Z"));
    expect([w.owns(at("2027-01-31T18:00:00Z")), w.owns(at("2027-02-15T18:00:00Z"))]).toEqual([true, false]);
    expect(factoringWindow({ ...charged, chargedBackAt: null }).chargedAt).toEqual(at("2027-03-01T18:00:00Z"));
    expect(factoringWindow({ ...charged, chargeback: null }).chargedAt).toBeNull();
  });

  it("refuses records it cannot book: lines that do not add up, or a funding with no advance", () => {
    const out = buildJournal({ invoices: [inv({ id: "x", total: 100000, lines: [{ kind: "linehaul", amount: 99000 }] }), inv({ id: "y", factoring: { ...noFactoring, fundedAt: at("2026-11-03T18:00:00Z") } })], settlements: [], fuel: [] }, { zone: ZONE });
    expect(out.problems).toEqual([expect.stringContaining("X: its lines come to 990.00, not the 1000.00"), expect.stringContaining("Y: the factor funded it but no advance")]);
  });

  it("books a 1099 statement as a bill (rule E), leaves a W-2 one to payroll, and says when a driver is not marked", () => {
    const s = (o: Partial<JSettlement> & { id: string }): JSettlement => ({ number: o.id.toUpperCase(), driver: "Sam", workerType: "contractor", finalizedAt: at("2026-11-07T18:00:00Z"), total: 150000, rows: [{ kind: "load", amount: 180000 }, { kind: "fuel", amount: -30000 }], paidAt: at("2026-11-10T18:00:00Z"), ...o });
    const out = buildJournal({ invoices: [], settlements: [s({ id: "s1" }), s({ id: "s2", workerType: "employee" }), s({ id: "s3", workerType: null })], fuel: [{ id: "t1", postedAt: at("2026-11-04T18:00:00Z"), amount: 30000, location: "Love's, Amarillo" }] }, { zone: ZONE });
    expect(out.entries.map((e) => e.source)).toEqual(["fuel", "settlement", "settlement_paid"]);
    expect(out.entries.find((e) => e.source === "settlement")!.lines).toEqual([{ key: "driver_pay_1099", debit: 180000, credit: 0 }, { key: "fuel", debit: 0, credit: 30000 }, { key: "accounts_payable", debit: 0, credit: 150000 }]);
    // The fuel the driver bore nets out of Fuel; the fleet's own cost is the driver's pay.
    expect([net(out.entries, "fuel"), net(out.entries, "accounts_payable"), net(out.entries, "cash")]).toEqual([0, 0, -150000]);
    expect(out.notes).toEqual([expect.stringContaining("1 statement is for company drivers (W-2)"), expect.stringContaining("S3")]);
  });

  it("keeps only the days asked for, in the fleet's own zone, and names the accounts in the CSV", () => {
    // 2026-11-03 03:00 UTC is still the 2nd in Chicago.
    const out = buildJournal({ invoices: [inv({ id: "a", issuedAt: at("2026-11-03T03:00:00Z"), payments: [{ id: "p1", amount: 100000, paidAt: at("2026-11-20T18:00:00Z"), source: "desk" }] })], settlements: [], fuel: [] }, { zone: ZONE, from: "2026-11-01", to: "2026-11-02" });
    expect(out.entries.map((e) => [e.day, e.source])).toEqual([["2026-11-02", "invoice"]]);
    expect(out.keys.sort()).toEqual(["accounts_receivable", "linehaul"]);
    const csv = journalCsv(out.entries, resolveAccounts([{ key: "linehaul", account: "Linehaul Revenue", number: "4000" }]));
    expect(csv.replace(/^﻿/, "").split("\r\n").slice(0, 3)).toEqual([
      "Date,Journal entry,Account,Account number,Debit,Credit,Memo,Source,Reference",
      '2026-11-02,invoice:a,Accounts Receivable,,1000.00,,"Invoice A, Acme",invoice,A',
      '2026-11-02,invoice:a,Linehaul Revenue,4000,,1000.00,"Invoice A, Acme",invoice,A'
    ]);
  });
});
