import { describe, expect, it } from "vitest";
import { calendarDays, cashBridge, cashEvents, cashFileRows, cashMoves, costOfMoney, dayStats, daysToCash, firstCashAt, fullyPaidAt, openBalance, periodCash, sumEvents, type CashInvoice } from "@/lib/cash";
import { buildJournal, type JInvoice } from "@/lib/journal";

/** Money plan Wave 6 step 4: cash beside gross. Pure, whole cents, booked the way the journal books it. */
const TZ = "America/Chicago";
const at = (iso: string) => Date.parse(iso);
const noF: CashInvoice["factoring"] = { status: "none", fundedAt: null, advanceCents: null, feeCents: null, releasedCents: null, chargebackCents: null, releasedAt: null, chargedBackAt: null, updatedAt: null };
const inv = (o: Partial<CashInvoice> & { id: string }): CashInvoice => ({
  number: o.id.toUpperCase(),
  status: "open",
  issuedAt: at("2026-11-02T18:00:00Z"),
  totalCents: 100000,
  paidTotalCents: 0,
  paidAt: null,
  writeOffCents: null,
  writeOffCode: null,
  factoring: noF,
  payments: [],
  customer: "Acme",
  lane: "Dallas, TX → Memphis, TN",
  ...o
});
const pay = (id: string, cents: number, iso: string, source = "desk") => ({ id, cents, at: at(iso), source });
// A factored invoice: funded 11/03, the customer pays the factor 11/20, the factor releases its reserve less the fee the same day.
const factored = inv({
  id: "f",
  status: "paid",
  paidTotalCents: 100000,
  paidAt: at("2026-11-20T18:00:00Z"),
  payments: [pay("pf", 100000, "2026-11-20T18:00:00Z", "factor")],
  factoring: { ...noF, status: "paid", fundedAt: at("2026-11-03T18:00:00Z"), advanceCents: 90000, feeCents: 2500, releasedCents: 7500, releasedAt: at("2026-11-20T18:00:00Z"), updatedAt: at("2026-11-20T18:00:00Z") }
});
// Charged back 12/01 after funding 11/03, then the customer pays the fleet 12/10.
const charged = inv({
  id: "c",
  status: "paid",
  paidTotalCents: 100000,
  paidAt: at("2026-12-10T18:00:00Z"),
  payments: [pay("pc", 100000, "2026-12-10T18:00:00Z")],
  factoring: { ...noF, status: "rejected", fundedAt: at("2026-11-03T18:00:00Z"), advanceCents: 90000, chargebackCents: 90000, chargedBackAt: at("2026-12-01T18:00:00Z"), updatedAt: at("2026-12-01T18:00:00Z") }
});
const plain = inv({ id: "p", status: "paid", paidTotalCents: 100000, paidAt: at("2026-11-12T18:00:00Z"), payments: [pay("p1", 40000, "2026-11-05T18:00:00Z"), pay("p2", 20000, "2026-11-12T18:00:00Z", "credit"), pay("p3", 40000, "2026-11-12T18:00:00Z")] });

const toJ = (i: CashInvoice): JInvoice => ({
  id: i.id,
  number: i.number,
  kind: "invoice",
  billTo: i.customer,
  issuedAt: new Date(i.issuedAt),
  total: i.totalCents,
  paidAt: i.paidAt == null ? null : new Date(i.paidAt),
  writeOff: i.writeOffCents,
  writeOffCode: i.writeOffCode,
  lines: [{ kind: "linehaul", amount: i.totalCents }],
  payments: i.payments.map((p) => ({ id: p.id, amount: p.cents, paidAt: new Date(p.at), source: p.source })),
  factoring: {
    fundedAt: i.factoring.fundedAt == null ? null : new Date(i.factoring.fundedAt),
    advance: i.factoring.advanceCents,
    fee: i.factoring.feeCents,
    reserveReleased: i.factoring.releasedCents,
    chargeback: i.factoring.chargebackCents,
    reserveReleasedAt: i.factoring.releasedAt == null ? null : new Date(i.factoring.releasedAt),
    chargedBackAt: i.factoring.chargedBackAt == null ? null : new Date(i.factoring.chargedBackAt),
    updatedAt: i.factoring.updatedAt == null ? null : new Date(i.factoring.updatedAt)
  }
});

describe("cash events", () => {
  it("a plain invoice: customer payments, applied credits left out", () => {
    expect(cashEvents(plain).map((e) => [e.source, e.cents])).toEqual([["customer", 40000], ["customer", 40000]]);
  });

  it("factored: the advance on funding, the reserve on release, and the customer's payment to the factor not counted twice", () => {
    expect(cashEvents(factored).map((e) => [e.source, e.cents, new Date(e.at).toISOString().slice(0, 10)])).toEqual([["advance", 90000, "2026-11-03"], ["released", 7500, "2026-11-20"]]);
    expect(sumEvents(cashEvents(factored)).net).toBe(97500); // the invoice less the fee: what the fleet got
  });

  it("charged back: the advance goes back, and a later customer payment is the fleet's cash", () => {
    expect(cashEvents(charged).map((e) => [e.source, e.cents])).toEqual([["advance", 90000], ["chargeback", -90000], ["customer", 100000]]);
    expect(sumEvents(cashEvents(charged)).net).toBe(100000);
  });

  it("a funding with no advance recorded books nothing, as the journal refuses it", () => {
    const x = inv({ id: "x", factoring: { ...noF, status: "funded", fundedAt: at("2026-11-03T18:00:00Z") }, payments: [pay("q", 100, "2026-11-05T18:00:00Z")] });
    expect(cashEvents(x).map((e) => e.source)).toEqual(["customer"]);
  });

  it("agrees with the journal's cash, to the cent, on every kind of invoice", () => {
    const all = [plain, factored, charged];
    const j = buildJournal({ invoices: all.map(toJ), settlements: [], fuel: [] }, { zone: TZ });
    const journalCash = j.entries.flatMap((e) => e.lines).filter((l) => l.key === "cash").reduce((s, l) => s + l.debit - l.credit, 0);
    expect(sumEvents(all.flatMap(cashEvents)).net).toBe(journalCash);
  });
});

describe("cost of money", () => {
  it("is the Leak ledger's two lines: the factor's fee once, a fee taken short only when no factoring fee", () => {
    const q = inv({ id: "q", status: "paid", paidAt: at("2026-11-12T18:00:00Z"), writeOffCents: 2000, writeOffCode: "quick_pay_fee" });
    const both = { ...factored, id: "b", writeOffCents: 2500, writeOffCode: "factor_fee" };
    expect(costOfMoney([factored, q, both, charged], () => true)).toEqual({ feesCents: 5000, shortCents: 2000, items: 3 });
    expect(costOfMoney([q], (t) => t < at("2026-11-01T00:00:00Z"))).toEqual({ feesCents: 0, shortCents: 0, items: 0 });
  });
});

describe("days to cash", () => {
  it("calendar days on the workspace clock, not 24-hour blocks", () => {
    // 11/02 11pm Chicago (05:00Z next day) to 11/03 1am Chicago: one calendar day.
    expect(calendarDays(at("2026-11-03T05:00:00Z"), at("2026-11-03T07:00:00Z"), TZ)).toBe(1);
    expect(calendarDays(at("2026-11-02T18:00:00Z"), at("2026-11-02T23:00:00Z"), TZ)).toBe(0);
  });

  it("median and 90th percentile over those that got there; the rest are waiting, never days", () => {
    expect(dayStats([3, null, 1, 10, 2, null])).toEqual({ reached: 4, waiting: 2, median: 2, p90: 10 });
    expect(dayStats([null, null])).toEqual({ reached: 0, waiting: 2, median: null, p90: null });
    expect(dayStats([])).toEqual({ reached: 0, waiting: 0, median: null, p90: null });
  });

  it("first cash is the first money in (an advance counts); paid in full is the release for a factored invoice", () => {
    expect([firstCashAt(factored), fullyPaidAt(factored)]).toEqual([at("2026-11-03T18:00:00Z"), at("2026-11-20T18:00:00Z")]);
    expect([firstCashAt(plain), fullyPaidAt(plain)]).toEqual([at("2026-11-05T18:00:00Z"), at("2026-11-12T18:00:00Z")]);
    const open = inv({ id: "o" });
    expect([firstCashAt(open), fullyPaidAt(open)]).toEqual([null, null]);
    expect(daysToCash([factored, plain, open], TZ)).toEqual({ invoices: 3, firstCash: { reached: 2, waiting: 1, median: 1, p90: 3 }, paidInFull: { reached: 2, waiting: 1, median: 10, p90: 18 } });
  });
});

describe("a period, and what is owed now", () => {
  it("counts cash by the day it moved and days by the invoices issued in the window", () => {
    const w = { start: at("2026-11-01T05:00:00Z"), end: at("2026-11-30T23:00:00Z") };
    const p = periodCash([plain, factored, charged], w, TZ);
    expect(p.cash).toEqual({ customer: 80000, advance: 180000, released: 7500, chargeback: 0, net: 267500 });
    expect(p.days.invoices).toBe(3);
    const dec = periodCash([plain, factored, charged], { start: at("2026-12-01T06:00:00Z"), end: at("2026-12-31T23:00:00Z") }, TZ);
    expect(dec.cash).toEqual({ customer: 100000, advance: 0, released: 0, chargeback: -90000, net: 10000 });
    expect(dec.days.invoices).toBe(0);
  });

  it("open balance, and the part on invoices a factor funded", () => {
    const funded = inv({ id: "g", factoring: { ...noF, status: "funded", fundedAt: 1, advanceCents: 90000 } });
    const part = inv({ id: "h", paidTotalCents: 25000 });
    expect(openBalance([funded, part, plain])).toEqual({ cents: 175000, invoices: 2, factoredCents: 100000, factoredInvoices: 1 });
  });

  it("the file's rows carry the same figures in dollars, exact to the cent", () => {
    const w = { start: at("2026-11-01T05:00:00Z"), end: at("2026-11-30T23:00:00Z") };
    const k = { current: periodCash([plain, factored], w, TZ), prior: null, open: openBalance([plain, factored]), leftOut: 2 };
    const rows = cashFileRows(k);
    const r = (m: string) => rows.find((x) => x.measure === m)!;
    expect([r("Paid by customers").now, r("Advanced by the factor").now, r("Reserve released").now, r("Cash in, net").now, r("Factoring fees").now]).toEqual([800, 900, 75, 1775, 25]);
    expect(r("First cash: still waiting").now).toBe(0);
    expect(r("Invoices whose loads are both in and out of this view, or that carry no load").now).toBe(2);
    expect(rows.every((x) => x.before === null)).toBe(true);
  });
});

describe("why it moved, on cash", () => {
  const w1 = { start: at("2026-11-26T18:00:00Z"), end: at("2026-12-03T18:00:00Z") };
  const w2 = { start: at("2026-12-03T18:00:00Z"), end: at("2026-12-10T18:00:00Z") };
  const several = inv({ id: "s", lane: null, customer: "Bolt", status: "paid", paidAt: at("2026-12-04T18:00:00Z"), payments: [pay("s1", 30000, "2026-12-04T18:00:00Z")] });

  it("the effects by source add back to the change, to the cent", () => {
    const b = cashBridge(sumEvents([]), { customer: 101, advance: 202, released: 0, chargeback: -50, net: 253 });
    expect(b.effects.reduce((s, e) => s + e.cents, 0)).toBe(b.change);
    const m = cashMoves([charged, several], w1, w2, "lane", TZ);
    expect(m.bridge.before.net).toBe(-90000);
    expect(m.bridge.after.net).toBe(130000); // the customer paid 12/10, the end of the week counts
    expect(m.bridge.change).toBe(220000);
    expect(m.bridge.effects.reduce((s, e) => s + e.cents, 0)).toBe(m.bridge.change);
  });

  it("every event lands in one row, so the rows add up too; several loads group as several lanes", () => {
    const m = cashMoves([charged, several], w1, w2, "lane", TZ);
    expect(m.rows.map((r) => [r.name, r.before, r.after, r.change])).toEqual([["Dallas, TX → Memphis, TN", -90000, 100000, 190000], ["Several lanes", 0, 30000, 30000]]);
    expect(m.rows.reduce((s, r) => s + r.change, 0)).toBe(m.bridge.change);
    expect(cashMoves([charged, several], w1, w2, "customer", TZ).rows.map((r) => r.name)).toEqual(["Acme", "Bolt"]);
    expect(m.days.after).toEqual({ reached: 2, waiting: 0, median: 32, p90: 38 });
    expect(m.days.before).toEqual({ reached: 0, waiting: 0, median: null, p90: null });
  });
});
