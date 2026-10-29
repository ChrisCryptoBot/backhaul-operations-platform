// VENDORED from TrueLane lib/invoice.ts @ a3a9c0f4. Do not edit; run scripts/vendor-truelane.mjs.
/**
 * Broker invoice PDF (session 1 payment loop).
 *
 * Broker-facing document: FROM identity, BILL TO, load #, route, linehaul + FSC, terms, due date.
 * Not a delivery confirmation — do not import buildReceiptHtml. Owner-op internal metrics
 * must never appear in the HTML.
 */

import { addCalendarDays, calendarDaysBetween } from '@/truelane/lib/domain/calendarDays';

/** Structural load view so the builder is node-testable without WatermelonDB. */
export type InvoiceLoadView = {
  brokerName: string | null;
  brokerMcNumber: string | null;
  loadNumber: string | null;
  originAddress: string | null;
  destinationAddress: string | null;
  quotedRevenue: number;
  fuelSurcharge: number | null;
  payTermsDays: number | null;
  paymentTerms: string | null;
  poNumber?: string | null;
};

export type BuildInvoiceOptions = {
  invoicedAt: number;
  /** Printed invoice number (D1). Falls back to the load # for older callers. */
  invoiceNumber?: string | null;
  /** How the broker reaches you. */
  fromEmail?: string | null;
  fromPhone?: string | null;
  /** When the last delivery was marked done. */
  deliveredAt?: number | null;
  /** From Invoice details (D2a). */
  fromMcNumber?: string | null;
  fromDotNumber?: string | null;
  remitTo?: string | null;
  paymentNote?: string | null;
  /** Switched-on extra charges (D2b), printed as their own lines and added to the total. */
  extraCharges?: { label: string; amount: number }[];
  /** Delivery photos, one page each, after the invoice (D2c). */
  podPages?: PodPage[];
};

/** Outstanding AR (session 2). Distinct from InvoiceLoadView so the PDF builder stays broker-facing. */
export type AgingLoadView = {
  paymentStatus: string | null;
  invoicedAt: number | null;
  payTermsDays: number | null;
  quotedRevenue: number;
  fuelSurcharge: number | null;
  /** Total due on the invoice that was sent (v44). Null on loads invoiced before it was stored. */
  invoicedAmount?: number | null;
};

export type AgingSummary = {
  count: number;
  totalOutstanding: number;
  /** How many outstanding invoices are past their due date. */
  overdueCount: number;
  /** Days past due for the most overdue invoice; null when none is past due. */
  oldestDaysOverdue: number | null;
  /** When none is past due: calendar days until the soonest due date (0 = due today). Else null. */
  nextDueInDays: number | null;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatInvoiceDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** A fuel surcharge only counts when it prints as its own line (a positive amount). */
function billableFuelSurcharge(fsc: number | null | undefined): number {
  return typeof fsc === 'number' && Number.isFinite(fsc) && fsc > 0 ? fsc : 0;
}

/** Agreed rate + fuel surcharge, counted the same way the invoice prints them. */
export function invoiceRateTotal(load: Pick<InvoiceLoadView, 'quotedRevenue' | 'fuelSurcharge'>): number {
  const linehaul = Number.isFinite(load.quotedRevenue) ? load.quotedRevenue : 0;
  return linehaul + billableFuelSurcharge(load.fuelSurcharge);
}

/**
 * "Total due" on the invoice: rate + fuel surcharge + the switched-on extra charges, to the cent.
 * The PDF, the Review screen and the amount saved on "Yes, I sent it" all use this one sum.
 */
export function invoiceTotalDue(
  load: Pick<InvoiceLoadView, 'quotedRevenue' | 'fuelSurcharge'>,
  extraCharges: readonly { amount: number }[] = []
): number {
  const extras = extraCharges.reduce((s, c) => (Number.isFinite(c.amount) && c.amount > 0 ? s + c.amount : s), 0);
  return Math.round((invoiceRateTotal(load) + extras) * 100) / 100;
}

/**
 * What an invoiced load is owed: the total printed on the invoice that was sent (includes any
 * extra charges), else the agreed rate + fuel surcharge for loads invoiced before v44.
 */
export function invoiceBilledTotal(
  load: Pick<AgingLoadView, 'quotedRevenue' | 'fuelSurcharge' | 'invoicedAmount'>
): number {
  const billed = load.invoicedAmount;
  if (billed != null && Number.isFinite(billed) && billed > 0) return billed;
  return invoiceRateTotal(load);
}

/** Due date = invoice date + N calendar days (DST-safe). Null when terms aren't set. */
export function invoiceDueAtMs(invoicedAt: number, payTermsDays: number | null): number | null {
  if (payTermsDays == null || !Number.isFinite(payTermsDays) || payTermsDays < 0) return null;
  return addCalendarDays(invoicedAt, payTermsDays);
}

/**
 * Aging due date: net-0 when payTermsDays is null (due on invoicedAt). Null when the invoice date
 * is missing (a row synced without it) — never age it from 1970. Not used by the PDF.
 */
export function agingDueAtMs(invoicedAt: number | null, payTermsDays: number | null): number | null {
  if (invoicedAt == null || !Number.isFinite(invoicedAt)) return null;
  return addCalendarDays(invoicedAt, payTermsDays != null && Number.isFinite(payTermsDays) ? payTermsDays : 0);
}

/** The outstanding list, oldest due date first; undated invoices last. New array. */
export function sortByDueDate<T extends Pick<AgingLoadView, 'invoicedAt' | 'payTermsDays'>>(loads: readonly T[]): T[] {
  const due = (l: T) => agingDueAtMs(l.invoicedAt, l.payTermsDays) ?? Number.POSITIVE_INFINITY;
  return [...loads].sort((a, b) => {
    const da = due(a);
    const db = due(b);
    return da === db ? 0 : da - db;
  });
}

/**
 * Outstanding invoices for the ARCHIVE summary. Ignores paid / unpaid / TONU-without-invoice.
 * Days are calendar days: an invoice is overdue the day after its due date, not the hour after.
 * An invoice with no invoice date counts toward the money owed but not toward the days.
 * `nowMs` is injectable so tests can freeze the clock.
 */
export function computeAgingSummary(
  loads: AgingLoadView[],
  nowMs: number = Date.now()
): AgingSummary {
  const outstanding = loads.filter((l) => l.paymentStatus === 'invoiced');
  if (outstanding.length === 0) {
    return { count: 0, totalOutstanding: 0, overdueCount: 0, oldestDaysOverdue: null, nextDueInDays: null };
  }
  let totalOutstanding = 0;
  let overdueCount = 0;
  let mostDaysPast: number | null = null;
  for (const l of outstanding) {
    totalOutstanding += invoiceBilledTotal(l);
    const due = agingDueAtMs(l.invoicedAt, l.payTermsDays);
    if (due == null) continue;
    const daysPast = calendarDaysBetween(due, nowMs);
    if (daysPast > 0) overdueCount++;
    if (mostDaysPast == null || daysPast > mostDaysPast) mostDaysPast = daysPast;
  }
  return {
    count: outstanding.length,
    totalOutstanding: Math.round(totalOutstanding * 100) / 100,
    overdueCount,
    oldestDaysOverdue: overdueCount > 0 ? mostDaysPast : null,
    nextDueInDays: overdueCount > 0 || mostDaysPast == null ? null : Math.abs(mostDaysPast),
  };
}

/** "OUTSTANDING · 2 invoices · $3,700.00 · 1 overdue, oldest 12 days" / "… · due in 30 days". */
export function agingSummaryLine(summary: AgingSummary): string {
  const noun = summary.count === 1 ? 'invoice' : 'invoices';
  const head = `OUTSTANDING · ${summary.count} ${noun} · ${usd(summary.totalOutstanding)}`;
  const dayWord = (n: number) => (n === 1 ? '1 day' : `${n} days`);
  if (summary.oldestDaysOverdue != null) {
    if (summary.count === 1) return `${head} · ${dayWord(summary.oldestDaysOverdue)} overdue`;
    return `${head} · ${summary.overdueCount} overdue, oldest ${dayWord(summary.oldestDaysOverdue)}`;
  }
  if (summary.nextDueInDays == null) return head;
  const next = summary.nextDueInDays;
  const prefix = summary.count === 1 ? 'due' : 'next due';
  if (next === 0) return `${head} · ${prefix} today`;
  if (next === 1) return `${head} · ${prefix} tomorrow`;
  return `${head} · ${prefix} in ${next} days`;
}

function termsLabel(load: InvoiceLoadView): string {
  const parts: string[] = [];
  if (load.payTermsDays != null && Number.isFinite(load.payTermsDays)) {
    parts.push(load.payTermsDays === 0 ? 'Due on receipt' : `Net ${load.payTermsDays}`);
  }
  const verbatim = (load.paymentTerms ?? '').trim();
  if (verbatim) parts.push(verbatim);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** "$1,850.00" — manual grouping (no Intl dependency on Hermes). */
export function usd(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  const [whole, frac] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${n < 0 ? '-' : ''}$${grouped}.${frac}`;
}

/** The Mark Paid box: "$1,850.00" / "1850" → 1850. Blank, $0, negative or anything else → null. */
export function parsePaidAmount(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^(\d+(\.\d{0,2})?|\.\d{1,2})$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "INV-L-100" → "INV-L-100.pdf": the attachment name the broker sees instead of a random id. */
export function invoicePdfFileName(invoiceNumber: string | null | undefined): string {
  const safe = (invoiceNumber ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
  return `${safe || 'Invoice'}.pdf`;
}

function routeLabel(load: InvoiceLoadView): string {
  const origin = (load.originAddress ?? '').trim() || '—';
  const dest = (load.destinationAddress ?? '').trim() || '—';
  return `${origin} → ${dest}`;
}

/** One delivery-photo page appended after the invoice (D2c). */
export type PodPage = { label: string; dataUri: string };

const DATA_URI_RE = /^data:image\/(jpeg|png|webp|heic);base64,[A-Za-z0-9+/=]+$/;

/** Only well-formed base64 image data URIs are embedded — nothing else reaches an <img src>. */
export function isSafeImageDataUri(uri: string): boolean {
  return DATA_URI_RE.test(uri);
}

function lines(text: string | null | undefined): string {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map(escapeHtml)
    .join('<br>');
}

/**
 * Builds HTML for a broker invoice (D2c layout). `businessIdentity` is the FROM line
 * (resolveBusinessIdentity: businessName, else Clerk first+last). Letter size, prints in black
 * and white. Broker-facing only — no internal metrics.
 */
export function buildInvoiceHtml(
  load: InvoiceLoadView,
  businessIdentity: string,
  options: BuildInvoiceOptions
): string {
  const invoicedAt = options.invoicedAt;
  const loadNum = (load.loadNumber ?? '').trim() || '—';
  const from = businessIdentity.trim() || '—';
  const broker = (load.brokerName ?? '').trim() || '—';
  const mc = (load.brokerMcNumber ?? '').trim();
  const fsc = billableFuelSurcharge(load.fuelSurcharge);
  const linehaul = Number.isFinite(load.quotedRevenue) ? load.quotedRevenue : 0;
  const dueMs = invoiceDueAtMs(invoicedAt, load.payTermsDays);
  const invoiceNum = (options.invoiceNumber ?? '').trim() || loadNum;
  const po = (load.poNumber ?? '').trim();
  const fromMc = (options.fromMcNumber ?? '').trim();
  const fromDot = (options.fromDotNumber ?? '').trim();
  const remitTo = (options.remitTo ?? '').trim();
  const paymentNote = (options.paymentNote ?? '').trim();
  const email = (options.fromEmail ?? '').trim();
  const phone = (options.fromPhone ?? '').trim();

  const extras = (options.extraCharges ?? []).filter((c) => Number.isFinite(c.amount) && c.amount > 0);
  const total = invoiceTotalDue(load, extras);

  const authority = [fromMc ? `MC # ${escapeHtml(fromMc)}` : '', fromDot ? `USDOT # ${escapeHtml(fromDot)}` : '']
    .filter(Boolean)
    .join(' &nbsp;·&nbsp; ');
  const contact = [phone ? escapeHtml(phone) : '', email ? escapeHtml(email) : ''].filter(Boolean).join('<br>');

  const kv = (label: string, value: string) =>
    `<tr><td class="k">${escapeHtml(label)}</td><td class="v">${escapeHtml(value)}</td></tr>`;

  const metaRows = [
    kv('Invoice #', invoiceNum),
    kv('Invoice date', formatInvoiceDate(invoicedAt)),
    kv('Due date', dueMs != null ? formatInvoiceDate(dueMs) : '—'),
  ].join('');

  const loadRows = [
    kv('Load #', loadNum),
    po ? kv('PO #', po) : '',
    kv('Route', routeLabel(load)),
    options.deliveredAt != null ? kv('Delivered', formatInvoiceDate(options.deliveredAt)) : '',
  ].join('');

  const line = (label: string, amount: number) =>
    `<tr><td>${escapeHtml(label)}</td><td class="amt">${escapeHtml(usd(amount))}</td></tr>`;
  const lineRows = [
    line('Linehaul (agreed rate)', linehaul),
    fsc > 0 ? line('Fuel surcharge', fsc) : '',
    ...extras.map((c) => line(c.label, c.amount)),
  ].join('');

  const podPages = (options.podPages ?? [])
    .filter((pg) => isSafeImageDataUri(pg.dataUri))
    .map(
      (pg) => `
  <section class="pod">
    <h2>${escapeHtml(pg.label)}</h2>
    <p class="muted">Invoice # ${escapeHtml(invoiceNum)} &nbsp;·&nbsp; Load # ${escapeHtml(loadNum)}</p>
    <img src="${pg.dataUri}" alt="${escapeHtml(pg.label)}">
  </section>`
    )
    .join('');

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>INVOICE ${escapeHtml(invoiceNum)}</title>
  <style>
    @page { size: letter; margin: 0.6in; }
    body { font-family: -apple-system, system-ui, Helvetica, Arial, sans-serif; font-size: 12pt; color: #111; margin: 0; }
    .top { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
    .label { font-size: 9pt; letter-spacing: 1.5px; color: #555; margin: 0 0 4px; }
    .biz { font-size: 18pt; font-weight: 700; margin: 0 0 4px; }
    .muted { color: #555; font-size: 10pt; margin: 2px 0; }
    .title { font-size: 26pt; font-weight: 800; letter-spacing: 3px; margin: 0 0 8px; text-align: right; }
    table { border-collapse: collapse; }
    .meta td, .box td { padding: 3px 0; vertical-align: top; }
    .meta .k, .box .k { color: #555; padding-right: 16px; white-space: nowrap; }
    .meta .v { font-weight: 700; text-align: right; }
    .boxes { display: flex; gap: 24px; margin: 28px 0 20px; }
    .box { flex: 1; border: 1px solid #bbb; padding: 10px 12px; }
    .box .name { font-size: 13pt; font-weight: 700; margin: 0 0 4px; }
    .lines { width: 100%; margin-top: 8px; }
    .lines th { text-align: left; font-size: 9pt; letter-spacing: 1.5px; color: #555; text-transform: uppercase; border-bottom: 2px solid #111; padding: 6px 0; }
    .lines th.amt, .lines td.amt { text-align: right; }
    .lines td { padding: 8px 0; border-bottom: 1px solid #ddd; }
    .lines tr.total td { border-top: 2px solid #111; border-bottom: none; font-size: 14pt; font-weight: 800; padding-top: 10px; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    .pay { margin-top: 24px; border: 1px solid #bbb; padding: 10px 12px; break-inside: avoid; page-break-inside: avoid; }
    .thanks { margin-top: 28px; color: #555; font-size: 10pt; text-align: center; }
    .pod { page-break-before: always; break-before: page; }
    .pod h2 { font-size: 14pt; margin: 0 0 4px; }
    .pod img { display: block; max-width: 100%; max-height: 8.6in; margin-top: 12px; object-fit: contain; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <p class="label">FROM</p>
      <p class="biz">${escapeHtml(from)}</p>
      ${authority ? `<p class="muted">${authority}</p>` : ''}
      ${contact ? `<p class="muted">${contact}</p>` : ''}
    </div>
    <div>
      <p class="title">INVOICE</p>
      <table class="meta">${metaRows}</table>
    </div>
  </div>

  <div class="boxes">
    <div class="box">
      <p class="label">BILL TO</p>
      <p class="name">${escapeHtml(broker)}</p>
      ${mc ? `<p class="muted">MC# ${escapeHtml(mc)}</p>` : ''}
    </div>
    <div class="box">
      <p class="label">LOAD</p>
      <table>${loadRows}</table>
    </div>
  </div>

  <table class="lines">
    <thead><tr><th>Description</th><th class="amt">Amount</th></tr></thead>
    <tbody>
      ${lineRows}
      <tr class="total"><td>Total due</td><td class="amt">${escapeHtml(usd(total))}</td></tr>
    </tbody>
  </table>

  <div class="pay">
    <p class="label">PAYMENT</p>
    <p><strong>Terms:</strong> ${escapeHtml(termsLabel(load))}${dueMs != null ? ` &nbsp;·&nbsp; <strong>Due:</strong> ${escapeHtml(formatInvoiceDate(dueMs))}` : ''}</p>
    ${remitTo ? `<p><strong>Remit to:</strong><br>${lines(remitTo)}</p>` : ''}
    ${paymentNote ? `<p>${escapeHtml(paymentNote)}</p>` : ''}
    <p class="muted">Please include Invoice # ${escapeHtml(invoiceNum)} with your payment.</p>
  </div>

  <p class="thanks">Thank you for your business.</p>
  ${podPages}
</body>
</html>`;
}
