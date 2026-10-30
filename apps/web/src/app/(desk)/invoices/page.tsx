import Link from "next/link";
import React from "react";
import { agingFor, countInvoices, listInvoiceRows } from "@/server/tl/queries";
import { Pager } from "@/components/desk/pager";
import { asPage } from "@/lib/paging";
import { getDetentionRecovery } from "@/server/tl/detention";
import { factoringLabel } from "@/server/partners/factoring";
import { InvoiceDialog, PaidDialog } from "@/components/desk/load-actions";
import { Card, PageHead, Stat } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { shortDate, usd } from "@/lib/desk-format";
import { spanText } from "@/lib/planner";

export const metadata = { title: "Invoices · TrueLane" };

type Inv = Awaited<ReturnType<typeof listInvoiceRows>>[number];

const DETENTION: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 150 },
  { key: "broker", label: "Customer" },
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
  { key: "broker", label: "Customer" },
  { key: "sent", label: "Sent" },
  { key: "due", label: "Due" },
  { key: "amount", label: "Amount", align: "num" },
  { key: "act", label: "", align: "num" }
];
const PAID: Column[] = [
  { key: "invoice", label: "Invoice", sticky: true, width: 150 },
  { key: "broker", label: "Customer" },
  { key: "sent", label: "Sent" },
  { key: "paid", label: "Paid" },
  { key: "amount", label: "Received", align: "num" }
];

const READY_PAGE = 25;
const OUT_PAGE = 50;
const PAID_PAGE = 50;
/** The detention card lists the largest amounts still owed; the total above it is for all of them. */
const DETENTION_SHOWN = 25;

export default async function InvoicesPage({ searchParams }: { searchParams?: { ready?: string; out?: string; paid?: string; q?: string } }) {
  // Each list is read on its own and a page at a time, because a fleet can have thousands waiting to be invoiced, out, or paid: the oldest first for what still needs
  // work, the newest first for what is paid. The search looks through what is out.
  const q = (searchParams?.q ?? "").trim();
  const [readyTotal, outTotal, paidTotal] = await Promise.all([countInvoices("ready"), countInvoices("out", undefined, q), countInvoices("paid")]);
  const pageOf = (param: string | undefined, total: number, size: number) => Math.min(asPage(param), Math.max(1, Math.ceil(total / size)));
  const readyPage = pageOf(searchParams?.ready, readyTotal, READY_PAGE);
  const outPage = pageOf(searchParams?.out, outTotal, OUT_PAGE);
  const paidPage = pageOf(searchParams?.paid, paidTotal, PAID_PAGE);
  const [toInvoice, open, paid, aging, detention] = await Promise.all([
    listInvoiceRows(undefined, { scope: "ready", skip: (readyPage - 1) * READY_PAGE, take: READY_PAGE }),
    listInvoiceRows(undefined, { scope: "out", q, skip: (outPage - 1) * OUT_PAGE, take: OUT_PAGE }),
    listInvoiceRows(undefined, { scope: "paid", skip: (paidPage - 1) * PAID_PAGE, take: PAID_PAGE }),
    agingFor(),
    getDetentionRecovery()
  ]);
  const href = (over: { ready?: number; out?: number; paid?: number }) => {
    const u = new URLSearchParams();
    const pages = { ready: readyPage, out: outPage, paid: paidPage, ...over };
    for (const [k, v] of Object.entries(pages)) if (v > 1) u.set(k, String(v));
    if (q) u.set("q", q);
    const s = u.toString();
    return s ? `/invoices?${s}` : "/invoices";
  };
  const dueOf = (r: Inv) => (r.invoicedAt ? new Date(r.invoicedAt.getTime() + (r.payTermsDays ?? 0) * 86_400_000) : null);

  const detentionOwed = detention.rows.filter((r) => r.unbilled > 0 || r.noRate);
  const detentionRows: Row[] = [...detentionOwed]
    .sort((a, b) => b.unbilled - a.unbilled)
    .slice(0, DETENTION_SHOWN)
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
      act: <InvoiceDialog loadId={r.id} loadNumber={r.loadNumber ?? "This load"} defaults={{ number: r.defaultNumber }} context={r.invoiceContext} blockers={r.readiness.blockers} cautions={r.readiness.cautions} size="sm" />
    }
  }));
  const outRows: Row[] = open.map((r) => {
    const due = dueOf(r);
    const now = new Date();
    const late = due != null && due.getTime() < now.getTime();
    return {
      id: r.id,
      href: `/loads/${r.id}`,
      flag: late ? "bad" : undefined,
      sort: { sent: r.invoicedAt?.getTime() ?? null, due: due?.getTime() ?? null },
      search: [r.invoiceNumber, r.broker, r.loadNumber, r.poNumber].filter(Boolean).join(" "),
      cells: {
        invoice: (
          <>
            <Link href={`/invoices/${r.id}`}>{r.invoiceNumber}</Link>
            <span className="sub">{r.loadNumber}{r.factoringStatus !== "none" ? <> · <span className="tl-chip info">{factoringLabel(r.factoringStatus)}</span></> : null}</span>
          </>
        ),
        broker: r.broker,
        sent: shortDate(r.invoicedAt),
        due: <span className={late ? "tone-neg" : ""}>{shortDate(due)}{late ? " · overdue" : ""}</span>,
        amount: usd(r.amount, 2),
        // One action: the payment. The invoice opens from its number, and the reminder for a late one is on that sheet.
        act: <PaidDialog loadId={r.id} invoiceNumber={r.invoiceNumber} billed={r.amount} size="sm" />
      }
    };
  });
  const paidRows: Row[] = paid.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.invoiceNumber, r.broker].filter(Boolean).join(" "),
    cells: {
      invoice: <Link href={`/loads/${r.id}`}>{r.invoiceNumber}</Link>,
      broker: r.broker,
      sent: shortDate(r.invoicedAt),
      paid: shortDate(r.paidAt),
      amount: (
        <>
          {usd(r.paidAmount ?? r.amount, 2)}
          {r.paidDifference != null && r.paidDifference < 0 ? <span className="sub tone-neg">{usd(Math.abs(r.paidDifference), 2)} short of {usd(r.amount, 2)}</span> : r.paidDifference != null && r.paidDifference > 0 ? <span className="sub">{usd(r.paidDifference, 2)} over</span> : null}
        </>
      )
    }
  }));

  return (
    <>
      <PageHead title="Invoices" sub="Delivered loads that still need an invoice, what is out, and what has been paid.">
        <a className="tl-btn" href="/export/invoices">Export CSV</a>
      </PageHead>
      <div className="tl-grid cols-4">
        <Stat label="Outstanding" value={usd(aging.totalOutstanding)} sub={`${aging.count} ${aging.count === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Overdue" value={String(aging.overdueCount)} tone={aging.overdueCount > 0 ? "bad" : undefined} sub={aging.oldestDaysOverdue != null ? `oldest ${aging.oldestDaysOverdue} days` : "none"} />
        <Stat label="Ready to invoice" value={String(readyTotal)} sub="delivered, not invoiced" />
        <Stat label="Paid" value={String(paidTotal)} />
      </div>

      <Card title={`Detention not yet billed, last 90 days · ${detention.unbilledLoads} ${detention.unbilledLoads === 1 ? "load" : "loads"} · ${usd(detention.totalUnbilled, 2)}`}>
        <DataTable
          id="inv-detention"
          label="Detention not yet billed"
          columns={DETENTION}
          rows={detentionRows}
          empty={<EmptyState icon="check" title="No detention is waiting to be billed">When a driver waits past the free time at a dock, it shows here until it is on an invoice.</EmptyState>}
        />
        {detentionOwed.length > detentionRows.length ? <p className="tl-note" style={{ marginTop: 8 }}>The {detentionRows.length} largest of {detentionOwed.length} loads are shown.</p> : null}
        {detention.totalBilled > 0 ? <p className="tl-note" style={{ marginTop: 8 }}>{usd(detention.totalBilled, 2)} of detention has already gone out on invoices.</p> : null}
      </Card>
      <Card title={`Ready to invoice · ${readyTotal}`}>
        <DataTable id="inv-ready" label="Ready to invoice" columns={READY} rows={readyRows} empty={<EmptyState icon="check" title="Every delivered load has an invoice" />} />
        <Pager page={readyPage} pageSize={READY_PAGE} total={readyTotal} hrefFor={(n) => href({ ready: n })} newer="Newer" older="Older" />
      </Card>
      <Card title={`Out and waiting · ${outTotal}${q ? " matching" : ""}`}>
        <DataTableTools tableId="inv-out" total={outTotal} placeholder="Search invoice, load, PO or customer…" server={{ path: "/invoices", q }} />
        <DataTable id="inv-out" label="Out and waiting" columns={OUT} rows={outRows} empty={<EmptyState icon="invoices" title={q ? "Nothing matches that" : "Nothing waiting on payment"} />} />
        <Pager page={outPage} pageSize={OUT_PAGE} total={outTotal} hrefFor={(n) => href({ out: n })} newer="Newer" older="Older" />
      </Card>
      <Card title={`Paid · ${paidTotal}`}>
        <DataTable id="inv-paid" label="Paid" columns={PAID} rows={paidRows} empty={<EmptyState icon="invoices" title="No paid invoices yet" />} />
        <Pager page={paidPage} pageSize={PAID_PAGE} total={paidTotal} hrefFor={(n) => href({ paid: n })} newer="Newer" older="Older" />
      </Card>
    </>
  );
}
