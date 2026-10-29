import { describe, expect, it } from "vitest";
import { searchBoard } from "../src/lib/board-filter";
import { historyRows, monthGroups, payRecord, type HistoryRow } from "../src/lib/loads-history";

const d = (iso: string) => new Date(iso);
const row = (id: string, over: Partial<HistoryRow> = {}): HistoryRow => ({
  id,
  status: "completed",
  verdict: null,
  loadNumber: id,
  brokerName: "Acme",
  origin: "Dallas, TX",
  destination: "Memphis, TN",
  vehicleName: "Truck 1",
  driverName: "Alex",
  poNumber: null,
  invoiceNumber: null,
  brokerMc: null,
  paymentStatus: null,
  quotedRevenue: 1000,
  perMile: 2,
  scheduledDate: null,
  completedAt: d("2026-10-15T18:00:00Z"),
  cancelledAt: null,
  invoicedAt: null,
  paidAt: null,
  invoicedAmount: null,
  paidAmount: null,
  ...over
});

const rows: HistoryRow[] = [
  row("A", { completedAt: d("2026-10-20T18:00:00Z"), paymentStatus: "paid", invoiceNumber: "INV-A", invoicedAt: d("2026-10-21T18:00:00Z"), paidAt: d("2026-11-10T18:00:00Z"), invoicedAmount: 1000, paidAmount: 1000, quotedRevenue: 1000, perMile: 2.5 }),
  row("B", { completedAt: d("2026-10-10T18:00:00Z"), paymentStatus: "invoiced", invoiceNumber: "INV-B", invoicedAt: d("2026-10-11T18:00:00Z"), invoicedAmount: 800, quotedRevenue: 800, perMile: 1.6 }),
  row("C", { completedAt: d("2026-09-30T18:00:00Z"), quotedRevenue: 1500, perMile: 3 }),
  row("D", { status: "cancelled", completedAt: null, cancelledAt: d("2026-09-12T18:00:00Z"), quotedRevenue: 700, perMile: null }),
  row("E", { status: "tonu", completedAt: null, cancelledAt: d("2026-10-02T18:00:00Z"), quotedRevenue: 150, perMile: null }),
  row("OPEN", { status: "in_progress", completedAt: null })
];

describe("historyRows", () => {
  const ids = (f: Parameters<typeof historyRows>[1]) => historyRows(rows, f).map((r) => r.id);

  it("keeps only finished loads, newest first by default", () => {
    expect(ids({})).toEqual(["A", "B", "E", "C", "D"]);
    expect(ids({ sort: "oldest" })).toEqual(["D", "C", "E", "B", "A"]);
  });

  it("owed is delivered and not yet paid; cancelled is cancelled and TONU", () => {
    expect(ids({ filter: "owed" })).toEqual(["B", "C"]);
    expect(ids({ filter: "cancelled" })).toEqual(["E", "D"]);
  });

  it("sorts by pay and by dollars per mile, loads without a figure last", () => {
    expect(ids({ sort: "pay" })).toEqual(["C", "A", "B", "D", "E"]);
    expect(ids({ sort: "permile" }).slice(0, 3)).toEqual(["C", "A", "B"]);
    expect(ids({ sort: "permile" }).slice(3).sort()).toEqual(["D", "E"]);
  });

  it("an unknown filter or sort falls back to all and newest", () => {
    expect(ids({ filter: "nonsense", sort: "nonsense" })).toEqual(ids({}));
  });

  it("searches the invoice number, PO and MC as well as the usual fields", () => {
    expect(ids({ q: "inv-b" })).toEqual(["B"]);
    const withPo = [row("P", { poNumber: "PO-777" }), row("Q", { brokerMc: "445566" }), row("R")];
    expect(historyRows(withPo, { q: "po-777" }).map((r) => r.id)).toEqual(["P"]);
    expect(historyRows(withPo, { q: "445566" }).map((r) => r.id)).toEqual(["Q"]);
    expect(searchBoard(withPo, "445566").map((r) => r.id)).toEqual(["Q"]);
  });
});

describe("monthGroups", () => {
  it("groups by month on the Dallas calendar, in the order given", () => {
    const groups = monthGroups(historyRows(rows, {}));
    expect(groups.map((g) => [g.key, g.label, g.rows.map((r) => r.id)])).toEqual([
      ["2026-10", "October 2026", ["A", "B", "E"]],
      ["2026-09", "September 2026", ["C", "D"]]
    ]);
  });

  it("a load delivered just after midnight UTC on the 1st is still the month before in Dallas", () => {
    const late = row("L", { completedAt: d("2026-11-01T03:00:00Z") });
    expect(monthGroups([late])[0]!.key).toBe("2026-10");
  });

  it("a load with no date goes under Undated", () => {
    expect(monthGroups([row("U", { completedAt: null, cancelledAt: null })])[0]).toMatchObject({ key: "undated", label: "Undated" });
  });
});

describe("payRecord", () => {
  it("summarises one broker: invoiced, paid, days to pay, short pays, still out, cancelled", () => {
    const acme = rows.filter((r) => r.status !== "in_progress");
    const rec = payRecord(acme)!;
    expect(rec).toMatchObject({ broker: "Acme", loads: 5, invoices: 2, paid: 1, shortPaid: 0, outstanding: 800, fellThrough: 2 });
    expect(rec.averageDaysToPay).toBeCloseTo(20, 5);
  });

  it("counts a payment below the invoice as short", () => {
    const rec = payRecord([row("S", { paymentStatus: "paid", invoicedAt: d("2026-10-01T00:00:00Z"), paidAt: d("2026-10-11T00:00:00Z"), invoicedAmount: 1000, paidAmount: 940 })])!;
    expect(rec.shortPaid).toBe(1);
    expect(rec.averageDaysToPay).toBeCloseTo(10, 5);
  });

  it("is null unless every row is one broker", () => {
    expect(payRecord([row("X"), row("Y", { brokerName: "Other" })])).toBeNull();
    expect(payRecord([row("Z", { brokerName: null })])).toBeNull();
    expect(payRecord([])).toBeNull();
  });
});
