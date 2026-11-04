import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { ChaseActions } from "@/components/desk/chase-actions";
import { CopyText } from "@/components/desk/copy-text";
import { DocHead } from "@/components/desk/doc-head";
import { ReadOnlyBanner } from "@/components/desk/kit/read-only";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { FactorPanel } from "@/components/desk/partner-actions";
import { dateTime, dayYear, miles, shortDate, usd } from "@/lib/desk-format";
import { reminderText, termsLabel } from "@/lib/invoicing";
import { moneyState } from "@/lib/money-state";
import { daysPastDue, isOverdue } from "@/lib/overdue";
import { paidMethodLabel } from "@/lib/pay-method";
import { can, whoCan } from "@/lib/roles";
import { factoringLabel, getFactoringView } from "@/server/partners/factoring";
import { checkAccess } from "@/server/tl/access";
import { getInvoice } from "@/server/tl/invoicing";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const terminal = await currentTerminal();
  const inv = await getInvoice(params.id, undefined, terminal);
  return { title: inv?.invoiceNumber ?? "Invoice · TrueLane" };
}

/**
 * One invoice as it was billed, on a sheet that prints cleanly or saves as a PDF. It shows the lines the invoice kept, who it is for, the load
 * it came from and each stop, so the broker's accounts team has what it needs to pay it. Nothing is sent from here: when it is past due, the
 * reminder is written and ready to copy into the dispatcher's own email.
 */
export default async function InvoicePage({ params }: { params: { id: string } }) {
  const terminal = await currentTerminal();
  const [inv, factoring, access] = await Promise.all([
    getInvoice(params.id, undefined, terminal),
    getFactoringView(params.id),
    checkAccess("read")
  ]);
  if (!inv) notFound();
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const now = new Date();
  const overdue = inv.status === "invoiced" && isOverdue(inv.sent, inv.terms, now);
  const pastDue = daysPastDue(inv.sent, inv.terms, now) ?? 0;
  const daysLeft = Math.max(0, -pastDue);
  const stamp =
    inv.status === "paid"
      ? { text: `Paid ${inv.paidAt ? shortDate(inv.paidAt) : ""}`.trim(), tone: "good" as const }
      : overdue
        ? { text: `Overdue ${Math.max(1, pastDue)} ${Math.max(1, pastDue) === 1 ? "day" : "days"}`, tone: "bad" as const }
        : { text: daysLeft === 0 ? "Due today" : `Due in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`, tone: "plain" as const };
  const reminder = reminderText({
    broker: inv.billTo.name,
    invoiceNumber: inv.invoiceNumber,
    loadNumber: inv.load.number,
    poNumber: inv.poNumber,
    amount: inv.status === "invoiced" ? inv.balance : inv.total,
    sent: inv.sent,
    due: inv.due,
    now,
    origin: inv.load.origin,
    destination: inv.load.destination
  });

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16, alignItems: "center" }}>
        <Link href="/invoices" className="tl-btn">
          All invoices
        </Link>
        <Link href={`/loads/${inv.id}`} className="tl-btn">
          Open the load
        </Link>
        <PrintButton documentTitle={inv.invoiceNumber} />
        {overdue ? (
          <>
            <CopyText size="md" label="Copy reminder" text={reminder} />
            <ChaseActions
              loadId={inv.id}
              email={inv.billTo.email}
              phone={inv.billTo.phone}
              subject={`Invoice ${inv.invoiceNumber ?? ""} — past due`}
              body={reminder}
              lastChased={inv.lastChasedAt ? `${dayYear(inv.lastChasedAt)}${inv.lastChasedBy ? ` by ${inv.lastChasedBy}` : ""}` : null}
              canChase={canBill}
            />
          </>
        ) : null}
      </div>
      {!canBill ? <ReadOnlyBanner who={whoCan("bill")} what="this invoice" /> : null}
      {factoring ? (
        <FactorPanel
          info={{
            loadId: factoring.loadId,
            status: factoring.status,
            statusLabel: factoringLabel(factoring.status),
            referenceId: factoring.referenceId,
            manifest: factoring.manifest,
            missingOptional: factoring.missingOptional.length,
            blocked: factoring.blocked,
            paid: inv.status === "paid",
            canAct: canBill,
            who: whoCan("bill")
          }}
        />
      ) : null}
      <article className="rp">
        <DocHead
          kicker="Invoice"
          number={inv.invoiceNumber}
          company={inv.company}
          heroLabel={inv.status === "paid" ? "Invoiced" : inv.paidAmount != null && inv.paidAmount > 0 ? "Balance due" : "Total due"}
          hero={usd(inv.status === "paid" ? inv.total : inv.balance, 2)}
          sub={`${inv.status !== "paid" && inv.paidAmount != null && inv.paidAmount > 0 ? `of ${usd(inv.total, 2)}, ${usd(inv.paidAmount, 2)} received · ` : ""}Due ${shortDate(inv.due)} · ${termsLabel(inv.terms)}`}
          stamp={stamp}
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
              <td>{dayYear(inv.sent)}</td>
              <th>Terms</th>
              <td>{termsLabel(inv.terms)}</td>
              <th>Due</th>
              <td>
                <b>{dayYear(inv.due)}</b>
              </td>
            </tr>
            <tr>
              <th>Load</th>
              <td>{inv.load.number ?? "—"}</td>
              <th>PO</th>
              <td>{inv.load.po ?? "—"}</td>
              <th>Delivered</th>
              <td>{inv.load.delivered ? dayYear(inv.load.delivered) : "—"}</td>
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
            {inv.lines.map((l, i) => (
              <tr key={`${i}:${l.label}`}>
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
              Paid {inv.paidAt ? dayYear(inv.paidAt) : ""}
              {inv.paidMethod ? ` by ${paidMethodLabel(inv.paidMethod).toLowerCase()}` : ""}: <b>{usd(inv.paidAmount, 2)}</b>
              {(() => {
                const m = moneyState({ paymentStatus: "paid", billed: inv.total, received: inv.paidAmount ?? inv.total, writeOffAmount: inv.writeOffAmount, writeOffReason: inv.writeOffReason });
                return m.key === "paid" ? <span className="rp-good"> · paid in full</span> : <span className={m.tone === "bad" ? "rp-bad" : ""}> · {m.label.toLowerCase()}: {m.detail}</span>;
              })()}
            </p>
          </>
        ) : null}
        {inv.payments.length > 0 ? (
          <>
            <h2>{inv.status === "paid" ? "Payments received" : "Payments so far"}</h2>
            <table className="rp-table" aria-label="Payments received">
              <tbody>
                {inv.payments.map((p, i) => (
                  <tr key={i}>
                    <td>
                      {dayYear(p.paidAt)}
                      {p.method ? ` · ${paidMethodLabel(p.method).toLowerCase()}` : ""}
                    </td>
                    <td className="num">{usd(p.amount, 2)}</td>
                  </tr>
                ))}
                {inv.status === "invoiced" ? (
                  <tr>
                    <td>
                      <b>Still owed</b>
                    </td>
                    <td className="num">
                      <b>{usd(inv.balance, 2)}</b>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
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
