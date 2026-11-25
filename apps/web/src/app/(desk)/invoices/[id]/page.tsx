import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { Prisma } from "@prisma/client";
import { ChaseActions } from "@/components/desk/chase-actions";
import { CopyText } from "@/components/desk/copy-text";
import { DocHead } from "@/components/desk/doc-head";
import { ReadOnlyBanner } from "@/components/desk/kit/read-only";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { FactorPanel } from "@/components/desk/partner-actions";
import { CreditMemoDialog, VoidCreditButton } from "@/components/desk/credit-memo";
import { SupplementalDialog, VoidSupplementalButton } from "@/components/desk/supplemental-invoice";
import { ConfirmForm } from "@/components/desk/kit/confirm-form";
import { PaidDialog } from "@/components/desk/load-actions";
import { undoPaidAction, undoSupplementalPaymentAction } from "@/app/(desk)/actions";
import { dateTime, dayYear, miles, shortDate, usd } from "@/lib/desk-format";
import { reminderText, termsLabel } from "@/lib/invoicing";
import { moneyState } from "@/lib/money-state";
import { daysPastDue, isOverdue } from "@/lib/overdue";
import { paidMethodLabel } from "@/lib/pay-method";
import { can, whoCan } from "@/lib/roles";
import { factoringLabel, getFactoringView } from "@/server/partners/factoring";
import { checkAccess } from "@/server/tl/access";
import { unbilledDetentionOfLoad } from "@/server/tl/detention";
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
  const canWriteOff = !!me && can(me.role, me.grants, "writeoff");
  const canAdmin = !!me && can(me.role, me.grants, "admin");
  const isSupplemental = !!inv.supplementOf;
  const loadTargetId = inv.supplementOf?.loadId ?? inv.loads[0]?.id ?? null;
  const parentUnbilledDetention = !isSupplemental && canBill && inv.recordId && inv.loads.length === 1 ? await unbilledDetentionOfLoad(inv.loads[0]!.id) : 0;
  const now = new Date();
  const lastPayment = inv.payments[inv.payments.length - 1] ?? null;
  const loadWord = inv.loads.length > 1 ? `${inv.loads.length} loads` : "the load";
  const overdue = inv.status === "invoiced" && isOverdue(inv.sent, inv.terms, now);
  const pastDue = daysPastDue(inv.sent, inv.terms, now) ?? 0;
  const daysLeft = Math.max(0, -pastDue);
  const stamp =
    inv.status === "void"
      ? { text: inv.voidReason ? `Void · ${inv.voidReason}` : "Void", tone: "bad" as const }
      : inv.status === "paid"
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
        {inv.supplementOf ? (
          <Link href={`/invoices/${inv.supplementOf.loadId ?? inv.supplementOf.id}`} className="tl-btn">
            Parent {inv.supplementOf.number}
          </Link>
        ) : null}
        {loadTargetId ? (
          <Link href={`/loads/${loadTargetId}`} className="tl-btn">
            Open the load
          </Link>
        ) : null}
        <PrintButton documentTitle={inv.invoiceNumber} />
        {/* The PDF made on the server: the same file a factoring packet will carry (docs/MONEY_PLAN.md, rule H). */}
        <a href={`/invoices/${isSupplemental ? inv.recordId : inv.id}/pdf`} className="tl-btn" target="_blank" rel="noopener">
          PDF
        </a>
        {canBill && !isSupplemental && inv.recordId ? (
          <SupplementalDialog
            invoiceId={inv.recordId}
            invoiceNumber={inv.invoiceNumber}
            loadId={inv.loads[0]?.id ?? inv.id}
            unbilledDetention={parentUnbilledDetention}
            factored={!!factoring && factoring.status !== "none" && factoring.status !== "rejected"}
            size="sm"
          />
        ) : null}
        {canBill && inv.status === "invoiced" ? (
          <PaidDialog
            loadId={loadTargetId ?? inv.id}
            invoiceId={isSupplemental ? (inv.recordId ?? inv.id) : undefined}
            invoiceNumber={inv.invoiceNumber}
            billed={inv.total}
            owing={inv.balance}
            canWriteOff={canWriteOff}
            size="sm"
          />
        ) : null}
        {/* A credit on an invoice a factor has is the factor's to settle (server/tl/invoicing.ts refuses it), so it is not offered. */}
        {canBill && !isSupplemental && inv.status === "invoiced" && inv.recordId && inv.balance > 0 && !(factoring && ["requested", "submitted", "funded"].includes(factoring.status)) ? <CreditMemoDialog loadId={inv.id} invoiceNumber={inv.invoiceNumber} owingCents={new Prisma.Decimal(inv.balance).times(100).toDecimalPlaces(0).toNumber()} /> : null}
        {canAdmin && lastPayment && lastPayment.source !== "credit" ? (
          <ConfirmForm
            action={isSupplemental ? undoSupplementalPaymentAction : undoPaidAction}
            fields={isSupplemental ? { invoiceId: inv.id } : { loadId: inv.id }}
            label="Undo last payment"
            title={`Take back the latest payment on ${inv.invoiceNumber ?? "this invoice"}?`}
            eyebrow="Payment"
            confirmLabel="Take it back"
            destructive
            askReason>
            <p>The invoice goes back to owing what it did before that payment.</p>
          </ConfirmForm>
        ) : null}
        {canAdmin && isSupplemental && inv.status === "invoiced" && !(inv.paidAmount && inv.paidAmount > 0) ? (
          <VoidSupplementalButton invoiceId={inv.id} number={inv.invoiceNumber ?? ""} amount={inv.total} />
        ) : null}
        {overdue ? (
          <>
            <CopyText size="md" label="Copy reminder" text={reminder} />
            <ChaseActions
              loadId={loadTargetId ?? inv.id}
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
            who: whoCan("bill"),
            loadCount: factoring.loadCount,
            podPhotoOnly: factoring.podPhotoOnly,
            money: factoring.money,
            packetHref: canBill ? `/invoices/${inv.id}/packet` : undefined,
            scheduleHref: canBill ? `/invoices/schedule?loads=${inv.loads.map((x) => x.id).join(",")}` : undefined
          }}
        />
      ) : null}
      <article className="rp">
        <DocHead
          kicker={isSupplemental ? "Supplemental invoice" : "Invoice"}
          number={inv.invoiceNumber}
          company={inv.company}
          heroLabel={inv.status === "void" ? "Void" : inv.status === "paid" ? "Invoiced" : inv.paidAmount != null && inv.paidAmount > 0 ? "Balance due" : "Total due"}
          hero={usd(inv.status === "paid" || inv.status === "void" ? inv.total : inv.balance, 2)}
          sub={`${inv.supplementOf ? `Supplemental to ${inv.supplementOf.number} · ` : ""}${inv.status !== "paid" && inv.status !== "void" && inv.paidAmount != null && inv.paidAmount > 0 ? `of ${usd(inv.total, 2)}, ${usd(inv.paidAmount, 2)} ${inv.credits.some((c) => c.status === "paid") ? "received or credited" : "received"} · ` : ""}Due ${shortDate(inv.due)} · ${termsLabel(inv.terms)}`}
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
              <th>{inv.loads.length > 1 ? "Loads" : "Load"}</th>
              <td>{inv.loads.length > 1 ? inv.loads.map((x) => x.number ?? "—").join(", ") : (inv.load.number ?? "—")}</td>
              <th>PO</th>
              <td>{inv.loads.length > 1 ? (inv.loads.map((x) => x.po).filter(Boolean).join(", ") || "—") : (inv.load.po ?? "—")}</td>
              <th>Delivered</th>
              <td>{inv.loads.length > 1 ? (inv.loads.map((x) => (x.delivered ? shortDate(x.delivered) : "—")).join(", ")) : inv.load.delivered ? dayYear(inv.load.delivered) : "—"}</td>
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

        <h2>{inv.loads.length > 1 ? `The ${inv.loads.length} loads` : "The load"}</h2>
        {inv.loads.map((ld, n) => (
          <div key={ld.id} className={n > 0 ? "rp-gap" : undefined}>
            <p>
              {inv.loads.length > 1 ? <b>{ld.number ?? "Load"} · </b> : null}
              {ld.origin ?? "?"} to {ld.destination ?? "?"}
              {ld.miles > 0 ? ` · ${miles(ld.miles)} loaded` : ""}
            </p>
            <table className="rp-t8" aria-label={`Stops of ${ld.number ?? "the load"}`}>
              <thead>
                <tr>
                  <th>Stop</th>
                  <th>Place</th>
                  <th>Arrived</th>
                  <th>References</th>
                </tr>
              </thead>
              <tbody>
                {ld.stops.map((st) => (
                  <tr key={st.sequence}>
                    <td style={{ textTransform: "capitalize" }}>
                      {st.sequence}. {st.role}
                    </td>
                    <td>
                      {st.name ?? st.address}
                      <div className="rp-meta">{st.address}</div>
                    </td>
                    <td>{st.arrived ? dateTime(st.arrived) : "—"}</td>
                    <td>{st.refs.length > 0 ? st.refs.join(", ") : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {inv.loads.length === 1 && inv.load.closedWithoutPod ? <p className="rp-meta rp-t8">Proof of delivery: none, {inv.load.podNote ?? "no reason given"}.</p> : inv.loads.length === 1 && inv.load.podNote ? <p className="rp-meta rp-t8">Proof of delivery: {inv.load.podNote}.</p> : null}

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
                      {p.source === "credit" ? " · credit memo" : p.method ? ` · ${paidMethodLabel(p.method).toLowerCase()}` : ""}
                      {p.reference ? ` · ref ${p.reference}` : ""}
                      {p.payer ? ` · from ${p.payer}` : ""}
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

        {inv.credits.length > 0 ? (
          <>
            <h2>Credit memos</h2>
            <table className="rp-table" aria-label="Credit memos">
              <tbody>
                {inv.credits.map((c) => (
                  <tr key={c.id} className={c.status === "void" ? "rp-dim" : undefined}>
                    <td>
                      <b>{c.number}</b> · {dayYear(c.issuedAt)} · {c.label}
                      {c.status === "void" ? ` · void${c.voidReason ? `: ${c.voidReason}` : ""}` : c.reason ? <span className="rp-meta"> {c.reason}</span> : null}
                    </td>
                    <td className="num">{c.status === "void" ? <s>{usd(-c.amount, 2)}</s> : usd(-c.amount, 2)}</td>
                    <td className="num no-print">{canWriteOff && c.status !== "void" ? <VoidCreditButton memoId={c.id} number={c.number} amount={c.amount} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}

        {inv.supplementals.length > 0 ? (
          <>
            <h2>Supplemental invoices</h2>
            <table className="rp-table" aria-label="Supplemental invoices">
              <tbody>
                {inv.supplementals.map((s) => (
                  <tr key={s.id} className={s.status === "void" ? "rp-dim" : undefined}>
                    <td>
                      <Link href={`/invoices/${s.id}`}>
                        <b>{s.number}</b>
                      </Link>
                      {" · "}
                      {dayYear(s.issuedAt)} · {s.lines.map((l) => l.label).join(", ")}
                      {s.status === "void" ? ` · void${s.voidReason ? `: ${s.voidReason}` : ""}` : s.status === "paid" ? " · paid" : ` · open ${usd(s.balance, 2)}`}
                    </td>
                    <td className="num">{s.status === "void" ? <s>{usd(s.total, 2)}</s> : usd(s.total, 2)}</td>
                    <td className="num no-print">
                      <a href={`/invoices/${s.id}/pdf`} className="tl-btn sm" target="_blank" rel="noopener">
                        PDF
                      </a>{" "}
                      {canAdmin && s.status === "open" && s.paidTotal === 0 ? <VoidSupplementalButton invoiceId={s.id} number={s.number} amount={s.total} /> : null}
                    </td>
                  </tr>
                ))}
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
