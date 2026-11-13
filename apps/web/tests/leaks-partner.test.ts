import { describe, expect, it } from "vitest";
import { buildLeakLedger, LEAKS, leakMeta, partnerLeaks, type PartnerIfta, type PartnerInvoice, type PartnerRecords } from "@/lib/leaks";

/** Money plan Wave 6 step 3: Leak ledger lines from partner records. Pure, exact cents, one record priced once, nothing estimated. */
const TZ = "America/Chicago";
const NOW = Date.parse("2026-11-13T18:00:00Z");
const T = Date.parse("2026-11-10T18:00:00Z"); // inside the last week and this month
const inv = (o: Partial<PartnerInvoice> & { id: string }): PartnerInvoice => ({
  number: o.id.toUpperCase(),
  status: "open",
  customer: "Acme",
  feeCents: null,
  fundedAt: null,
  chargebackCents: null,
  chargedBackAt: null,
  paidAt: null,
  writeOffCents: null,
  writeOffCode: null,
  paidSinceChargebackCents: 0,
  place: { loadId: `l-${o.id}`, lane: "Dallas → Memphis", truck: "Unit 801" },
  ...o
});
const ifta = (o: Partial<PartnerIfta>): PartnerIfta => ({ id: "r1", quarter: "2026-Q3", filedAt: T, filedTotal: "512.40", liveTotal: "498.15", liveRatesFinal: true, liveMissingRate: false, ...o });
const recs = (o: Partial<PartnerRecords>): PartnerRecords => ({ invoices: [], fuel: [], ifta: [], ...o });
const keysOf = (r: PartnerRecords) => partnerLeaks(r).map((i) => [i.key, i.label, i.dollars]);

describe("partner leak lines", () => {
  it("adds five keys in the money group, each with its stored basis; only chargebacks are left out of the total", () => {
    const mine = LEAKS.filter((l) => l.group === "money");
    expect(mine.map((l) => [l.key, l.counted])).toEqual([["factoring_fees", true], ["fee_short_pays", true], ["fuel_no_discount", true], ["ifta_overpaid", true], ["factor_chargebacks", false]]);
    expect(leakMeta("factoring_fees").basis).toContain("Invoice.factoringFundedAt");
    expect(leakMeta("fee_short_pays").basis).toContain("Invoice.paidAt");
    expect(leakMeta("factor_chargebacks").basis).toContain("gross");
    expect(leakMeta("factor_chargebacks").basis).toContain("not reduced when the customer pays later");
    expect(leakMeta("factor_chargebacks").basis).toContain("Invoice.factoringChargedBackAt");
    expect(leakMeta("fuel_no_discount").unpricedWhy).toContain("no expected discount is stored");
    expect(leakMeta("ifta_overpaid").unpricedWhy).toContain("not all final");
    // Every existing line keeps its place and is not a partner line.
    expect(LEAKS.filter((l) => l.group !== "money").every((l) => !l.partner)).toBe(true);
  });

  it("factoring fee: the stored fee, dated by the funding day; not when charged back, void, or no fee", () => {
    expect(keysOf(recs({ invoices: [inv({ id: "a", feeCents: 2537, fundedAt: T })] }))).toEqual([["factoring_fees", "A", 25.37]]);
    expect(partnerLeaks(recs({ invoices: [inv({ id: "a", feeCents: 2537, fundedAt: T })] }))[0]).toMatchObject({ at: T, href: "/invoices/a", recordId: "invoice:a", loadId: "l-a", truck: "Unit 801" });
    expect(keysOf(recs({ invoices: [inv({ id: "v", status: "void", feeCents: 2500, fundedAt: T }), inv({ id: "z", feeCents: 0, fundedAt: T }), inv({ id: "n", feeCents: 2500 })] }))).toEqual([]);
    expect(keysOf(recs({ invoices: [inv({ id: "c", feeCents: 2500, fundedAt: T - 1000, chargebackCents: 90000, chargedBackAt: T })] }))).toEqual([["factor_chargebacks", "C", 900]]);
  });

  it("a fee taken short: quick_pay_fee and factor_fee only, dated by the close; other codes never", () => {
    const q = inv({ id: "q", status: "paid", paidAt: T, writeOffCents: 2000, writeOffCode: "quick_pay_fee" });
    const f = inv({ id: "f", status: "paid", paidAt: T, writeOffCents: 1550, writeOffCode: "factor_fee" });
    const d = inv({ id: "d", status: "paid", paidAt: T, writeOffCents: 5000, writeOffCode: "damage_claim" });
    expect(keysOf(recs({ invoices: [q, f, d] }))).toEqual([["fee_short_pays", "Q", 20], ["fee_short_pays", "F", 15.5]]);
    expect(partnerLeaks(recs({ invoices: [q] }))[0]!.basisNote).toBe("quick-pay fee");
  });

  it("never double counts: an invoice with a factoring fee and a fee taken short is priced once, on the fee; a write-off while the factor owned it is the factor's", () => {
    const both = inv({ id: "b", status: "paid", feeCents: 2500, fundedAt: T - 5000, paidAt: T, writeOffCents: 2500, writeOffCode: "factor_fee" });
    expect(keysOf(recs({ invoices: [both] }))).toEqual([["factoring_fees", "B", 25]]);
    const owned = inv({ id: "o", status: "paid", feeCents: null, fundedAt: T - 5000, paidAt: T, writeOffCents: 2000, writeOffCode: "quick_pay_fee" });
    expect(keysOf(recs({ invoices: [owned] }))).toEqual([]);
    // Charged back before it closed: the fleet's again, so its own short pay counts (and the chargeback shows as the lens).
    const back = inv({ id: "k", status: "paid", fundedAt: T - 9000, chargebackCents: 90000, chargedBackAt: T - 5000, paidAt: T, writeOffCents: 2000, writeOffCode: "quick_pay_fee", paidSinceChargebackCents: 98000 });
    expect(keysOf(recs({ invoices: [back] }))).toEqual([["fee_short_pays", "K", 20], ["factor_chargebacks", "K", 900]]);
    expect(partnerLeaks(recs({ invoices: [back] }))[1]!.basisNote).toBe("the customer has paid $980.00 since");
    // No record is priced in two counted lines.
    const all = partnerLeaks(recs({ invoices: [both, owned, back, inv({ id: "a", feeCents: 1, fundedAt: T })], fuel: [{ id: "x", label: "Pilot", at: T, truck: null }], ifta: [ifta({})] }));
    const counted = all.filter((i) => leakMeta(i.key).counted && i.dollars != null).map((i) => i.recordId);
    expect(new Set(counted).size).toBe(counted.length);
    expect(all.every((i) => i.recordId)).toBe(true);
  });

  it("fuel bought with no discount is counted and never priced", () => {
    const out = partnerLeaks(recs({ fuel: [{ id: "x", label: "Pilot 0412", at: T, truck: "Unit 801" }] }));
    expect(out).toEqual([expect.objectContaining({ key: "fuel_no_discount", dollars: null, label: "Pilot 0412", truck: "Unit 801", recordId: "fuel:x", href: "/fuel?days=90" })]);
  });

  it("IFTA filed high: filed less recalculated, exact, only on final rates; not priced when provisional or a rate is missing; nothing when not high", () => {
    expect(keysOf(recs({ ifta: [ifta({})] }))).toEqual([["ifta_overpaid", "2026-Q3 IFTA return", 14.25]]);
    // A credit not claimed: the filed total (a credit, negative) is above the recalculation's larger credit.
    expect(keysOf(recs({ ifta: [ifta({ filedTotal: "-14.88", liveTotal: "-40.10" })] }))).toEqual([["ifta_overpaid", "2026-Q3 IFTA return", 25.22]]);
    expect(keysOf(recs({ ifta: [ifta({ liveRatesFinal: false })] }))).toEqual([["ifta_overpaid", "2026-Q3 IFTA return", null]]);
    expect(keysOf(recs({ ifta: [ifta({ liveMissingRate: true })] }))).toEqual([["ifta_overpaid", "2026-Q3 IFTA return", null]]);
    expect(keysOf(recs({ ifta: [ifta({ liveTotal: null })] }))).toEqual([["ifta_overpaid", "2026-Q3 IFTA return", null]]);
    expect(keysOf(recs({ ifta: [ifta({ liveTotal: "512.40" })] }))).toEqual([]);
    expect(keysOf(recs({ ifta: [ifta({ liveTotal: "600.00" })] }))).toEqual([]);
  });

  it("in the ledger: exact cent sums, the money share inside the total, the chargeback lens outside it, and each item in its week", () => {
    const items = partnerLeaks(
      recs({
        invoices: [inv({ id: "a", feeCents: 10, fundedAt: T }), inv({ id: "b", feeCents: 20, fundedAt: T }), inv({ id: "c", status: "paid", paidAt: T - 7 * 86_400_000, writeOffCents: 2000, writeOffCode: "quick_pay_fee" }), inv({ id: "k", fundedAt: T - 9e6, chargebackCents: 90000, chargedBackAt: T })],
        fuel: [{ id: "x", label: "Pilot", at: T, truck: null }],
        ifta: [ifta({})]
      })
    );
    const l = buildLeakLedger(items, { period: "4w", compare: false }, NOW, TZ);
    const line = (k: string) => l.current.lines.find((x) => x.key === k)!;
    expect([line("factoring_fees").dollars, line("factoring_fees").items]).toEqual([0.3, 2]);
    expect([line("fee_short_pays").dollars, line("fuel_no_discount").dollars, line("fuel_no_discount").unpriced, line("ifta_overpaid").dollars]).toEqual([20, 0, 1, 14.25]);
    expect([line("factor_chargebacks").dollars, line("factor_chargebacks").counted]).toEqual([900, false]);
    expect(l.current.total).toBe(34.55);
    expect(l.current.money).toEqual({ dollars: 34.55, items: 5, unpriced: 1 });
    const last = l.weeks[l.weeks.length - 1]!;
    const before = l.weeks[l.weeks.length - 2]!;
    expect([last.byKey.factoring_fees, last.byKey.ifta_overpaid, last.byKey.fee_short_pays, before.byKey.fee_short_pays]).toEqual([0.3, 14.25, 0, 20]);
    expect([last.total, last.money, before.money]).toEqual([14.55, 14.55, 20]);
    // The chargeback is never in a week's total.
    expect(last.byKey.factor_chargebacks).toBe(900);
    expect(l.top.find((t) => t.key === "factoring_fees")).toMatchObject({ partner: true, href: "/invoices/b" });
  });

  it("fleet-only items are counted apart, in the period only, and never in the figures", () => {
    const fleet = partnerLeaks(recs({ ifta: [ifta({})], fuel: [{ id: "old", label: "Pilot", at: NOW - 400 * 86_400_000, truck: null }] }));
    const l = buildLeakLedger([], { period: "4w", compare: false, fleetOnly: fleet }, NOW, TZ);
    expect(l.fleetOnly).toEqual({ items: 1, byKey: { ifta_overpaid: 1 } });
    expect(l.current.total).toBe(0);
  });
});
