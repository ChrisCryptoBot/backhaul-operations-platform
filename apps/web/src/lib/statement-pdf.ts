import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { DEDUCTION_ROW_LABEL } from "./deductions";
import { classifyLine } from "./form1099";
import { pdfSafe, usdText, wrap } from "./invoice-pdf";
import { isNetPay, payNote, type Statement } from "./settlement";

/**
 * A driver's pay statement as a PDF (docs/MONEY_PLAN.md, Wave 4 step 6), made on the server as bytes (rule H): never a browser, never a disk file. The figures are the statement the page shows
 * (the same `Statement`, the same payNote / isNetPay), plus the driver's escrow held and advances owed today, and the year to date from the frozen rows of their finalized statements. US
 * Letter, Helvetica, black on white. Pure: data in, bytes out. `statementPdfModel` is what is drawn, so the totals can be checked without reading the PDF back.
 */
export type StatementYtd = {
  year: number;
  statements: number;
  /** Cents. Gross is the pay rows (loads and positive adjustments), the same rule as the 1099 (lib/form1099.ts). */
  grossCents: number;
  fuelCents: number;
  /** Negative adjustments (money taken off by hand). */
  adjustmentsOffCents: number;
  /** Deductions and escrow held. */
  deductionsCents: number;
  advancesRepaidCents: number;
  escrowReleasedCents: number;
  /** Receipts paid back: not pay. */
  reimbursedCents: number;
  netCents: number;
};

export type StatementPdfData = {
  number: string;
  status: "draft" | "final" | "void";
  issuer: { name: string; address: string | null; mc: string | null; dot: string | null; phone: string | null; email: string | null };
  driver: { name: string; code: string | null };
  periodLabel: string;
  finalizedOn: string | null;
  /** "Paid Nov 14, 2026 by check", "Sent to payroll Nov 13, 2026", or null. */
  payoutText: string | null;
  voidedOn: string | null;
  voidReason: string | null;
  statement: Pick<Statement, "lines" | "adjustments" | "fuel" | "deductions" | "loadsTotal" | "fuelTotal" | "adjustmentsTotal" | "deductionsTotal" | "total">;
  /** The driver's balances today (cents), and the day they are as of. */
  balances: { escrowHeldCents: number; advanceOwedCents: number; asOf: string };
  /** The year to date, or null when there is nothing finalized in the year yet. */
  ytd: StatementYtd | null;
};

/** The year to date from frozen statement rows: each row's kind and signed amount in cents. Net is every row; the rest split it, so they always add back up to net. */
export function ytdFromRows(year: number, statements: number, rows: ReadonlyArray<{ kind: string; cents: number }>): StatementYtd {
  const y: StatementYtd = { year, statements, grossCents: 0, fuelCents: 0, adjustmentsOffCents: 0, deductionsCents: 0, advancesRepaidCents: 0, escrowReleasedCents: 0, reimbursedCents: 0, netCents: 0 };
  for (const r of rows) {
    y.netCents += r.cents;
    if (classifyLine(r.kind, r.cents) === "gross") y.grossCents += r.cents;
    else if (r.kind === "fuel") y.fuelCents += r.cents;
    else if (r.kind === "adjustment") y.adjustmentsOffCents += r.cents;
    else if (r.kind === "deduction" || r.kind === "escrow") y.deductionsCents += r.cents;
    else if (r.kind === "advance_repaid") y.advancesRepaidCents += r.cents;
    else if (r.kind === "escrow_release") y.escrowReleasedCents += r.cents;
    else if (r.kind === "reimbursement") y.reimbursedCents += r.cents;
  }
  return y;
}

export type PdfRow = { label: string; detail: string | null; amount: number };
export type PdfSection = { title: string; rows: PdfRow[]; totalLabel: string; total: number };
export type StatementPdfModel = {
  title: string;
  stamp: { text: string; note: string } | null;
  sections: PdfSection[];
  summary: Array<{ label: string; amount: number }>;
  net: { label: string; amount: number; owes: boolean };
  note: string;
  balances: Array<{ label: string; amount: number }>;
  ytd: Array<{ label: string; amount: number | null; count?: number }>;
};

const c2d = (c: number) => c / 100;
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }) : null);

/** What the PDF says, in order. The same figures the statement page shows. */
export function statementPdfModel(d: StatementPdfData): StatementPdfModel {
  const st = d.statement;
  const net = isNetPay(st);
  const sections: PdfSection[] = [];
  if (st.lines.length > 0)
    sections.push({ title: "Loads", rows: st.lines.map((l) => ({ label: `${l.loadNumber ?? "Load"}, ${l.lane}`, detail: [l.deliveredAt ? `Delivered ${day(l.deliveredAt)}` : null, l.basis].filter(Boolean).join(" | "), amount: l.amount ?? 0 })), totalLabel: "Pay for loads", total: st.loadsTotal });
  if (st.fuel.length > 0)
    sections.push({ title: "Fuel card", rows: st.fuel.map((f) => ({ label: `Fuel card${f.location ? `, ${f.location}` : ""}`, detail: [f.on, f.loadNumber ? `load ${f.loadNumber}` : null, f.gallons != null ? `${f.gallons} gal` : null].filter(Boolean).join(" | "), amount: -f.amount })), totalLabel: "Fuel card", total: -st.fuelTotal });
  if (st.adjustments.length > 0) sections.push({ title: "Adjustments", rows: st.adjustments.map((a) => ({ label: a.label, detail: null, amount: a.amount })), totalLabel: "Adjustments", total: st.adjustmentsTotal });
  if (st.deductions.length > 0)
    sections.push({ title: "Deductions, escrow and advances", rows: st.deductions.map((x) => ({ label: x.label, detail: [DEDUCTION_ROW_LABEL[x.kind], x.kind === "escrow_release" ? x.basis : null].filter(Boolean).join(" | "), amount: x.amount })), totalLabel: "Deductions, escrow and advances", total: st.deductionsTotal });

  const summary = [{ label: "Pay for loads", amount: st.loadsTotal }];
  if (st.fuel.length > 0) summary.push({ label: "Fuel card", amount: -st.fuelTotal });
  summary.push({ label: "Adjustments", amount: st.adjustmentsTotal });
  if (st.deductions.length > 0) summary.push({ label: "Deductions, escrow and advances", amount: st.deductionsTotal });

  const y = d.ytd;
  return {
    title: `Pay statement ${d.number}`,
    stamp:
      d.status === "draft"
        ? { text: "DRAFT", note: "Not finalized: the figures can still change. Nothing is paid on a draft." }
        : d.status === "void"
          ? { text: "VOID", note: `Voided${d.voidedOn ? ` ${d.voidedOn}` : ""}${d.voidReason ? `: ${d.voidReason}` : ""}. This statement was taken back and is not paid.` }
          : null,
    sections,
    summary,
    net: { label: `${net ? "Net pay" : "Total"} to ${d.driver.name}`, amount: st.total, owes: st.total < 0 },
    note: `${payNote(st)} Taxes and payroll withholding are not worked out here.`,
    balances: [
      { label: "Escrow held for the driver", amount: c2d(d.balances.escrowHeldCents) },
      { label: "Advances still owed", amount: c2d(d.balances.advanceOwedCents) }
    ],
    ytd: y
      ? [
          { label: "Finalized statements", amount: null, count: y.statements },
          { label: "Gross pay (loads and bonuses)", amount: c2d(y.grossCents) },
          ...(y.fuelCents !== 0 ? [{ label: "Fuel card", amount: c2d(y.fuelCents) }] : []),
          ...(y.adjustmentsOffCents !== 0 ? [{ label: "Adjustments taken off", amount: c2d(y.adjustmentsOffCents) }] : []),
          ...(y.deductionsCents !== 0 ? [{ label: "Deductions and escrow held", amount: c2d(y.deductionsCents) }] : []),
          ...(y.advancesRepaidCents !== 0 ? [{ label: "Advances repaid", amount: c2d(y.advancesRepaidCents) }] : []),
          ...(y.escrowReleasedCents !== 0 ? [{ label: "Escrow released", amount: c2d(y.escrowReleasedCents) }] : []),
          ...(y.reimbursedCents !== 0 ? [{ label: "Receipts paid back", amount: c2d(y.reimbursedCents) }] : []),
          { label: "Net pay", amount: c2d(y.netCents) }
        ]
      : []
  };
}

const PAGE_W = 612;
const PAGE_H = 792;
const M = 48;
const INK = rgb(0.07, 0.07, 0.07);
const DIM = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.75, 0.75, 0.75);

export async function buildStatementPdf(d: StatementPdfData): Promise<Uint8Array> {
  const m = statementPdfModel(d);
  const doc = await PDFDocument.create();
  doc.setTitle(pdfSafe(`${m.title}${m.stamp ? ` (${m.stamp.text.toLowerCase()})` : ""}`));
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
  const stampOnPage = () => {
    if (!m.stamp) return;
    // Across every page, so no page of a draft or a voided statement can be passed off as a paid one.
    const s = m.stamp.text;
    page.drawText(s, { x: PAGE_W / 2 - bold.widthOfTextAtSize(s, 96) / 2 + 40, y: PAGE_H / 2 - 120, size: 96, font: bold, color: rgb(0.85, 0.85, 0.85), rotate: degrees(35), opacity: 0.5 });
  };
  const ensure = (needed: number) => {
    if (y - needed < M + 40) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      stampOnPage();
      y = PAGE_H - M;
      text(`${m.title} (continued)`, M, 9, font, DIM);
      y -= 20;
    }
  };
  stampOnPage();

  // Header: who it is from (left), what it is (right).
  text(d.issuer.name, M, 16, bold);
  right(m.stamp ? `PAY STATEMENT - ${m.stamp.text}` : "PAY STATEMENT", PAGE_W - M, 16, bold);
  y -= 18;
  const fromLines = [d.issuer.address, [d.issuer.mc ? `MC ${d.issuer.mc}` : null, d.issuer.dot ? `DOT ${d.issuer.dot}` : null].filter(Boolean).join(" | "), [d.issuer.phone, d.issuer.email].filter(Boolean).join(" | ")].filter((s): s is string => !!s);
  const meta: Array<[string, string]> = [
    ["Number", d.number],
    ["Paid to", d.driver.code ? `${d.driver.name} (${d.driver.code})` : d.driver.name],
    ["Period", d.periodLabel],
    ["Status", d.status === "draft" ? "Draft" : d.status === "void" ? "Void" : d.finalizedOn ? `Finalized ${d.finalizedOn}` : "Finalized"],
    ...(d.payoutText ? ([["Payout", d.payoutText]] as Array<[string, string]>) : [])
  ];
  for (let i = 0; i < Math.max(fromLines.length, meta.length); i++) {
    if (fromLines[i]) text(fromLines[i]!, M, 9, font, DIM);
    const r = meta[i];
    if (r) {
      right(r[1], PAGE_W - M, 9, bold);
      right(r[0], PAGE_W - M - bold.widthOfTextAtSize(pdfSafe(r[1]), 9) - 8, 9, font, DIM);
    }
    y -= 13;
  }
  y -= 6;
  if (m.stamp) {
    const lines = wrap(`${m.stamp.text}. ${m.stamp.note}`, bold, 10, PAGE_W - 2 * M - 16);
    const h = lines.length * 13 + 10;
    ensure(h + 10);
    page.drawRectangle({ x: M, y: y - h + 9, width: PAGE_W - 2 * M, height: h, borderColor: INK, borderWidth: 1.5 });
    y -= 3;
    for (const l of lines) {
      text(l, M + 8, 10, bold);
      y -= 13;
    }
    y -= 10;
  }
  rule(y);
  y -= 18;

  const amountX = PAGE_W - M;
  for (const s of m.sections) {
    ensure(40);
    text(s.title.toUpperCase(), M, 8, bold, DIM);
    y -= 14;
    for (const r of s.rows) {
      const ls = wrap(r.label, font, 10, PAGE_W - 2 * M - 110);
      const ds = r.detail ? wrap(r.detail, font, 8, PAGE_W - 2 * M - 110) : [];
      ensure(ls.length * 13 + ds.length * 11 + 2);
      ls.forEach((l, i) => {
        text(l, M + 10, 10);
        if (i === 0) right(usdText(r.amount), amountX, 10);
        y -= 13;
      });
      for (const dl of ds) {
        text(dl, M + 10, 8, font, DIM);
        y -= 11;
      }
    }
    rule(y + 9);
    right(usdText(s.total), amountX, 10, bold);
    right(s.totalLabel, amountX - bold.widthOfTextAtSize(usdText(s.total), 10) - 16, 10, bold, DIM);
    y -= 22;
  }
  if (m.sections.length === 0) {
    text("Nothing on this statement.", M, 10, font, DIM);
    y -= 20;
  }

  // The bottom line.
  ensure(40 + m.summary.length * 13);
  rule(y + 8, INK);
  y -= 8;
  if (m.summary.length > 1)
    for (const s of m.summary) {
      right(usdText(s.amount), amountX, 10);
      right(s.label, amountX - font.widthOfTextAtSize(usdText(s.amount), 10) - 16, 10, font, DIM);
      y -= 13;
    }
  right(usdText(m.net.amount), amountX, 13, bold);
  right(m.net.label, amountX - bold.widthOfTextAtSize(usdText(m.net.amount), 13) - 16, 13, bold);
  y -= 17;
  if (m.net.owes) {
    right(`The deductions come to more than the pay: ${d.driver.name} owes ${usdText(-m.net.amount)}.`, amountX, 9, bold);
    y -= 13;
  }
  for (const l of wrap(m.note, font, 8, PAGE_W - 2 * M)) {
    ensure(12);
    text(l, M, 8, font, DIM);
    y -= 11;
  }
  y -= 10;

  // Balances today, and the year to date.
  const two = (title: string, rows: Array<{ label: string; amount: number | null; count?: number }>) => {
    ensure(30 + rows.length * 13);
    text(title, M, 8, bold, DIM);
    y -= 14;
    for (const r of rows) {
      text(r.label, M + 10, 10);
      right(r.amount == null ? String(r.count ?? 0) : usdText(r.amount), amountX, 10, r.label === "Net pay" ? bold : font);
      y -= 13;
    }
    y -= 8;
  };
  two(`BALANCES AS OF ${pdfSafe(d.balances.asOf).toUpperCase()}`, m.balances);
  if (m.ytd.length > 0) two(`YEAR TO DATE, ${d.ytd!.year}${d.status === "final" ? " (FINALIZED STATEMENTS THROUGH THIS ONE)" : " (FINALIZED STATEMENTS, NOT COUNTING THIS ONE)"}`, m.ytd);
  else {
    ensure(20);
    text("No finalized statements in this calendar year yet.", M, 9, font, DIM);
    y -= 13;
  }

  const pages = doc.getPages();
  pages.forEach((p, i) => {
    const s = `${pdfSafe(d.number)}${m.stamp ? ` | ${m.stamp.text}` : ""} | Page ${i + 1} of ${pages.length}`;
    p.drawText(s, { x: PAGE_W - M - font.widthOfTextAtSize(s, 8), y: M - 20, size: 8, font, color: DIM });
  });
  return doc.save();
}
