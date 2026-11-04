import { currentTerminal } from "@/server/tl/terminal";
import { dueAt, isOverdue, daysPastDue } from "@/lib/overdue";
import Link from "next/link";
import React from "react";
import { agingFor, asInvoiceShow, countInvoices, INVOICE_SHOWS, INVOICE_SORT_KEYS, listInvoiceRows, type InvoiceSort } from "@/server/tl/queries";
import { listHistory } from "@/server/tl/history";
import { ChaseActions } from "@/components/desk/chase-actions";
import { WaiveDetentionButton } from "@/components/desk/waive-detention";
import { ReadOnlyBanner } from "@/components/desk/kit/read-only";
import { asPage, asSort, nextSortParam } from "@/lib/paging";
import { reminderText } from "@/lib/invoicing";
import { checkAccess } from "@/server/tl/access";
import { can, whoCan } from "@/lib/roles";
import { Pager } from "@/components/desk/pager";
import { getDetentionRecovery } from "@/server/tl/detention";
import { factoringLabel } from "@/server/partners/factoring";
import { InvoiceDialog, PaidDialog } from "@/components/desk/load-actions";
import { Card, PageHead, Stat, Tabs } from "@/components/desk/ui";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { dayYear, usd } from "@/lib/desk-format";
import { spanText } from "@/lib/planner";
import { moneyState } from "@/lib/money-state";

export const metadata = { title: "Invoices · TrueLane" };

type Inv = Awaited<ReturnType<typeof listInvoiceRows>>[number];

const DETENTION: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 150 },
  { key: "broker", label: "Customer" },
  { key: "done", label: "Delivered" },
  { key: "waited", label: "Waited", align: "num" },
  { key: "billable", label: "Past free time", align: "num" },
  { key: "status", label: "Where it stands" },
  { key: "amount", label: "Still owed", align: "num" },
  { key: "act", label: "", align: "num" }
];
const READY: Column[] = [
  { key: "load", label: "Load", sticky: true, width: 150, sortable: true },
  { key: "lane", label: "Lane" },
  { key: "done", label: "Delivered", sortable: true },
  { key: "amount", label: "Amount", align: "num", sortable: true },
  { key: "act", label: "", align: "num" }
];
const OUT: Column[] = [
  { key: "invoice", label: "Invoice", sticky: true, width: 150, sortable: true },
  { key: "broker", label: "Customer", sortable: true },
  { key: "sent", label: "Sent", sortable: true },
  { key: "due", label: "Due", sortable: true },
  { key: "amount", label: "Owed", align: "num", sortable: true },
  { key: "act", label: "", align: "num" }
];
const PAID: Column[] = [
  { key: "invoice", label: "Invoice", sticky: true, width: 150, sortable: true },
  { key: "broker", label: "Customer", sortable: true },
  { key: "sent", label: "Sent", sortable: true },
  { key: "paid", label: "Paid", sortable: true },
  { key: "amount", label: "Received", align: "num", sortable: true }
];

const READY_PAGE = 25;
const OUT_PAGE = 50;
const PAID_PAGE = 50;
/** The detention card lists the largest amounts still owed; the total above it is for all of them. */
const DETENTION_SHOWN = 25;

type Params = { ready?: string; out?: string; paid?: string; q?: string; show?: string; readySort?: string; outSort?: string; paidSort?: string };

export default async function InvoicesPage({ searchParams }: { searchParams?: Params }) {
  // Each list is read on its own and a page at a time, because a fleet can have thousands waiting to be invoiced, out, or paid: the oldest first for what still needs
  // work, the newest first for what is paid. One search looks through all three, and a filter narrows what is out.
  const q = (searchParams?.q ?? "").trim();
  const show = asInvoiceShow(searchParams?.show);
  // The header's terminal narrows the invoices too (loads placed in that terminal, and loads not placed anywhere yet).
  const terminal = await currentTerminal();
  const access = await checkAccess("read");
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const canWriteOff = !!me && can(me.role, me.grants, "writeoff");
  // A column's sort comes from the address, per list, and is kept only if the list can sort by it.
  const sortOf = (v: string | undefined): InvoiceSort => (v ? asSort(v, INVOICE_SORT_KEYS, { key: "sent", dir: "asc" }) : null);
  const readySort = sortOf(searchParams?.readySort);
  const outSort = sortOf(searchParams?.outSort);
  const paidSort = sortOf(searchParams?.paidSort);
  const [readyTotal, outTotal, paidTotal, scopedAll, unscopedAll] = await Promise.all([
    countInvoices("ready", undefined, q, terminal),
    countInvoices("out", undefined, q, terminal, show),
    countInvoices("paid", undefined, q, terminal),
    terminal ? countInvoices("all", undefined, "", terminal) : Promise.resolve(0),
    terminal ? countInvoices("all", undefined, "", null) : Promise.resolve(0)
  ]);
  const hiddenByTerminal = terminal ? Math.max(0, unscopedAll - scopedAll) : 0;
  const pageOf = (param: string | undefined, total: number, size: number) => Math.min(asPage(param), Math.max(1, Math.ceil(total / size)));
  const readyPage = pageOf(searchParams?.ready, readyTotal, READY_PAGE);
  const outPage = pageOf(searchParams?.out, outTotal, OUT_PAGE);
  const paidPage = pageOf(searchParams?.paid, paidTotal, PAID_PAGE);
  const [toInvoice, open, paid, aging, detention, history] = await Promise.all([
    listInvoiceRows(undefined, { scope: "ready", q, terminal, sort: readySort, skip: (readyPage - 1) * READY_PAGE, take: READY_PAGE }),
    listInvoiceRows(undefined, { scope: "out", q, terminal, show, sort: outSort, skip: (outPage - 1) * OUT_PAGE, take: OUT_PAGE }),
    listInvoiceRows(undefined, { scope: "paid", q, terminal, sort: paidSort, skip: (paidPage - 1) * PAID_PAGE, take: PAID_PAGE }),
    agingFor(Date.now(), undefined, terminal),
    getDetentionRecovery(undefined, new Date(), terminal),
    // How this customer has treated the desk, when the search narrows to one (the Loads History computes it from the loads' own money columns).
    q ? listHistory({ q, pageSize: 1, terminal }) : Promise.resolve(null)
  ]);
  const href = (over: { ready?: number; out?: number; paid?: number; show?: string | null; q?: string } = {}) => {
    const u = new URLSearchParams();
    const pages = { ready: readyPage, out: outPage, paid: paidPage, ...over };
    for (const [k, v] of Object.entries({ ready: pages.ready, out: pages.out, paid: pages.paid })) if (v > 1) u.set(k, String(v));
    const text = over.q ?? q;
    if (text) u.set("q", text);
    const sh = "show" in over ? over.show : show;
    if (sh) u.set("show", sh);
    for (const [k, v] of [["readySort", searchParams?.readySort], ["outSort", searchParams?.outSort], ["paidSort", searchParams?.paidSort]] as const) if (v) u.set(k, v);
    const out = u.toString();
    return out ? `/invoices?${out}` : "/invoices";
  };
  // Where a column header goes, kept per list: ascending, then descending, then back to the list's own order.
  const sortLink = (param: "readySort" | "outSort" | "paidSort", current: InvoiceSort): SortHref => (key) => {
    const next = nextSortParam(current, key);
    const u = new URLSearchParams(href().split("?")[1] ?? "");
    u.delete(param);
    if (next) u.set(param, next);
    for (const k of ["ready", "out", "paid"]) u.delete(k);
    const out = u.toString();
    return { href: out ? `/invoices?${out}` : "/invoices", dir: current?.key === key ? current.dir : "none" };
  };
  const exportHref = (scope: "all" | "ready" | "out" | "paid", sortParam?: string) => {
    const u = new URLSearchParams();
    if (scope !== "all") u.set("scope", scope);
    if (q) u.set("q", q);
    if ((scope === "out" || scope === "all") && show) u.set("show", show);
    if (sortParam) u.set("sort", sortParam);
    const s = u.toString();
    return s ? `/export/invoices?${s}` : "/export/invoices";
  };
  const dueOf = (r: Inv) => dueAt(r.invoicedAt, r.payTermsDays);

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
        done: dayYear(r.completedAt),
        waited: spanText(r.totalWaitMinutes),
        billable: spanText(r.billableMinutes),
        status: r.noRate ? <span className="tl-chip muted">No detention rate on this truck</span> : r.invoiced ? <span className="tl-chip warn">Left off the invoice</span> : <span className="tl-chip info">Not invoiced yet</span>,
        amount: r.noRate ? <span className="dim">—</span> : usd(r.unbilled, 2),
        act: canBill && r.unbilled > 0 ? <WaiveDetentionButton loadId={r.loadId} loadNumber={r.loadNumber} amount={r.unbilled} /> : null
      }
    }));
  const readyRows: Row[] = toInvoice.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.loadNumber, r.broker, r.lane].filter(Boolean).join(" "),
    cells: {
      load: (<><Link href={`/loads/${r.id}`}>{r.loadNumber}</Link><span className="sub">{r.broker}</span></>),
      lane: r.lane,
      done: dayYear(r.completedAt),
      amount: (
        <>
          {usd(r.readyAmount, 2)}
          {r.detentionBillable > 0 ? <span className="sub">includes {usd(r.detentionBillable, 2)} detention</span> : null}
        </>
      ),
      act: canBill ? <InvoiceDialog loadId={r.id} loadNumber={r.loadNumber ?? "This load"} billTo={r.broker} defaults={{ number: r.defaultNumber }} context={r.invoiceContext} blockers={r.readiness.blockers} cautions={r.readiness.cautions} size="sm" /> : null
    }
  }));
  const outRows: Row[] = open.map((r) => {
    const due = dueOf(r);
    const now = new Date();
    const late = isOverdue(r.invoicedAt, r.payTermsDays, now);
    const lateDays = late ? (daysPastDue(r.invoicedAt, r.payTermsDays, now) ?? 1) : 0;
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
        sent: dayYear(r.invoicedAt),
        due: <span className={late ? "tone-neg" : ""}>{dayYear(due)}{late ? ` · ${lateDays} ${lateDays === 1 ? "day" : "days"} late` : ""}</span>,
        amount: (
          <>
            {usd(r.balance, 2)}
            {r.paidAmount != null && r.paidAmount > 0 ? <span className="sub">{moneyState({ paymentStatus: "invoiced", billed: r.amount, received: r.paidAmount, overdueDays: null }).detail}</span> : null}
          </>
        ),
        // The payment, and for a late one the chase: an email already written, or a call, remembered on the invoice. The invoice and its reminder open from its number.
        act: canBill ? (
          <>
            <PaidDialog loadId={r.id} invoiceNumber={r.invoiceNumber} billed={r.amount} owing={r.balance} canWriteOff={canWriteOff} size="sm" />
            {late && due ? (
              <ChaseActions
                loadId={r.id}
                email={r.brokerEmail}
                phone={r.brokerPhone}
                canChase={canBill}
                lastChased={r.lastChasedAt ? dayYear(r.lastChasedAt) : null}
                subject={`Payment status: invoice ${r.invoiceNumber ?? ""}${r.loadNumber ? ` (load ${r.loadNumber})` : ""}`}
                body={reminderText({ broker: r.broker, invoiceNumber: r.invoiceNumber, loadNumber: r.loadNumber, poNumber: r.poNumber, amount: r.balance, sent: r.invoicedAt ?? now, due, now, origin: r.origin, destination: r.destination })}
              />
            ) : r.lastChasedAt ? (
              <span className="sub">Last chased {dayYear(r.lastChasedAt)}</span>
            ) : null}
          </>
        ) : r.lastChasedAt ? (
          <span className="sub">Last chased {dayYear(r.lastChasedAt)}</span>
        ) : null
      }
    };
  });
  const paidRows: Row[] = paid.map((r) => ({
    id: r.id,
    href: `/loads/${r.id}`,
    search: [r.invoiceNumber, r.broker].filter(Boolean).join(" "),
    cells: {
      invoice: <Link href={`/invoices/${r.id}`}>{r.invoiceNumber}</Link>,
      broker: r.broker,
      sent: dayYear(r.invoicedAt),
      paid: dayYear(r.paidAt),
      amount: (
        <>
          {usd(r.paidAmount ?? r.amount, 2)}
          {(() => {
            const m = moneyState({ paymentStatus: "paid", billed: r.amount, received: r.paidAmount ?? r.amount, writeOffAmount: r.writeOffAmount, writeOffReason: r.writeOffReason });
            return m.detail ? <span className={`sub${m.tone === "bad" ? " tone-neg" : ""}`}>{m.label}: {m.detail}</span> : null;
          })()}
        </>
      )
    }
  }));

  const overdueSub =
    aging.overdueCount > 0
      ? `${aging.overdueCount} ${aging.overdueCount === 1 ? "invoice" : "invoices"}, oldest ${aging.oldestDaysOverdue} ${aging.oldestDaysOverdue === 1 ? "day" : "days"}`
      : aging.nextDueInDays === 0
        ? "none; next due today"
        : aging.nextDueInDays != null
          ? `none; next due in ${aging.nextDueInDays} ${aging.nextDueInDays === 1 ? "day" : "days"}`
          : "none";

  return (
    <>
      <PageHead title="Invoices" sub="Delivered loads that still need an invoice, what is out, and what has been paid.">
        <a className="tl-btn" href={exportHref("all")}>Export CSV</a>
      </PageHead>
      {!canBill ? <ReadOnlyBanner who={whoCan("bill")} what="invoices" /> : null}
      {terminal && hiddenByTerminal > 0 ? (
        <p className="tl-note" role="note" style={{ margin: "0 0 14px" }}>
          {hiddenByTerminal} {hiddenByTerminal === 1 ? "invoice or delivered load" : "invoices or delivered loads"} hidden by the <b>{terminal}</b> terminal filter.
        </p>
      ) : null}
      <div className="tl-grid cols-4">
        <Stat label="Outstanding" value={usd(aging.totalOutstanding)} sub={`${aging.count} ${aging.count === 1 ? "invoice" : "invoices"}`} />
        <Stat label="Overdue" value={usd(aging.overdueAmount)} tone={aging.overdueCount > 0 ? "bad" : undefined} sub={overdueSub} />
        <Stat label="Ready to invoice" value={String(readyTotal)} sub="delivered, not invoiced" />
        <Stat label="Paid" value={String(paidTotal)} />
      </div>

      {aging.count > 0 ? (
        <Card title="How late what is out is">
          <dl className="tl-kv" style={{ display: "flex", gap: 24, flexWrap: "wrap" }} aria-label="Aging">
            {([["Not yet due", aging.buckets.current], ["1 to 30 days", aging.buckets.d1_30], ["31 to 60 days", aging.buckets.d31_60], ["61 to 90 days", aging.buckets.d61_90], ["Over 90 days", aging.buckets.d90plus]] as const).map(([label, b]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  {usd(b.amount, 2)}
                  <span className="sub">{b.count} {b.count === 1 ? "invoice" : "invoices"}</span>
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      ) : null}
      <Card title={`Detention not yet billed, last 90 days · ${detention.unbilledLoads} ${detention.unbilledLoads === 1 ? "load" : "loads"} · ${usd(detention.totalUnbilled, 2)}`}>
        <DataTable
          id="inv-detention"
          label="Detention not yet billed"
          columns={DETENTION}
          rows={detentionRows}
          empty={<EmptyState icon="check" title="No detention is waiting to be billed">When a driver waits past the free time at a dock, it shows here until it is on an invoice or marked as waived.</EmptyState>}
        />
        {detentionOwed.length > detentionRows.length ? <p className="tl-note" style={{ marginTop: 8 }}>The {detentionRows.length} largest of {detentionOwed.length} loads are shown.</p> : null}
        {detention.totalBilled > 0 ? <p className="tl-note" style={{ marginTop: 8 }}>{usd(detention.totalBilled, 2)} of detention has already gone out on invoices.</p> : null}
      </Card>
      <DataTableTools tableId="inv-out" total={outTotal} placeholder="Search invoice, load, PO or customer, in all three lists…" server={{ path: "/invoices", q, keep: { ...(show ? { show } : {}), ...(searchParams?.readySort ? { readySort: searchParams.readySort } : {}), ...(searchParams?.outSort ? { outSort: searchParams.outSort } : {}), ...(searchParams?.paidSort ? { paidSort: searchParams.paidSort } : {}) } }} />
      {history?.record ? (
        <p className="tl-note" style={{ margin: "0 0 12px" }}>
          <b>{history.record.broker}</b>: {history.record.loads} {history.record.loads === 1 ? "load" : "loads"} finished, {history.record.invoices} invoiced, {history.record.paid} paid
          {history.record.averageDaysToPay != null ? ` in ${history.record.averageDaysToPay.toFixed(1)} days on average` : ""}
          {history.record.shortPaid > 0 ? `, ${history.record.shortPaid} paid short` : ""}
          {history.record.outstanding > 0 ? `, ${usd(history.record.outstanding, 2)} still out` : ""}.
        </p>
      ) : null}
      <Card title={`Ready to invoice · ${readyTotal}${q ? " matching" : ""}`} action={<a className="tl-btn ghost sm" href={exportHref("ready", searchParams?.readySort)}>Export Ready CSV</a>}>
        <DataTable id="inv-ready" label="Ready to invoice" columns={READY} rows={readyRows} sortHref={sortLink("readySort", readySort)} empty={<EmptyState icon="check" title={q ? "Nothing matches that" : "Every delivered load has an invoice"} />} />
        <Pager page={readyPage} pageSize={READY_PAGE} total={readyTotal} hrefFor={(n) => href({ ready: n })} newer="Previous" older="Next" />
      </Card>
      <Card title={`Out and waiting · ${outTotal}${q || show ? " matching" : ""}`} action={<a className="tl-btn ghost sm" href={exportHref("out", searchParams?.outSort)}>Export Out CSV</a>}>
        <Tabs label="Show" active={show ?? "all"} hrefFor={(k) => href({ show: k === "all" ? null : k, out: 1 })} items={[{ key: "all", label: "All" }, ...INVOICE_SHOWS]} />
        <DataTable id="inv-out" label="Out and waiting" columns={OUT} rows={outRows} sortHref={sortLink("outSort", outSort)} empty={<EmptyState icon="invoices" title={q || show ? "Nothing matches that" : "Nothing waiting on payment"} />} />
        <Pager page={outPage} pageSize={OUT_PAGE} total={outTotal} hrefFor={(n) => href({ out: n })} newer="Previous" older="Next" />
      </Card>
      <Card title={`Paid · ${paidTotal}${q ? " matching" : ""}`} action={<a className="tl-btn ghost sm" href={exportHref("paid", searchParams?.paidSort)}>Export Paid CSV</a>}>
        <DataTable id="inv-paid" label="Paid" columns={PAID} rows={paidRows} sortHref={sortLink("paidSort", paidSort)} empty={<EmptyState icon="invoices" title={q ? "Nothing matches that" : "No paid invoices yet"} />} />
        <Pager page={paidPage} pageSize={PAID_PAGE} total={paidTotal} hrefFor={(n) => href({ paid: n })} newer="Newer" older="Older" />
      </Card>
    </>
  );
}
