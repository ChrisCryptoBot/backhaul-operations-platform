import { inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { summarizeDetention } from "@/lib/detention";
import { lineKindOf } from "@/lib/invoice-records";
import { buildInvoicePdf, type InvoicePdfData } from "@/lib/invoice-pdf";
import { owedOf, SUPPLEMENTAL_KIND_LABEL, validateSupplementalLines } from "@/lib/invoicing";

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const parts: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream) {
      const filter = obj.dict.get(PDFName.of("Filter"));
      const buf = filter === PDFName.of("FlateDecode") ? inflateSync(obj.contents) : Buffer.from(obj.contents);
      const raw = buf.toString("latin1");
      parts.push(raw.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_, hex: string) => Buffer.from(hex, "hex").toString("latin1")));
    }
  }
  return parts.join("\n");
}

describe("supplemental invoice pure rules (Phase 5)", () => {
  it("validates line kinds, requires label only for other, and checks dollars and cents", () => {
    expect(validateSupplementalLines([])).toMatchObject({ ok: false });
    expect(validateSupplementalLines([{ kind: "unknown", amount: "100" }])).toMatchObject({ ok: false });
    expect(validateSupplementalLines([{ kind: "other", label: "  ", amount: "50" }])).toMatchObject({ ok: false });
    expect(validateSupplementalLines([{ kind: "detention", amount: "0" }])).toMatchObject({ ok: false });
    expect(validateSupplementalLines([{ kind: "detention", amount: "12.345" }])).toMatchObject({ ok: false });

    const ok = validateSupplementalLines([
      { kind: "detention", amount: "225.00" },
      { kind: "linehaul", amount: 150 },
      { kind: "layover", amount: "100.50" },
      { kind: "lumper", amount: "75" },
      { kind: "other", label: "Scale ticket", amount: "18.25" }
    ]);
    expect(ok).toEqual({
      ok: true,
      lines: [
        { kind: "detention", label: SUPPLEMENTAL_KIND_LABEL.detention, amount: 225, loadId: null },
        { kind: "linehaul", label: "Rate correction", amount: 150, loadId: null },
        { kind: "layover", label: "Layover", amount: 100.5, loadId: null },
        { kind: "lumper", label: "Lumper", amount: 75, loadId: null },
        { kind: "other", label: "Scale ticket", amount: 18.25, loadId: null }
      ],
      total: 568.75
    });
    expect(lineKindOf("Rate correction")).toBe("linehaul");
  });

  it("includes open supplemental balances in owedOf even when parent is paid", () => {
    expect(owedOf(1600, 1600)).toBe(0);
    expect(owedOf(1600, 1600, { supplementalOpen: 225, parentPaid: true })).toBe(225);
    expect(owedOf(1600, 1000, { supplementalOpen: 225 })).toBe(825);
    expect(owedOf(1600, 1600, { supplementalOpen: 225, credits: 50, parentPaid: true })).toBe(175);
    expect(owedOf(null, null, { supplementalOpen: 0 })).toBeNull();
  });

  it("counts supplemental detention as billed in summarizeDetention", () => {
    const base = {
      stops: [
        { stopSequence: 1, stopType: "pickup", waitMinutes: 30 },
        { stopSequence: 2, stopType: "delivery", waitMinutes: 300 }
      ],
      dockWaitMinutes: null,
      rate: 75,
      graceMinutes: 120,
      workspaceGraceMinutes: 120
    };
    const before = summarizeDetention({
      ...base,
      invoice: { invoiced: true, invoicedAmount: 1600, quotedRevenue: 1500, fuelSurcharge: 100, lines: [{ label: "Line haul", amount: 1500 }, { label: "Fuel surcharge", amount: 100 }] }
    });
    expect(before.billable).toBe(225);
    expect(before.unbilled).toBe(225);

    const after = summarizeDetention({
      ...base,
      invoice: { invoiced: true, invoicedAmount: 1600, quotedRevenue: 1500, fuelSurcharge: 100, lines: [{ label: "Line haul", amount: 1500 }, { label: "Fuel surcharge", amount: 100 }], supplementalDetention: 225 }
    });
    expect(after.billedExtra).toBe(225);
    expect(after.unbilled).toBe(0);
  });

  it("renders SUPPLEMENTAL INVOICE title and parent invoice number on PDF", async () => {
    const data: InvoicePdfData = {
      kind: "invoice",
      number: "INV-DM-100-S1",
      issued: "Nov 25, 2026",
      due: "Dec 25, 2026",
      termsLabel: "Net 30",
      status: "Open",
      issuer: { name: "Demo Fleet LLC", address: "Dallas, TX", mc: "123456", dot: "7654321", phone: null, email: null, remitTo: null, paymentNote: null },
      billTo: { name: "Broker Co", mc: "998877", email: null, phone: null },
      loads: [{ loadNumber: "DM-100", po: null, origin: "Dallas, TX", destination: "Tulsa, OK", pickedUp: null, delivered: "Nov 24, 2026", refs: [], lines: [{ label: "Detention", amount: 225 }] }],
      invoiceLines: [],
      total: 225,
      received: 0,
      credited: 0,
      balance: 225,
      creditOf: null,
      supplementOf: "INV-DM-100",
      factoring: null
    };
    const bytes = await buildInvoicePdf(data);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getTitle()).toBe("Supplemental invoice INV-DM-100-S1");
    const raw = await pdfText(bytes);
    expect(raw).toContain("SUPPLEMENTAL INVOICE");
    expect(raw).toContain("Supplemental to");
    expect(raw).toContain("INV-DM-100");
  });
});
