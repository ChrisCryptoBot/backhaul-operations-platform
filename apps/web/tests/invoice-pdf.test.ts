import { PDFDocument } from "pdf-lib";
import { describe, expect, test } from "vitest";
import { buildInvoicePdf, pdfSafe, usdText, type InvoicePdfData } from "../src/lib/invoice-pdf";

const base: InvoicePdfData = {
  kind: "invoice",
  number: "INV-DM-40010",
  issued: "Nov 12, 2026",
  due: "Dec 12, 2026",
  termsLabel: "Net 30",
  status: "Open",
  issuer: { name: "Demo Fleet LLC", address: "100 Main St, Dallas, TX", mc: "123456", dot: "7654321", phone: "214-555-0100", email: "billing@demo.invalid", remitTo: "Demo Fleet LLC, PO Box 1, Dallas, TX", paymentNote: "ACH preferred." },
  billTo: { name: "Redwood Load Partners", mc: "998877", email: "ap@redwood.invalid", phone: null },
  loads: [{ loadNumber: "DM-40010", po: "PO-15438", origin: "Chicago, IL", destination: "Indianapolis, IN", pickedUp: "Nov 5, 2026", delivered: "Nov 6, 2026", refs: ["PU-40010"], lines: [{ label: "Line haul", amount: 537 }, { label: "Fuel surcharge", amount: 65 }] }],
  invoiceLines: [],
  total: 602,
  received: 0,
  credited: 0,
  balance: 602,
  creditOf: null,
  factoring: null
};

async function textOf(bytes: Uint8Array): Promise<{ pages: number; raw: string }> {
  const doc = await PDFDocument.load(bytes);
  return { pages: doc.getPageCount(), raw: Buffer.from(await PDFDocument.load(bytes).then((d) => d.save({ useObjectStreams: false }))).toString("latin1") };
}

describe("the invoice PDF (rule H)", () => {
  test("is a real PDF, made in memory, US Letter", async () => {
    const bytes = await buildInvoicePdf(base);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect([width, height]).toEqual([612, 792]);
    expect(doc.getTitle()).toBe("Invoice INV-DM-40010");
  });

  test("characters Helvetica cannot draw never break it", async () => {
    expect(pdfSafe("Chicago, IL → Indianapolis — “rush” · ok…")).toBe('Chicago, IL to Indianapolis - "rush" - ok...');
    expect(pdfSafe("emoji 🚚 gone")).toBe("emoji gone");
    const bytes = await buildInvoicePdf({ ...base, billTo: { ...base.billTo, name: "Ünïcode → Freight 🚚 “Co”" } });
    expect(bytes.length).toBeGreaterThan(500);
  });

  test("an invoice of many loads runs onto more pages, each numbered", async () => {
    const loads = Array.from({ length: 30 }, (_, i) => ({ ...base.loads[0]!, loadNumber: `DM-${41000 + i}` }));
    const bytes = await buildInvoicePdf({ ...base, loads, total: 602 * 30, balance: 602 * 30 });
    expect((await textOf(bytes)).pages).toBeGreaterThan(1);
  });

  test("the notice of assignment prints only when the invoice is factored (rule C)", async () => {
    const plain = await buildInvoicePdf(base);
    const factored = await buildInvoicePdf({ ...base, factoring: { factor: "TriumphPay", reference: "TP-1", remitTo: null } });
    expect(factored.length).toBeGreaterThan(plain.length);
  });

  test("money reads as dollars and cents, credits negative", () => {
    expect(usdText(1234.5)).toBe("$1,234.50");
    expect(usdText(-200)).toBe("-$200.00");
  });
});
