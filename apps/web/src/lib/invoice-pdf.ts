import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

/**
 * The invoice as a PDF, made on the server as bytes (docs/MONEY_PLAN.md, rule H): never written to disk, so Wave 2's packet builder can put it in front of the rate
 * confirmation and the proof of delivery directly. US Letter, Helvetica, black on white, so it prints and faxes cleanly. Pure: data in, bytes out.
 */
export type InvoicePdfLine = { label: string; amount: number };
export type InvoicePdfLoad = {
  loadNumber: string | null;
  po: string | null;
  origin: string | null;
  destination: string | null;
  pickedUp: string | null;
  delivered: string | null;
  refs: string[];
  lines: InvoicePdfLine[];
};
export type InvoicePdfData = {
  kind: "invoice" | "credit_memo";
  number: string;
  issued: string;
  due: string | null;
  termsLabel: string;
  status: string;
  issuer: { name: string; address: string | null; mc: string | null; dot: string | null; phone: string | null; email: string | null; remitTo: string | null; paymentNote: string | null };
  billTo: { name: string | null; mc: string | null; email: string | null; phone: string | null };
  loads: InvoicePdfLoad[];
  /** Lines that belong to the invoice, not to one load (rule A). */
  invoiceLines: InvoicePdfLine[];
  total: number;
  received: number;
  credited: number;
  balance: number;
  creditOf: string | null;
  /** Set when the invoice has gone to a factor: the notice of assignment prints and the remit-to is the factor's (rule C). */
  factoring: { factor: string; reference: string | null; remitTo: string | null; /** The notice wording the fleet saved with its factoring terms; the plain wording prints when it is blank. */ noaText?: string | null } | null;
};

const PAGE_W = 612;
const PAGE_H = 792;
const M = 48;
const INK = rgb(0.07, 0.07, 0.07);
const DIM = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.75, 0.75, 0.75);

/** Helvetica in a PDF only knows the WinAnsi letters: anything else is said in plain ASCII so the file never fails to build on a typed arrow or a smart quote. */
export function pdfSafe(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/[→➔⟶]/g, " to ")
    .replace(/[–—−]/g, "-")
    .replace(/[·•]/g, "-")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, "...")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7e -ÿ]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export const usdText = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = pdfSafe(text).split(" ").filter(Boolean);
  const out: string[] = [];
  let line = "";
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width) line = next;
    else {
      if (line) out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out;
}

export async function buildInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${d.kind === "credit_memo" ? "Credit memo" : "Invoice"} ${d.number}`));
  doc.setAuthor(pdfSafe(d.issuer.name));
  doc.setCreator("TrueLane Desk");
  doc.setProducer("TrueLane Desk");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const text = (s: string, x: number, size = 10, f: PDFFont = font, color = INK) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const right = (s: string, xRight: number, size = 10, f: PDFFont = font, color = INK) => {
    const t = pdfSafe(s);
    page.drawText(t, { x: xRight - f.widthOfTextAtSize(t, size), y, size, font: f, color });
  };
  const rule = (yy: number, color = RULE) => page.drawLine({ start: { x: M, y: yy }, end: { x: PAGE_W - M, y: yy }, thickness: 0.75, color });
  const ensure = (needed: number) => {
    if (y - needed < M + 40) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - M;
      text(`${d.kind === "credit_memo" ? "Credit memo" : "Invoice"} ${d.number} (continued)`, M, 9, font, DIM);
      y -= 20;
    }
  };

  // Header: who it is from (left), what it is (right).
  text(d.issuer.name, M, 16, bold);
  right(d.kind === "credit_memo" ? "CREDIT MEMO" : "INVOICE", PAGE_W - M, 18, bold);
  y -= 18;
  const fromLines = [d.issuer.address, [d.issuer.mc ? `MC ${d.issuer.mc}` : null, d.issuer.dot ? `DOT ${d.issuer.dot}` : null].filter(Boolean).join(" | "), [d.issuer.phone, d.issuer.email].filter(Boolean).join(" | ")].filter((s): s is string => !!s);
  const metaLines: Array<[string, string]> = [["Number", d.number], ["Issued", d.issued], ["Terms", d.termsLabel], ...(d.due ? ([["Due", d.due]] as Array<[string, string]>) : []), ...(d.creditOf ? ([["Credits invoice", d.creditOf]] as Array<[string, string]>) : [])];
  const rows = Math.max(fromLines.length, metaLines.length);
  for (let i = 0; i < rows; i++) {
    if (fromLines[i]) text(fromLines[i]!, M, 9, font, DIM);
    const m = metaLines[i];
    if (m) {
      right(m[1], PAGE_W - M, 9, bold);
      right(m[0], PAGE_W - M - bold.widthOfTextAtSize(pdfSafe(m[1]), 9) - 8, 9, font, DIM);
    }
    y -= 13;
  }
  y -= 8;
  rule(y);
  y -= 18;

  // Bill to.
  text("BILL TO", M, 8, bold, DIM);
  y -= 13;
  text(d.billTo.name ?? "-", M, 11, bold);
  y -= 13;
  const billMeta = [d.billTo.mc ? `MC ${d.billTo.mc}` : null, d.billTo.email, d.billTo.phone].filter(Boolean).join(" | ");
  if (billMeta) {
    text(billMeta, M, 9, font, DIM);
    y -= 13;
  }
  y -= 6;

  // Notice of assignment (rule C): only when the invoice has gone to a factor.
  if (d.factoring) {
    const said = d.factoring.noaText ? pdfSafe(d.factoring.noaText) : "Payment to anyone else does not discharge the debt.";
    // Rule C: this copy replaces any sent before the invoice was factored, which named the carrier as the payee.
    const noa = `NOTICE OF ASSIGNMENT. This invoice has been assigned and is payable only to ${pdfSafe(d.factoring.factor)}${d.factoring.reference ? ` (reference ${pdfSafe(d.factoring.reference)})` : ""}. ${said}${d.factoring.remitTo ? ` Remit to: ${pdfSafe(d.factoring.remitTo)}.` : " The factor's remit-to address is not on file: ask the factor before paying."} This notice replaces any earlier copy of invoice ${pdfSafe(d.number)}, which named the carrier as the payee.`;
    const lines = wrap(noa, font, 9, PAGE_W - 2 * M - 16);
    const h = lines.length * 12 + 12;
    ensure(h + 10);
    page.drawRectangle({ x: M, y: y - h + 9, width: PAGE_W - 2 * M, height: h, borderColor: INK, borderWidth: 1 });
    y -= 4;
    for (const l of lines) {
      text(l, M + 8, 9, l.startsWith("NOTICE") ? bold : font);
      y -= 12;
    }
    y -= 14;
  }

  // Lines, one section per load (rule G), then the invoice's own lines.
  const amountX = PAGE_W - M;
  const lineRow = (label: string, amount: number) => {
    const ls = wrap(label, font, 10, PAGE_W - 2 * M - 110);
    ensure(ls.length * 13 + 4);
    ls.forEach((l, i) => {
      text(l, M + 10, 10);
      if (i === 0) right(usdText(amount), amountX, 10);
      y -= 13;
    });
  };
  for (const l of d.loads) {
    ensure(48);
    rule(y + 10, RULE);
    const head = [l.loadNumber ? `Load ${l.loadNumber}` : "Load", l.po ? `PO ${l.po}` : null].filter(Boolean).join(" | ");
    text(head, M, 10, bold);
    y -= 13;
    const where = [l.origin && l.destination ? `${l.origin} to ${l.destination}` : l.origin ?? l.destination, l.pickedUp ? `Picked up ${l.pickedUp}` : null, l.delivered ? `Delivered ${l.delivered}` : null].filter(Boolean).join(" | ");
    for (const w of wrap(where, font, 9, PAGE_W - 2 * M)) {
      text(w, M, 9, font, DIM);
      y -= 12;
    }
    if (l.refs.length > 0) {
      for (const w of wrap(`References: ${l.refs.join(", ")}`, font, 9, PAGE_W - 2 * M)) {
        text(w, M, 9, font, DIM);
        y -= 12;
      }
    }
    y -= 2;
    for (const x of l.lines) lineRow(x.label, x.amount);
    y -= 6;
  }
  if (d.invoiceLines.length > 0) {
    ensure(30);
    rule(y + 10, RULE);
    for (const x of d.invoiceLines) lineRow(x.label, x.amount);
    y -= 6;
  }

  // Totals.
  ensure(80);
  rule(y + 6, INK);
  y -= 10;
  const total = (label: string, amount: number, strong = false) => {
    right(usdText(amount), amountX, strong ? 12 : 10, strong ? bold : font);
    right(label, amountX - (strong ? bold : font).widthOfTextAtSize(usdText(amount), strong ? 12 : 10) - 16, strong ? 12 : 10, strong ? bold : font, strong ? INK : DIM);
    y -= strong ? 16 : 13;
  };
  total(d.kind === "credit_memo" ? "Credit" : "Total", d.total, d.kind === "credit_memo");
  if (d.kind === "invoice") {
    if (d.received > 0) total("Received", -d.received);
    if (d.credited > 0) total("Credited", -d.credited);
    total(d.status === "Void" ? "Void" : "Balance due", d.balance, true);
  }
  y -= 10;

  // Remit to: the factor's when factored (rule C), else the carrier's own.
  const remit = d.factoring ? d.factoring.remitTo ?? `${d.factoring.factor} (address from the factor)` : d.issuer.remitTo;
  if (remit || d.issuer.paymentNote) {
    ensure(40);
    text("REMIT TO", M, 8, bold, DIM);
    y -= 13;
    for (const w of wrap(remit ?? d.issuer.name, font, 10, PAGE_W - 2 * M)) {
      text(w, M, 10);
      y -= 13;
    }
    if (d.issuer.paymentNote && !d.factoring) {
      for (const w of wrap(d.issuer.paymentNote, font, 9, PAGE_W - 2 * M)) {
        text(w, M, 9, font, DIM);
        y -= 12;
      }
    }
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = `${pdfSafe(d.number)} | Page ${i + 1} of ${pages.length}`;
    p.drawText(s, { x: PAGE_W - M - font.widthOfTextAtSize(s, 8), y: M - 20, size: 8, font, color: DIM });
  });
  return doc.save();
}
