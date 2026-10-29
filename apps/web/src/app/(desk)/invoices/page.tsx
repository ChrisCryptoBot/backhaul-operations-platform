import Link from "next/link";
import React from "react";
import { agingFor, listInvoiceRows } from "@/server/tl/queries";
import { invoiceAction, markPaidAction } from "../actions";
import { Card, Empty, PageHead, Stat } from "@/components/desk/ui";
import { shortDate, usd } from "@/lib/desk-format";

export default async function InvoicesPage() {
  const [rows, aging] = await Promise.all([listInvoiceRows(), agingFor()]);
  const toInvoice = rows.filter((r) => !r.status);
  const open = rows.filter((r) => r.status === "invoiced");
  const paid = rows.filter((r) => r.status === "paid");
  const dueOf = (r: (typeof rows)[number]) => (r.invoicedAt ? new Date(r.invoicedAt.getTime() + (r.payTermsDays ?? 0) * 86_400_000) : null);

  return (
    <>
      <PageHead title="Invoices" sub="Delivered loads that still need an invoice, what is out, and what has been paid." />
      <div className="tl-grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Outstanding" value={usd(aging.totalOutstanding)} sub={`${aging.count} ${aging.count === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Overdue" value={String(aging.overdueCount)} tone={aging.overdueCount > 0 ? "bad" : undefined} sub={aging.oldestDaysOverdue != null ? `oldest ${aging.oldestDaysOverdue} days` : "none"} />
        <Stat label="Ready to invoice" value={String(toInvoice.length)} sub="delivered, not invoiced" />
        <Stat label="Paid" value={String(paid.length)} />
      </div>

      <Card title="Ready to invoice">
        {toInvoice.length === 0 ? (
          <Empty>Every delivered load has an invoice.</Empty>
        ) : (
          <table className="tl-table">
            <tbody>
              {toInvoice.map((r) => (
                <tr key={r.id}>
                  <td><Link href={`/loads/${r.id}`}>{r.loadNumber}</Link><div className="tl-sub">{r.broker}</div></td>
                  <td>{r.lane}</td>
                  <td>{shortDate(r.completedAt)}</td>
                  <td className="num">{usd(r.amount, 2)}</td>
                  <td className="num">
                    <form action={invoiceAction}><input type="hidden" name="loadId" value={r.id} /><button className="tl-btn primary" type="submit">Create invoice</button></form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Out and waiting" className="tl-card">
        {open.length === 0 ? (
          <Empty>Nothing waiting on payment.</Empty>
        ) : (
          <table className="tl-table">
            <thead><tr><th>Invoice</th><th>Broker</th><th>Sent</th><th>Due</th><th className="num">Amount</th><th /></tr></thead>
            <tbody>
              {open.map((r) => {
                const due = dueOf(r);
                const late = due != null && due.getTime() < Date.now();
                return (
                  <tr key={r.id}>
                    <td><Link href={`/loads/${r.id}`}>{r.invoiceNumber}</Link></td>
                    <td>{r.broker}</td>
                    <td>{shortDate(r.invoicedAt)}</td>
                    <td style={late ? { color: "var(--db-neg)" } : undefined}>{shortDate(due)}{late ? " · overdue" : ""}</td>
                    <td className="num">{usd(r.amount, 2)}</td>
                    <td className="num">
                      <form action={markPaidAction}><input type="hidden" name="loadId" value={r.id} /><button className="tl-btn" type="submit">Mark paid</button></form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
