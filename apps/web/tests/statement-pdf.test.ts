import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { buildStatementPdf, statementPdfModel, ytdFromRows, type StatementPdfData } from "../src/lib/statement-pdf";
import { payNote } from "../src/lib/settlement";

/**
 * The driver statement PDF (docs/MONEY_PLAN.md, Wave 4 step 6, rule H): what it draws (the model) matches the statement page's figures and words, the year to date always adds back up, drafts and
 * voided statements are stamped on every page, a negative statement says the driver owes, and the bytes are a real US Letter PDF whose text says all of it.
 */
const base: StatementPdfData = {
  number: "ST-0042",
  status: "final",
  issuer: { name: "Demo Fleet LLC", address: "100 Main St, Dallas, TX", mc: "123456", dot: "7654321", phone: "214-555-0100", email: "pay@demo.invalid" },
  driver: { name: "Ana Ruiz", code: "ARUI" },
  periodLabel: "Oct 5 to Oct 11, 2026",
  finalizedOn: "Oct 13, 2026",
  payoutText: "Paid Oct 14, 2026 by check",
  voidedOn: null,
  voidReason: null,
  statement: {
    lines: [{ loadId: "l1", loadNumber: "DM-1", lane: "Dallas, TX → Austin, TX", deliveredAt: "2026-10-06T17:00:00Z", basis: "$0.50 a mile × 2,469 mi", payKind: "cpm", payRate: 0.5, hours: null, amount: 1234.5, brokerStatus: "paid" }],
    adjustments: [{ label: "Detention share", amount: 75 }],
    fuel: [{ id: "f1", on: "2026-10-07", location: "Pilot, Waco, TX", gallons: 100, pricePerGallon: 4, discount: 25, amount: 375, loadNumber: "DM-1" }],
    deductions: [
      { deductionId: "d1", advanceId: null, kind: "deduction", label: "Truck lease", basis: "Truck lease", amount: -300 },
      { deductionId: "d2", advanceId: null, kind: "escrow", label: "Escrow", basis: "Escrow", amount: -100 },
      { deductionId: null, advanceId: "a1", kind: "advance_repaid", label: "Advance of $500.00, Oct 1, 2026 (cash)", basis: "Advance repaid", amount: -150 },
      { deductionId: null, advanceId: null, kind: "escrow_release", label: "Escrow released", basis: "Lease ended", amount: 40 }
    ],
    loadsTotal: 1234.5,
    fuelTotal: 375,
    adjustmentsTotal: 75,
    deductionsTotal: -510,
    total: 424.5
  },
  balances: { escrowHeldCents: 46000, advanceOwedCents: 35000, asOf: "Nov 12, 2026" },
  ytd: ytdFromRows(2026, 3, [
    { kind: "load", cents: 123450 },
    { kind: "load", cents: 80000 },
    { kind: "adjustment", cents: 7500 },
    { kind: "adjustment", cents: -2500 },
    { kind: "fuel", cents: -37500 },
    { kind: "deduction", cents: -30000 },
    { kind: "escrow", cents: -10000 },
    { kind: "advance_repaid", cents: -15000 },
    { kind: "escrow_release", cents: 4000 }
  ])
};

/** Every string the PDF draws, read back from its (inflated) page content streams. */
async function drawnText(bytes: Uint8Array): Promise<string> {
  const raw = Buffer.from(await (await PDFDocument.load(bytes)).save({ useObjectStreams: false }));
  const out: string[] = [];
  let at = 0;
  for (;;) {
    const s = raw.indexOf("stream", at);
    if (s < 0) break;
    const start = raw[s + 6] === 0x0d ? s + 8 : s + 7;
    const end = raw.indexOf("endstream", start);
    if (end < 0) break;
    let body: Buffer = raw.subarray(start, end);
    try {
      body = inflateSync(body);
    } catch {
      /* not compressed */
    }
    for (const m of body.toString("latin1").matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(Buffer.from(m[1]!, "hex").toString("latin1"));
    at = end + 9;
  }
  return out.join("\n");
}

describe("what the statement PDF says", () => {
  test("every section with its total, the same bottom line and footnote as the statement page", () => {
    const m = statementPdfModel(base);
    expect(m.sections.map((s) => [s.title, s.rows.length, s.total])).toEqual([
      ["Loads", 1, 1234.5],
      ["Fuel card", 1, -375],
      ["Adjustments", 1, 75],
      ["Deductions, escrow and advances", 4, -510]
    ]);
    expect(m.sections[3]!.rows.map((r) => [r.detail, r.amount])).toEqual([["Deduction", -300], ["Escrow held", -100], ["Advance repaid", -150], ["Escrow released | Lease ended", 40]]);
    expect(m.summary.map((s) => s.amount).reduce((a, b) => a + b, 0)).toBeCloseTo(m.net.amount, 10);
    expect(m.net).toEqual({ label: "Net pay to Ana Ruiz", amount: 424.5, owes: false });
    expect(m.note).toBe(`${payNote(base.statement)} Taxes and payroll withholding are not worked out here.`);
    expect(m.balances).toEqual([{ label: "Escrow held for the driver", amount: 460 }, { label: "Advances still owed", amount: 350 }]);
    expect(m.stamp).toBeNull();
  });

  test("the year to date splits net into parts that add back up to it", () => {
    const y = base.ytd!;
    expect(y).toMatchObject({ statements: 3, grossCents: 210950, fuelCents: -37500, adjustmentsOffCents: -2500, deductionsCents: -40000, advancesRepaidCents: -15000, escrowReleasedCents: 4000 });
    expect(y.grossCents + y.fuelCents + y.adjustmentsOffCents + y.deductionsCents + y.advancesRepaidCents + y.escrowReleasedCents).toBe(y.netCents);
    expect(y.netCents).toBe(119950);
    expect(statementPdfModel(base).ytd.at(-1)).toEqual({ label: "Net pay", amount: 1199.5 });
  });

  test("a statement of loads alone is gross pay, one total line", () => {
    const st = { ...base.statement, fuel: [], adjustments: [], deductions: [], fuelTotal: 0, adjustmentsTotal: 0, deductionsTotal: 0, total: 1234.5 };
    const m = statementPdfModel({ ...base, statement: st });
    expect(m.net.label).toBe("Total to Ana Ruiz");
    expect(m.summary).toHaveLength(2);
    expect(m.note.startsWith("Gross pay for the loads and adjustments above.")).toBe(true);
  });

  test("a draft and a voided statement are stamped; a negative one says the driver owes", () => {
    expect(statementPdfModel({ ...base, status: "draft" }).stamp?.text).toBe("DRAFT");
    expect(statementPdfModel({ ...base, status: "void", voidedOn: "Oct 15, 2026", voidReason: "Wrong week" }).stamp).toEqual({ text: "VOID", note: "Voided Oct 15, 2026: Wrong week. This statement was taken back and is not paid." });
    expect(statementPdfModel({ ...base, statement: { ...base.statement, total: -80 } }).net).toMatchObject({ owes: true, amount: -80 });
  });
});

describe("the bytes (rule H)", () => {
  test("a real US Letter PDF, made in memory, that draws the figures", async () => {
    const bytes = await buildStatementPdf(base);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getTitle()).toBe("Pay statement ST-0042");
    const t = await drawnText(bytes);
    for (const s of ["PAY STATEMENT", "Ana Ruiz (ARUI)", "Dallas, TX to Austin, TX", "$1,234.50", "-$375.00", "Escrow released | Lease ended", "Net pay to Ana Ruiz", "$424.50", "Advances still owed", "$350.00", "YEAR TO DATE, 2026", "$1,199.50", "Paid Oct 14, 2026 by check"]) expect(t, s).toContain(s);
  });

  test("a draft says DRAFT in its title, its header, its box and on every page's footer", async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ ...base.statement.lines[0]!, loadId: `l${i}`, loadNumber: `DM-${100 + i}` }));
    const bytes = await buildStatementPdf({ ...base, status: "draft", statement: { ...base.statement, lines } });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe("Pay statement ST-0042 (draft)");
    const t = await drawnText(bytes);
    expect(t).toContain("PAY STATEMENT - DRAFT");
    expect(t).toContain("Not finalized: the figures can still change.");
    expect(t.match(/ST-0042 \| DRAFT \| Page \d of \d/g)?.length).toBe(doc.getPageCount());
    expect(t).toContain("FINALIZED STATEMENTS, NOT COUNTING THIS ONE");
  });

  test("a negative statement prints what the driver owes; no year to date prints a plain line", async () => {
    const t = await drawnText(await buildStatementPdf({ ...base, ytd: null, statement: { ...base.statement, total: -80 } }));
    expect(t).toContain("Ana Ruiz owes $80.00");
    expect(t).toContain("No finalized statements in this calendar year yet.");
  });
});
