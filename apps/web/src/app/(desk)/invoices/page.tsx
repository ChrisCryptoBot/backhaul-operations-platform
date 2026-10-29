import Link from "next/link";
import React from "react";
import { agingFor, listInvoiceRows } from "@/server/tl/queries";
import { getDetentionRecovery } from "@/server/tl/detention";
import { invoiceAction, markPaidAction } from "../actions";
import { PageHead, Stat } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { shortDate, usd } from "@/lib/desk-format";
import { spanText } from "@/lib/planner";

type Inv = Awaited<ReturnType<typeof listInvoiceRows>>[number];

const DETENTION: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 150 },
  { key: "broker", label: "Broker" },
  { key: "done", label: "Delivered" },
  { key: "waited", label: "Waited", align: "num" },
  { key: "billable", label: "Past free time", align: "num" },
  { key: "status", label: "Where it stands" },
  { key: "amount", label: "Still owed", align: "num" }
];
const READY: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 150 },
  { key: "lane", label: "Lane" },
  { key: "done", label: "Delivered" },
  { key: "amount", label: "Amount", align: "num" },
  { key: "act", label: "", align: "num" }
];
const OUT: Column[] = [
  { key: "invoice", label: "Invoice", sticky: true, width: 150 },
  { key: "broker", label: "Broker" },
  { key: "sent", label: "Sent" },
  { key: "due", label: "Due" },
  { key: "amount", label: "Amount", align: "num" },
  { key: "act", label: "", align: "num" }
];
const PAID: Column[] = [
  { key: "invoice", label: "Invoice", sticky: true, width: 150 },
  { key: "broker", label: "Broker" },
  { key: "sent", label: "Sent" },
  { key: "paid", label: "Paid" },
  { key: "amount", label: "Amount", align: "num" }
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontFamily: "var(--db-font-sans)", fontSize: "var(--db-text-xs)", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--db-fg-dim)", fontWeight: 700, margin: "0 0 10px" }}>{title}</h2>
      {children}
    </section>
  );
}

export default async function InvoicesPage() {
  const [all, aging, detention] = await Promise.all([listInvoiceRows(), agingFor(), getDetentionRecovery()]);
  const toInvoice = all.filter((r) => !r.status);
  const open = all.filter((r) => r.status === "invoiced");
  const paid = all.filter((r) => r.status === "paid");
  const dueOf = (r: Inv) => (r.invoicedAt ? new Date(r.invoicedAt.getTime() + (r.payTermsDays ?? 0) * 86_400_000) : null);

  const detentionRows: Row[] = detention.rows
    .filter((r) => r.unbilled > 0 || r.noRate)
    .map((r) => ({
      id: r.loadId,
      href: `/loads/${r.loadId}`,
      search: [r.loadNumber, r.broker].filter(Boolean).join(" "),
      cells: {
        load: (<><Link href={`/loads/${r.loadId}`}>{r.loadNumber}</Link><span className="sub">{r.lane}</span></>),
        broker: r.broker,
        done: shortDate(r.completedAt),
        waited: spanText(r.totalWaitMinutes),
        billable: spanText(r.billableMinutes),
        status: r.noRate ? <span className="tl-chip muted">No detention rate on this truck</span> : r.invoiced ? <span className="tl-chip warn">Left off the invoice</span> : <span className="tl-chip info">Not invoiced yet</span>,
        amount: r.noRate ? <span className="dim">—</span> : usd(r.unbilled, 2)
      }
    }));
  const readyRows: Row[] = toInvoice.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.loadNumber, r.broker, r.lane].filter(Boolean).join(" "),
    cells: {
      load: (<><Link href={`/loads/${r.id}`}>{r.loadNumber}</Link><span className="sub">{r.broker}</span></>),
      lane: r.lane,
      done: shortDate(r.completedAt),
      amount: usd(r.amount, 2),
      act: (<form action={invoiceAction}><input type="hidden" name="loadId" value={r.id} /><button className="tl-btn primary sm" type="submit">Create invoice</button></form>)
    }
  }));
  const outRows: Row[] = open.map((r) => {
    const due = dueOf(r);
    const late = due != null && due.getTime() < Date.now();
    return {
      id: r.id,
      href: `/loads/${r.id}`,
      flag: late ? "bad" : undefined,
      search: [r.invoiceNumber, r.broker].filter(Boolean).join(" "),
      cells: {
        invoice: <Link href={`/loads/${r.id}`}>{r.invoiceNumber}</Link>,
        broker: r.broker,
        sent: shortDate(r.invoicedAt),
        due: <span className={late ? "tone-neg" : ""}>{shortDate(due)}{late ? " · overdue" : ""}</span>,
        amount: usd(r.amount, 2),
        act: (<form action={markPaidAction}><input type="hidden" name="loadId" value={r.id} /><button className="tl-btn sm" type="submit">Mark paid</button></form>)
      }
    };
  });
  const paidRows: Row[] = paid.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.invoiceNumber, r.broker].filter(Boolean).join(" "),
    cells: { invoice: <Link href={`/loads/${r.id}`}>{r.invoiceNumber}</Link>, broker: r.broker, sent: shortDate(r.invoicedAt), paid: shortDate(r.paidAt), amount: usd(r.amount, 2) }
  }));

  return (
    <>
      <PageHead title="Invoices" sub="Delivered loads that still need an invoice, what is out, and what has been paid.">
        <a className="tl-btn" href="/export/invoices">Export CSV</a>
      </PageHead>
      <div className="tl-grid cols-4">
        <Stat label="Outstanding" value={usd(aging.totalOutstanding)} sub={`${aging.count} ${aging.count === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Overdue" value={String(aging.overdueCount)} tone={aging.overdueCount > 0 ? "bad" : undefined} sub={aging.oldestDaysOverdue != null ? `oldest ${aging.oldestDaysOverdue} days` : "none"} />
        <Stat label="Ready to invoice" value={String(toInvoice.length)} sub="delivered, not invoiced" />
        <Stat label="Paid" value={String(paid.length)} />
      </div>

      <Section title={`Detention not yet billed · ${detention.unbilledLoads} ${detention.unbilledLoads === 1 ? "load" : "loads"} · ${usd(detention.totalUnbilled, 2)}`}>
        <DataTable
          id="inv-detention"
          label="Detention not yet billed"
          columns={DETENTION}
          rows={detentionRows}
          empty={<EmptyState icon="check" title="No detention is waiting to be billed">When a driver waits past the free time at a dock, it shows here until it is on an invoice.</EmptyState>}
        />
        {detention.totalBilled > 0 ? <p className="tl-note" style={{ marginTop: 8 }}>{usd(detention.totalBilled, 2)} of detention has already gone out on invoices.</p> : null}
      </Section>
      <Section title={`Ready to invoice · ${toInvoice.length}`}>
        <DataTable id="inv-ready" label="Ready to invoice" columns={READY} rows={readyRows} empty={<EmptyState icon="check" title="Every delivered load has an invoice" />} />
      </Section>
      <Section title={`Out and waiting · ${open.length}`}>
        <DataTableTools tableId="inv-out" total={outRows.length} placeholder="Search invoice or broker…" />
        <DataTable id="inv-out" label="Out and waiting" columns={OUT} rows={outRows} empty={<EmptyState icon="invoices" title="Nothing waiting on payment" />} />
      </Section>
      <Section title={`Paid · ${paid.length}`}>
        <DataTable id="inv-paid" label="Paid" columns={PAID} rows={paidRows} empty={<EmptyState icon="invoices" title="No paid invoices yet" />} />
      </Section>
    </>
  );
}
