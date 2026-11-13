import { describe, expect, it } from "vitest";
import { decimalCents, expectedProjection, factorProblem, MONEY_CHECKS, MONEY_EXAMPLES, moneyIntegrity, type MoneyInput, type MoneyInvoice, type MoneyLoad } from "@/lib/money-integrity";
import { projectToLoads } from "@/lib/invoice-records";

/** Money integrity (docs/MONEY_PLAN.md, Wave 6 step 2): pure, whole cents, one check per rule, "not checked" never a pass. */
const T = new Date("2026-11-10T18:00:00Z");
const load = (o: Partial<MoneyLoad> & { loadId: string }): MoneyLoad => ({ label: o.loadId.toUpperCase(), status: "completed", deleted: false, factoringStatus: "none", invoicedCents: 100000, paidCents: null, paymentStatus: "invoiced", ...o });
const noF: MoneyInvoice["factoring"] = { status: "none", fundedAt: null, advanceCents: null, feeCents: null, reserveCents: null, releasedCents: null, chargebackCents: null, releasedAt: null, chargedBackAt: null };
const inv = (o: Partial<MoneyInvoice> & { id: string }): MoneyInvoice => ({
  number: o.id.toUpperCase(),
  kind: "invoice",
  status: "open",
  createdAt: T.getTime(),
  voidedAt: null,
  issuedAt: T,
  termsDays: 30,
  paidAt: null,
  totalCents: 100000,
  paidTotalCents: 0,
  writeOffCents: null,
  paymentsCents: 0,
  lines: [{ loadId: `l-${o.id}`, cents: 100000 }],
  loads: [load({ loadId: `l-${o.id}` })],
  factoring: noF,
  inQbo: true,
  ...o
});
const base: MoneyInput = { invoices: [], statements: [], fuelLines: [], qbo: { connected: true, lastSyncAt: T.getTime() + 1 }, truncated: false };
const run = (o: Partial<MoneyInput>) => moneyIntegrity({ ...base, ...o });
const check = (o: Partial<MoneyInput>, key: string) => run(o).checks.find((c) => c.key === key)!;

describe("money integrity", () => {
  it("has the seven checks, in order, each with a label and a reason", () => {
    expect(MONEY_CHECKS.map((c) => c.key)).toEqual(["invoice_lines_total", "payments_over_total", "load_projection", "settled_load_voided", "fuel_deducted_twice", "qbo_mismatch", "factor_mismatch"]);
    expect(run({}).checks.map((c) => c.key)).toEqual(MONEY_CHECKS.map((c) => c.key));
    expect(run({}).checks.every((c) => c.label && c.why)).toBe(true);
  });

  it("reads Decimal text as exact cents and refuses anything else", () => {
    expect([decimalCents("1234.50"), decimalCents("-0.01"), decimalCents("0.00"), decimalCents(null)]).toEqual([123450, -1, 0, null]);
    expect(() => decimalCents("1.234")).toThrow();
  });

  it("invoice_lines_total: a total that is not its lines fails, a void one is not checked, a credit memo is", () => {
    const c = check({ invoices: [inv({ id: "a" }), inv({ id: "b", totalCents: 99999 }), inv({ id: "v", status: "void", totalCents: 1 }), inv({ id: "m", kind: "credit_memo", totalCents: -20000, lines: [{ loadId: null, cents: -20000 }], loads: [] })] }, "invoice_lines_total");
    expect([c.checked, c.passed, c.failed]).toEqual([3, 2, 1]);
    expect(c.examples).toEqual([{ id: "b", label: "B", detail: "lines $1,000.00, total $999.99", href: "/invoices/b" }]);
  });

  it("payments_over_total: over the total (payments, credits, write-off) or a paid total that is not its rows", () => {
    const ok = inv({ id: "ok", status: "paid", paidTotalCents: 98000, paymentsCents: 98000, writeOffCents: 2000, loads: [load({ loadId: "l-ok", paidCents: 98000, paymentStatus: "paid" })] });
    const over = inv({ id: "over", paidTotalCents: 90000, paymentsCents: 90000, writeOffCents: 10001 });
    const drift = inv({ id: "drift", paidTotalCents: 50000, paymentsCents: 40000 });
    const c = check({ invoices: [ok, over, drift] }, "payments_over_total");
    expect([c.checked, c.passed, c.failed]).toEqual([3, 1, 2]);
    expect(c.examples.map((e) => e.detail)).toEqual(["received and credited $900.00 and $100.01 written off on $1,000.00", "paid total $500.00, payment rows $400.00"]);
  });

  it("load_projection: rule A, the same as projectToLoads; a load that drifted is named", () => {
    const two = inv({ id: "m", totalCents: 150000, paidTotalCents: 120000, paymentsCents: 120000, lines: [{ loadId: "x", cents: 100000 }, { loadId: "y", cents: 50000 }], loads: [load({ loadId: "x", invoicedCents: 100000, paidCents: 100000 }), load({ loadId: "y", invoicedCents: 50000, paidCents: 20000 })] });
    const want = expectedProjection(two);
    const lib = projectToLoads({ number: "M", status: "open", issuedAt: T, termsDays: 30, paidTotal: "1200.00", paidAt: null, loads: [{ loadId: "x", amount: "1000.00" }, { loadId: "y", amount: "500.00" }] });
    expect([...want.entries()]).toEqual(lib.map((p) => [p.loadId, { invoicedCents: Math.round(p.invoicedAmount! * 100), paidCents: Math.round(p.paidAmount! * 100), paymentStatus: p.paymentStatus }]));
    expect(check({ invoices: [two] }, "load_projection")).toMatchObject({ checked: 1, failed: 0 });
    const bad = { ...two, id: "n", loads: [load({ loadId: "x", invoicedCents: 100000, paidCents: 100000 }), load({ loadId: "y", invoicedCents: 50000, paidCents: 50000 })] };
    expect(check({ invoices: [two, bad] }, "load_projection")).toMatchObject({ checked: 2, failed: 1, examples: [{ label: "M", detail: "load Y received $500.00, its share $200.00" }] });
    // A deleted load is not compared here (settled_load_voided names it); a load not invoiced while its invoice is open is.
    expect(check({ invoices: [inv({ id: "d", loads: [load({ loadId: "l-d", deleted: true, invoicedCents: null })] })] }, "load_projection").failed).toBe(0);
    expect(check({ invoices: [inv({ id: "s", loads: [load({ loadId: "l-s", paymentStatus: null })] })] }, "load_projection").examples[0]!.detail).toBe("load L-S says not invoiced, the invoice invoiced");
  });

  it("settled_load_voided: a load on a final statement or a paid invoice that is cancelled or deleted", () => {
    const c = check(
      {
        statements: [{ id: "s1", number: "ST-1", loads: [{ loadId: "a", label: "A", status: "completed", deleted: false }, { loadId: "b", label: "B", status: "cancelled", deleted: false }] }],
        invoices: [inv({ id: "p", status: "paid", paidTotalCents: 100000, paymentsCents: 100000, loads: [load({ loadId: "c", deleted: true })] }), inv({ id: "o", loads: [load({ loadId: "d", status: "cancelled" })] })]
      },
      "settled_load_voided"
    );
    expect([c.checked, c.failed]).toEqual([3, 2]);
    expect(c.examples.map((e) => [e.label, e.detail, e.href])).toEqual([["B", "on statement ST-1, and cancelled", "/settlements/s1"], ["C", "on paid invoice P, and deleted", "/invoices/p"]]);
  });

  it("fuel_deducted_twice: one purchase on two final statements, or on one it does not point back to", () => {
    const c = check(
      {
        fuelLines: [
          { fuelId: "f1", label: "Fuel 11/02", settlementId: "s1", settlementNumber: "ST-1", purchaseSettlementId: "s1" },
          { fuelId: "f2", label: "Fuel 11/03", settlementId: "s1", settlementNumber: "ST-1", purchaseSettlementId: "s1" },
          { fuelId: "f2", label: "Fuel 11/03", settlementId: "s2", settlementNumber: "ST-2", purchaseSettlementId: "s1" },
          { fuelId: "f3", label: "Fuel 11/04", settlementId: "s2", settlementNumber: "ST-2", purchaseSettlementId: null }
        ]
      },
      "fuel_deducted_twice"
    );
    expect([c.checked, c.passed, c.failed]).toEqual([3, 1, 2]);
    expect(c.examples.map((e) => e.detail)).toEqual(["taken off ST-1 and ST-2", "taken off ST-2, but the purchase is on no statement"]);
  });

  it("qbo_mismatch: not checked (never passed) with no connection or no finished sync; else missing and stale voids before the last sync", () => {
    const invoices = [inv({ id: "a" }), inv({ id: "miss", inQbo: false }), inv({ id: "new", inQbo: false, createdAt: T.getTime() + 10 }), inv({ id: "v", status: "void", voidedAt: T.getTime(), inQbo: true }), inv({ id: "v2", status: "void", voidedAt: T.getTime(), inQbo: false })];
    for (const [qbo, why] of [
      [{ connected: false, lastSyncAt: T.getTime() }, "QuickBooks is not connected."],
      [{ connected: true, lastSyncAt: null }, "No QuickBooks sync has finished yet."]
    ] as const) {
      const c = check({ invoices, qbo }, "qbo_mismatch");
      expect(c).toMatchObject({ state: "not_checked", notCheckedWhy: why, checked: 0, passed: 0, failed: 0 });
    }
    const c = check({ invoices }, "qbo_mismatch");
    expect([c.state, c.checked, c.passed, c.failed]).toEqual(["checked", 4, 2, 2]);
    expect(c.examples.map((e) => [e.label, e.detail])).toEqual([["MISS", "not in QuickBooks, though a sync has run since it was made"], ["V", "void on the desk, still in QuickBooks"]]);
    expect(c.limits).toContain("Changes made inside QuickBooks");
    expect(run({ invoices, qbo: { connected: false, lastSyncAt: null } }).notChecked).toBe(1);
  });

  it("factor_mismatch: each way the factoring can disagree, and a clean funded and a clean charged-back invoice", () => {
    const funded = { ...noF, status: "funded", fundedAt: 1, advanceCents: 90000, feeCents: 2500, reserveCents: 10000 };
    const fl = (s: string) => [load({ loadId: "l", factoringStatus: s })];
    const cases: Array<[Partial<MoneyInvoice>, string | null]> = [
      [{ factoring: funded, loads: fl("funded") }, null],
      [{ factoring: { ...noF, status: "rejected", fundedAt: 1, advanceCents: 90000, chargebackCents: 90000, chargedBackAt: 2 }, loads: fl("rejected") }, null],
      [{ factoring: { ...funded, fundedAt: null }, loads: fl("funded") }, "funded, with no funding day"],
      [{ factoring: { ...funded, advanceCents: null }, loads: fl("funded") }, "funded, with no advance recorded"],
      [{ factoring: { ...funded, reserveCents: 9000 }, loads: fl("funded") }, "advance $900.00 and reserve $90.00 are not the $1,000.00 billed"],
      [{ status: "paid", factoring: { ...funded, status: "paid", releasedCents: 7600, releasedAt: 3 }, loads: fl("paid") }, "released $76.00, more than the reserve less the fee"],
      [{ status: "paid", factoring: { ...funded, status: "paid", releasedCents: 7500 }, loads: fl("paid") }, "reserve released, with no release day"],
      [{ factoring: { ...noF, status: "rejected", fundedAt: 1, chargebackCents: 90000 }, loads: fl("rejected") }, "charged back, with no chargeback day"],
      [{ factoring: { ...funded, chargebackCents: 90000, chargedBackAt: 2 }, loads: fl("funded") }, "charged back, but the factoring says funded"],
      [{ factoring: { ...funded, status: "paid", releasedCents: 7500, releasedAt: 3 }, loads: fl("paid") }, "the factor says paid, but the invoice is open"],
      [{ status: "paid", factoring: funded, loads: fl("funded") }, "the invoice is paid, but the factoring still says funded"],
      [{ factoring: funded, loads: fl("submitted") }, "load L says submitted, the invoice funded"]
    ];
    for (const [o, want] of cases) expect(factorProblem(inv({ id: "f", ...o }))).toBe(want);
    const c = check({ invoices: [inv({ id: "a" }), ...cases.map(([o], i) => inv({ id: `f${i}`, ...o }))] }, "factor_mismatch");
    expect([c.checked, c.passed, c.failed]).toEqual([12, 2, 10]);
    expect(c.examples).toHaveLength(MONEY_EXAMPLES);
    expect(c.limits).toContain("The factor's own figures");
  });

  it("adds up failures across checks and carries the truncation", () => {
    const out = run({ invoices: [inv({ id: "b", totalCents: 1 })], truncated: true });
    expect([out.failed, out.notChecked, out.truncated]).toEqual([out.checks.reduce((s, c) => s + c.failed, 0), 0, true]);
    expect(out.failed).toBeGreaterThan(0);
  });
});
