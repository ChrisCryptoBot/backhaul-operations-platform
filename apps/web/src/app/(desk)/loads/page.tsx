import Link from "next/link";
import { redirect } from "next/navigation";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { AssignmentChip, PageHead, StatusChip, Tabs, VerdictChip } from "@/components/desk/ui";
import { AlertDot } from "@/components/desk/alert-bits";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { NewLoad } from "@/components/desk/new-load";
import { asBoardStatus, BOARD_STATUSES, filterBoard, isBelowCost, searchBoard } from "@/lib/board-filter";
import { reasonLabel } from "@/lib/disruptions";
import { asHistoryFilter, asHistorySort, fellThrough, HISTORY_FILTERS, HISTORY_SORTS, historyDate, historyRows, isHistory, isOpen, isOwed, monthGroups, payRecord } from "@/lib/loads-history";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";

const OPEN_FILTERS = BOARD_STATUSES.filter((s) => s.key !== "completed");

const COLUMNS: Column[] = [
  { key: "load", label: "Load", group: "Load", sticky: true, width: 150 },
  { key: "status", label: "Status", group: "Load", sticky: true, width: 150 },
  { key: "lane", label: "Lane", group: "Route" },
  { key: "pickup", label: "Pickup", group: "Route" },
  { key: "truck", label: "Truck", group: "Route" },
  { key: "miles", label: "Miles", group: "Route", align: "num" },
  { key: "pay", label: "Pay", group: "Money", accentBand: true, align: "num" },
  { key: "perMile", label: "$/mi", group: "Money", accentBand: true, align: "num" },
  { key: "floor", label: "Floor", group: "Money", accentBand: true, align: "num" },
  { key: "verdict", label: "Verdict", group: "Money", accentBand: true },
  { key: "driver", label: "Driver", group: "Dispatch" },
  { key: "assignment", label: "Answer", group: "Dispatch" }
];

const HISTORY_COLUMNS: Column[] = [
  { key: "load", label: "Load", group: "Load", sticky: true, width: 150 },
  { key: "status", label: "Status", group: "Load", sticky: true, width: 150 },
  { key: "lane", label: "Lane", group: "Route" },
  { key: "done", label: "Date", group: "Route" },
  { key: "truck", label: "Truck", group: "Route" },
  { key: "driver", label: "Driver", group: "Route" },
  { key: "pay", label: "Pay", group: "Money", accentBand: true, align: "num" },
  { key: "perMile", label: "$/mi", group: "Money", accentBand: true, align: "num" },
  { key: "money", label: "Where the money is", group: "Money", accentBand: true }
];

type Params = { view?: string; status?: string; flag?: string; q?: string; filter?: string; sort?: string };

export default async function LoadsPage({ searchParams }: { searchParams?: Params }) {
  const q = searchParams?.q?.trim() ?? "";
  // Delivered loads moved to History; an old link to the Delivered tab lands there.
  if (searchParams?.status === "completed") redirect(`/loads?view=history${q ? `&q=${encodeURIComponent(q)}` : ""}`);

  const [everything, { byLoad }] = await Promise.all([listBoardRows(), getAlerts()]);
  const view = searchParams?.view === "history" ? "history" : "open";
  const openAll = everything.filter((r) => isOpen(r.status));
  const historyAll = everything.filter((r) => isHistory(r.status));
  const openCount = searchBoard(openAll, q).length;
  const historyCount = historyRows(historyAll, { q }).length;

  const viewHref = (v: string) => {
    const p = new URLSearchParams();
    if (v === "history") p.set("view", "history");
    if (q) p.set("q", q);
    const s = p.toString();
    return s ? `/loads?${s}` : "/loads";
  };

  // The file is the list as it is on screen: the same view, tab, filter, sort and search.
  const exportParams = new URLSearchParams({ view });
  if (view === "history") {
    const f = asHistoryFilter(searchParams?.filter);
    const so = asHistorySort(searchParams?.sort);
    if (f !== "all") exportParams.set("filter", f);
    if (so !== "newest") exportParams.set("sort", so);
  } else {
    const st = asBoardStatus(searchParams?.status);
    if (st !== "all") exportParams.set("status", st);
    if (searchParams?.flag === "below") exportParams.set("flag", "below");
  }
  if (q) exportParams.set("q", q);
  const exportHref = `/export/loads?${exportParams.toString()}`;

  const head = (
    <PageHead title="Loads" sub={view === "open" ? "What is still moving, judged on each truck's own cost." : "What has finished, by month, with where the money is."}>
      <a className="tl-btn" href={exportHref}>Export CSV</a>
      <NewLoad />
    </PageHead>
  );
  const views = (
    <Tabs
      label="View"
      active={view}
      hrefFor={viewHref}
      items={[
        { key: "open", label: "Open", count: openCount },
        { key: "history", label: "History", count: historyCount }
      ]}
    />
  );

  if (view === "history") {
    const filter = asHistoryFilter(searchParams?.filter);
    const sort = asHistorySort(searchParams?.sort);
    const hrefFor = (next: { filter?: string; sort?: string; q?: string }) => {
      const p = new URLSearchParams({ view: "history" });
      const f = next.filter ?? filter;
      const s = next.sort ?? sort;
      const text = next.q ?? q;
      if (f !== "all") p.set("filter", f);
      if (s !== "newest") p.set("sort", s);
      if (text) p.set("q", text);
      return `/loads?${p.toString()}`;
    };
    const base = historyRows(historyAll, { filter: "all", sort, q });
    const counts: Record<string, number> = { all: base.length, owed: base.filter(isOwed).length, cancelled: base.filter(fellThrough).length };
    const shown = historyRows(historyAll, { filter, sort, q });
    const grouped = sort === "newest" || sort === "oldest";
    const groups = grouped ? monthGroups(shown) : [{ key: "sorted", label: `By ${HISTORY_SORTS.find((s) => s.key === sort)?.label.toLowerCase()}`, rows: shown }];
    const record = q ? payRecord(historyRows(historyAll, { q })) : null;

    const rowOf = (r: BoardRow): Row => {
      const done = historyDate(r);
      const pastDue = r.paymentStatus === "invoiced" && r.invoicedAt != null && r.invoicedAt.getTime() + (r.payTermsDays ?? 0) * 86_400_000 < Date.now();
      return {
        id: r.id,
        href: `/loads/${r.id}`,
        flag: pastDue ? "bad" : undefined,
        search: [r.loadNumber, r.poNumber, r.invoiceNumber, r.brokerName, r.brokerMc, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" "),
        cells: {
          load: (
            <>
              <Link href={`/loads/${r.id}`}>{r.loadNumber ?? "—"}</Link>
              <span className="sub">{r.brokerName}</span>
            </>
          ),
          status: <StatusChip status={r.status} />,
          lane: (
            <>
              {r.origin} → {r.destination}
            </>
          ),
          done: shortDate(done),
          truck: r.vehicleName ?? "—",
          driver: r.driverName ?? <span className="dim">—</span>,
          pay: fellThrough(r) ? <span className="dim">{r.status === "tonu" ? usd(r.quotedRevenue) : "—"}</span> : usd(r.quotedRevenue),
          perMile: fellThrough(r) ? <span className="dim">—</span> : perMile(r.perMile),
          money: fellThrough(r) ? (
            <span className="dim">{reasonLabel(r.cancelReason)}</span>
          ) : r.paymentStatus === "paid" ? (
            <>
              <span className="tl-chip ok">Paid</span>
              <span className="sub">
                {r.invoiceNumber} · {shortDate(r.paidAt)}
                {r.paidAmount != null && r.invoicedAmount != null && r.paidAmount < r.invoicedAmount - 0.005 ? ` · ${usd(r.invoicedAmount - r.paidAmount, 2)} short` : ""}
              </span>
            </>
          ) : r.paymentStatus === "invoiced" ? (
            <>
              <span className={`tl-chip ${pastDue ? "bad" : "warn"}`}>{pastDue ? "Overdue" : "Out and waiting"}</span>
              <span className="sub">
                {r.invoiceNumber} · sent {shortDate(r.invoicedAt)}
              </span>
            </>
          ) : (
            <span className="tl-chip info">Not invoiced yet</span>
          )
        }
      };
    };

    return (
      <>
        {head}
        <DataTableTools tableId="loads-history" total={shown.length} placeholder="Search load, PO, invoice, customer, MC, city, driver…">
          {views}
          <Tabs label="Filter" active={filter} hrefFor={(k) => hrefFor({ filter: k })} items={HISTORY_FILTERS.map((f) => ({ ...f, count: counts[f.key] }))} />
          <span className="tl-sub" style={{ alignSelf: "center" }}>
            Sort by
          </span>
          <Tabs label="Sort" active={sort} hrefFor={(k) => hrefFor({ sort: k })} items={HISTORY_SORTS.map((s) => ({ key: s.key, label: s.label }))} />
          {q ? (
            <Link href={hrefFor({ q: "" })} className="tl-tab" aria-current="true" title="Clear this filter">
              Matching “{q}” ×
            </Link>
          ) : null}
        </DataTableTools>
        {record ? (
          <p className="tl-note" style={{ margin: "0 0 12px" }}>
            <b>{record.broker}</b>: {record.loads} {record.loads === 1 ? "load" : "loads"} finished, {record.invoices} invoiced, {record.paid} paid
            {record.averageDaysToPay != null ? ` in ${record.averageDaysToPay.toFixed(1)} days on average` : ""}
            {record.shortPaid > 0 ? `, ${record.shortPaid} paid short` : ""}
            {record.outstanding > 0 ? `, ${usd(record.outstanding, 2)} still out` : ""}
            {record.fellThrough > 0 ? `, ${record.fellThrough} cancelled` : ""}.
          </p>
        ) : null}
        {shown.length === 0 ? (
          <DataTable id="loads-history" label="History" columns={HISTORY_COLUMNS} rows={[]} empty={<EmptyState icon="loads" title="No finished loads match">Try another filter, or clear the search.</EmptyState>} />
        ) : (
          groups.map((g) => {
            const delivered = g.rows.filter((r) => r.status === "completed");
            return (
              <section key={g.key} style={{ marginTop: 18 }}>
                <h2 style={{ fontFamily: "var(--db-font-sans)", fontSize: "var(--db-text-xs)", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--db-fg-dim)", fontWeight: 700, margin: "0 0 10px" }}>
                  {g.label} · {g.rows.length} {g.rows.length === 1 ? "load" : "loads"}
                  {delivered.length > 0 ? ` · ${usd(delivered.reduce((s, r) => s + r.quotedRevenue, 0))} delivered` : ""}
                </h2>
                <DataTable id={`loads-history--${g.key}`} label={`History, ${g.label}`} columns={HISTORY_COLUMNS} rows={g.rows.map(rowOf)} />
              </section>
            );
          })
        )}
      </>
    );
  }

  // Open: what is still moving.
  const all = searchBoard(openAll, q);
  const active = asBoardStatus(searchParams?.status);
  const below = searchParams?.flag === "below";
  const shown = filterBoard(openAll, { status: active, flag: below ? "below" : undefined, q });
  const counts = (key: string) => (key === "all" ? all.length : all.filter((r) => r.status === key).length);
  const belowCount = all.filter(isBelowCost).length;
  const href = (status: string, flag: boolean, text = q) => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (flag) p.set("flag", "below");
    if (text) p.set("q", text);
    const s = p.toString();
    return s ? `/loads?${s}` : "/loads";
  };

  const rows: Row[] = shown.map((r) => {
    return {
      id: r.id,
      href: `/loads/${r.id}`,
      search: [r.loadNumber, r.poNumber, r.brokerName, r.brokerMc, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" "),
      cells: {
        load: (
          <>
            <Link href={`/loads/${r.id}`}>{r.loadNumber ?? "—"}</Link>
            <AlertDot alerts={byLoad.get(r.id)?.filter((a) => a.code !== "BELOW_COST_UNASSIGNED")} />
            <span className="sub">{r.brokerName}</span>
          </>
        ),
        status: <StatusChip status={r.status} />,
        lane: (
          <>
            {r.origin} → {r.destination}
          </>
        ),
        pickup: shortDate(r.scheduledDate),
        truck: r.vehicleName ?? "—",
        miles: miles(r.totalMiles),
        pay: usd(r.quotedRevenue),
        perMile: perMile(r.perMile),
        floor: <span className="dim">{perMile(r.floorPerMile)}</span>,
        verdict: <VerdictChip verdict={r.verdict} />,
        driver: r.driverName ?? <span className="dim">—</span>,
        assignment: r.assignmentStatus ? <AssignmentChip status={r.assignmentStatus} /> : <span className="dim">—</span>
      }
    };
  });

  return (
    <>
      {head}
      <DataTableTools tableId="loads-table" total={shown.length} placeholder="Search load, PO, customer, MC, city, driver…">
        {views}
        <Tabs active={active} hrefFor={(k) => href(k, below)} items={OPEN_FILTERS.map((f) => ({ ...f, count: counts(f.key) }))} />
        <Link href={href(active, !below)} className="tl-tab" aria-current={below ? "true" : undefined}>
          Below cost · {belowCount}
        </Link>
        {q ? (
          <Link href={href(active, below, "")} className="tl-tab" aria-current="true" title="Clear this filter">
            Matching “{q}” ×
          </Link>
        ) : null}
      </DataTableTools>
      <DataTable
        id="loads-table"
        label="Loads"
        columns={COLUMNS}
        rows={rows}
        empty={<EmptyState icon="loads" title="No open loads match">Another status, or clear the search.</EmptyState>}
      />
    </>
  );
}
