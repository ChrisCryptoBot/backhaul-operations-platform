import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getInvoice } from "@/server/tl/invoicing";
import { factoringLabel, getFactoringView } from "@/server/partners/factoring";
import { FactorPanel } from "@/components/desk/partner-actions";
import { CopyText } from "@/components/desk/copy-text";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { reminderText } from "@/lib/invoicing";
import { DocHead } from "@/components/desk/doc-head";
import { paidMethodLabel } from "@/lib/pay-method";
import { dateTime, miles, shortDate, usd } from "@/lib/desk-format";

export const dynamic = "force-dynamic";

/**
 * One invoice as it was billed, on a sheet that prints cleanly or saves as a PDF. It shows the lines the invoice kept, who it is for, the load
 * it came from and each stop, so the broker's accounts team has what it needs to pay it. Nothing is sent from here: when it is past due, the
 * reminder is written and ready to copy into the dispatcher's own email.
 */
export default async function InvoicePage({ params }: { params: { id: string } }) {
  const inv = await getInvoice(params.id);
  if (!inv) notFound();
  const factoring = await getFactoringView(params.id);
  const now = new Date();
  const overdue = inv.status === "invoiced" && inv.due.getTime() < now.getTime();
  const short = inv.status === "paid" && inv.paidAmount != null ? Math.round((inv.total - inv.paidAmount) * 100) / 100 : 0;

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "flex-start" }}>
        <Link href="/invoices" className="tl-btn">All invoices</Link>
        <Link href={`/loads/${inv.id}`} className="tl-btn">Open the load</Link>
        <PrintButton />
        {overdue ? <CopyText size="md" label="Copy reminder" text={reminderText({ broker: inv.billTo.name, invoiceNumber: inv.invoiceNumber, loadNumber: inv.load.number, poNumber: inv.poNumber, amount: inv.total, sent: inv.sent, due: inv.due, now, origin: inv.load.origin, destination: inv.load.destination })} /> : null}
      </div>
      {factoring ? <FactorPanel info={{ loadId: factoring.loadId, status: factoring.status, statusLabel: factoringLabel(factoring.status), referenceId: factoring.referenceId, manifest: factoring.manifest, missingOptional: factoring.missingOptional.length, blocked: factoring.blocked }} /> : null}
      <article className="rp">
        <DocHead
          kicker="Invoice"
          number={inv.invoiceNumber}
          company={inv.company}
          heroLabel={inv.status === "paid" ? "Invoiced" : "Total due"}
          hero={usd(inv.total, 2)}
          sub={`Due ${shortDate(inv.due)} · Net ${inv.terms}`}
          stamp={inv.status === "paid" ? { text: `Paid ${inv.paidAt ? shortDate(inv.paidAt) : ""}`.trim(), tone: "good" } : overdue ? { text: `Overdue ${Math.max(1, Math.floor((now.getTime() - inv.due.getTime()) / 86_400_000))} days`, tone: "bad" } : { text: `Due in ${Math.max(0, Math.ceil((inv.due.getTime() - now.getTime()) / 86_400_000))} days`, tone: "plain" }}
        />

        <h2>Bill to</h2>
        <p>
          <b>{inv.billTo.name ?? "—"}</b>
          {inv.billTo.mc ? ` · MC ${inv.billTo.mc}` : ""}
        </p>
        {inv.billTo.email || inv.billTo.phone ? <p className="rp-meta">{[inv.billTo.email, inv.billTo.phone].filter(Boolean).join(" · ")}</p> : null}

        <table style={{ marginTop: 14 }} aria-label="Invoice details">
          <tbody>
            <tr>
              <th>Invoice date</th>
              <td>{shortDate(inv.sent)}</td>
              <th>Terms</th>
              <td>Net {inv.terms}</td>
              <th>Due</th>
              <td>
                <b>{shortDate(inv.due)}</b>
              </td>
            </tr>
            <tr>
              <th>Load</th>
              <td>{inv.load.number ?? "—"}</td>
              <th>PO</th>
              <td>{inv.load.po ?? "—"}</td>
              <th>Delivered</th>
              <td>{inv.load.delivered ? shortDate(inv.load.delivered) : "—"}</td>
            </tr>
          </tbody>
        </table>

        <h2>Charges</h2>
        <table aria-label="Charges">
          <thead>
            <tr>
              <th>Description</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {inv.lines.map((l) => (
              <tr key={l.label}>
                <td>{l.label}</td>
                <td className="num">{usd(l.amount, 2)}</td>
              </tr>
            ))}
            <tr>
              <td>
                <b>Total due</b>
              </td>
              <td className="num">
                <b>{usd(inv.total, 2)}</b>
              </td>
            </tr>
          </tbody>
        </table>

        <h2>The load</h2>
        <p>
          {inv.load.origin ?? "?"} to {inv.load.destination ?? "?"}
          {inv.load.miles > 0 ? ` · ${miles(inv.load.miles)} loaded` : ""}
        </p>
        <table style={{ marginTop: 8 }} aria-label="Loads on this invoice">
          <thead>
            <tr>
              <th>Stop</th>
              <th>Place</th>
              <th>Arrived</th>
              <th>References</th>
            </tr>
          </thead>
          <tbody>
            {inv.stops.map((s) => (
              <tr key={s.sequence}>
                <td style={{ textTransform: "capitalize" }}>
                  {s.sequence}. {s.role}
                </td>
                <td>
                  {s.name ?? s.address}
                  <div className="rp-meta">{s.address}</div>
                </td>
                <td>{s.arrived ? dateTime(s.arrived) : "—"}</td>
                <td>{s.refs.length > 0 ? s.refs.join(", ") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {inv.load.closedWithoutPod ? <p className="rp-meta" style={{ marginTop: 8 }}>Proof of delivery: none, {inv.load.podNote ?? "no reason given"}.</p> : inv.load.podNote ? <p className="rp-meta" style={{ marginTop: 8 }}>Proof of delivery: {inv.load.podNote}.</p> : null}

        {inv.status === "paid" ? (
          <>
            <h2>Payment</h2>
            <p>
              Paid {inv.paidAt ? shortDate(inv.paidAt) : ""}
              {inv.paidMethod ? ` by ${paidMethodLabel(inv.paidMethod).toLowerCase()}` : ""}: <b>{usd(inv.paidAmount, 2)}</b>
              {short > 0 ? <span className="rp-bad"> · {usd(short, 2)} short of the invoice</span> : short < 0 ? <span> · {usd(Math.abs(short), 2)} over the invoice</span> : <span className="rp-good"> · paid in full</span>}
            </p>
          </>
        ) : null}

        {inv.status !== "paid" && (inv.company.remitTo || inv.company.paymentNote) ? (
          <>
            <h2>How to pay</h2>
            {inv.company.remitTo ? <p style={{ whiteSpace: "pre-line" }}>Remit payment to: {inv.company.remitTo}</p> : null}
            {inv.company.paymentNote ? <p className="rp-meta" style={{ whiteSpace: "pre-line" }}>{inv.company.paymentNote}</p> : null}
          </>
        ) : null}

        <p className="rp-foot">Prepared {dateTime(now)}.</p>
      </article>
    </>
  );
}
