import { currentTerminal } from "@/server/tl/terminal";
import { isOverdue } from "@/lib/overdue";
import Link from "next/link";
import { redirect } from "next/navigation";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { countHistory, listHistory } from "@/server/tl/history";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { Pager } from "@/components/desk/pager";
import { AssignmentChip, PageHead, StatusChip, Tabs, VerdictChip } from "@/components/desk/ui";
import { AlertDot } from "@/components/desk/alert-bits";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { asPage, asSort, nextSortParam } from "@/lib/paging";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { NewLoad } from "@/components/desk/new-load";
import { RestoreLoadButton } from "@/components/desk/restore-load";
import { countDeletedLoads, listDeletedLoads } from "@/server/tl/deleted";
import { dateTime } from "@/lib/desk-format";
import { asBoardStatus, BOARD_STATUSES, filterBoard, isBelowCost, onTab, searchBoard } from "@/lib/board-filter";
import { reasonLabel } from "@/lib/disruptions";
import { asHistoryFilter, asHistorySort, fellThrough, HISTORY_FILTERS, HISTORY_SORTS, historyDate, monthGroups } from "@/lib/loads-history";
import { miles, perMile, shortDate, stopTime, usd } from "@/lib/desk-format";
import { moneyState } from "@/lib/money-state";
import { daysPastDue } from "@/lib/overdue";
import { CanGate } from "@/components/desk/kit/can-gate";

export const metadata = { title: "Loads · TrueLane" };

const OPEN_FILTERS = BOARD_STATUSES.filter((s) => s.key !== "completed");
/** Open loads shown at a time; a big fleet has hundreds moving at once. */
const OPEN_PAGE = 50;
const OPEN_SORTS = ["load", "lane", "pickup", "miles", "pay", "perMile", "floor", "driver"] as const;
const OPEN_SORT_VALUE: Record<(typeof OPEN_SORTS)[number], (r: BoardRow) => string | number | null> = {
  load: (r) => r.loadNumber?.toLowerCase() ?? null,
  lane: (r) => `${r.origin ?? ""} ${r.destination ?? ""}`.toLowerCase(),
  pickup: (r) => r.scheduledDate?.getTime() ?? null,
  miles: (r) => r.totalMiles,
  pay: (r) => r.grossRevenue,
  perMile: (r) => r.perMile,
  floor: (r) => r.floorPerMile,
  driver: (r) => r.driverName?.toLowerCase() ?? null
};

const COLUMNS: Column[] = [
  { key: "load", sortable: true, label: "Load", group: "Load", sticky: true, width: 150 },
  { key: "status", label: "Status", group: "Load", sticky: true, width: 150 },
  { key: "lane", sortable: true, label: "Lane", group: "Route" },
  { key: "pickup", sortable: true, label: "Pickup", group: "Route" },
  { key: "truck", label: "Truck", group: "Route" },
  { key: "miles", sortable: true, label: "Miles", group: "Route", align: "num" },
  { key: "pay", sortable: true, label: "Pay", group: "Money", accentBand: true, align: "num" },
  { key: "perMile", sortable: true, label: "$/mi", group: "Money", accentBand: true, align: "num" },
  { key: "floor", sortable: true, label: "Floor", group: "Money", accentBand: true, align: "num" },
  { key: "verdict", label: "Verdict", group: "Money", accentBand: true },
  { key: "driver", sortable: true, label: "Driver", group: "Dispatch" },
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
  { key: "net", label: "Net pay", group: "Money", accentBand: true, align: "num" },
  { key: "profit", label: "Profit/mi", group: "Money", accentBand: true, align: "num" },
  { key: "rph", label: "$/hr", group: "Money", accentBand: true, align: "num" },
  { key: "money", label: "Where the money is", group: "Money", accentBand: true }
];

const DELETED_COLUMNS: Column[] = [
  { key: "load", label: "Load", group: "Load", sticky: true, width: 150 },
  { key: "lane", label: "Lane", group: "Load" },
  { key: "status", label: "Was", group: "Load" },
  { key: "deleted", label: "Deleted", group: "Load" },
  { key: "why", label: "Why", group: "Load" },
  { key: "restore", label: "", group: "Load" }
];

type Params = { view?: string; status?: string; flag?: string; q?: string; filter?: string; sort?: string; page?: string };

export default async function LoadsPage({ searchParams }: { searchParams?: Params }) {
  const q = searchParams?.q?.trim() ?? "";
  // Delivered loads moved to History; an old link to the Delivered tab lands there.
  if (searchParams?.status === "completed") redirect(`/loads?view=history${q ? `&q=${encodeURIComponent(q)}` : ""}`);

  const view = searchParams?.view === "history" ? "history" : searchParams?.view === "deleted" ? "deleted" : "open";
  // The header's terminal scope narrows the board too (loads placed in that terminal, and loads not placed anywhere yet).
  const terminal = await currentTerminal();
  // The open board is the loads still moving. History is read a page at a time: the database filters, sorts, searches and counts it.
  const histFilter = asHistoryFilter(searchParams?.filter);
  const histSort = asHistorySort(searchParams?.sort);
  const [openAll, { byLoad }, hist] = await Promise.all([
    listBoardRows(currentWorkspaceId(), "open", terminal),
    getAlerts(new Date(), currentWorkspaceId(), "open"),
    view === "history" ? listHistory({ filter: histFilter, sort: histSort, q, page: Number(searchParams?.page) || 1, terminal }) : Promise.resolve(null)
  ]);
  const openCount = searchBoard(openAll, q).length;
  const historyCount = hist ? hist.counts.all : await countHistory(q, currentWorkspaceId(), terminal);
  const deletedCount = await countDeletedLoads(currentWorkspaceId(), terminal);

  const viewHref = (v: string) => {
    const p = new URLSearchParams();
    if (v === "history" || v === "deleted") p.set("view", v);
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
    <PageHead title="Loads" sub={view === "open" ? "What is still moving, judged on each truck's own cost." : view === "deleted" ? "Loads taken off the desk, and the way back." : "What has finished, by month, with where the money is."}>
      {view === "deleted" ? null : <a className="tl-btn" href={exportHref}>Export CSV</a>}
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
        { key: "history", label: "History", count: historyCount },
        ...(deletedCount > 0 || view === "deleted" ? [{ key: "deleted", label: "Deleted", count: deletedCount }] : [])
      ]}
    />
  );

  if (view === "deleted") {
    const gone = await listDeletedLoads(currentWorkspaceId(), terminal);
    const deletedRows: Row[] = gone.map((r) => ({
      id: r.id,
      cells: {
        load: (
          <>
            {r.loadNumber ?? "—"}
            <span className="sub">{r.brokerName}</span>
          </>
        ),
        lane: (
          <>
            {r.origin} → {r.destination}
          </>
        ),
        status: <StatusChip status={r.status} />,
        deleted: dateTime(r.deletedAt),
        why: (
          <>
            {r.reason ?? <span className="dim">—</span>}
            {r.note ? <span className="sub">{r.note}</span> : null}
          </>
        ),
        restore: (
          <CanGate caps={["dispatch"]}>
            <RestoreLoadButton loadId={r.id} loadNumber={r.loadNumber ?? "The load"} />
          </CanGate>
        )
      }
    }));
    return (
      <>
        {head}
        <DataTableTools tableId="loads-deleted" total={gone.length} placeholder="Search deleted loads…">
          {views}
        </DataTableTools>
        <p className="tl-note" style={{ margin: "0 0 12px" }}>Deleted loads are hidden, not erased: their record and audit trail stay. Restoring one checks that its number, truck and driver are still free.</p>
        <DataTable
          id="loads-deleted"
          label="Deleted loads"
          columns={DELETED_COLUMNS}
          rows={deletedRows}
          empty={<EmptyState icon="loads" title="Nothing deleted">A load deleted from its page lands here, and can be restored.</EmptyState>}
        />
      </>
    );
  }

  if (hist) {
    const filter = hist.filter;
    const sort = hist.sort;
    const hrefFor = (next: { filter?: string; sort?: string; q?: string; page?: number }) => {
      const p = new URLSearchParams({ view: "history" });
      const f = next.filter ?? filter;
      const s = next.sort ?? sort;
      const text = next.q ?? q;
      if (f !== "all") p.set("filter", f);
      if (s !== "newest") p.set("sort", s);
      if (text) p.set("q", text);
      if (next.page && next.page > 1) p.set("page", String(next.page));
      return `/loads?${p.toString()}`;
    };
    const counts: Record<string, number> = hist.counts;
    const shown = hist.rows;
    const grouped = sort === "newest" || sort === "oldest";
    const groups = grouped ? monthGroups(shown) : [{ key: "sorted", label: `By ${HISTORY_SORTS.find((s) => s.key === sort)?.label.toLowerCase()}`, rows: shown }];
    const record = hist.record;

    // A figure the cost profile's math could not work (no truck, no fuel price, a TONU) is a dash that says why, never a zero.
    const needs = (missing: boolean, text: string) => (missing ? <span className="dim" title="Needs a truck with a cost profile and a fuel price">—</span> : text);
    const rowOf = (r: BoardRow): Row => {
      const done = historyDate(r);
      const pastDue = r.paymentStatus === "invoiced" && isOverdue(r.invoicedAt, r.payTermsDays);
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
          pay: r.status === "cancelled" ? <span className="dim">—</span> : r.status === "tonu" ? <span title="The TONU fee">{usd(r.grossRevenue)}</span> : usd(r.grossRevenue),
          perMile: fellThrough(r) ? <span className="dim">—</span> : perMile(r.perMile),
          net: needs(r.netPay == null, usd(r.netPay ?? 0)),
          profit: needs(r.profitPerMile == null, r.profitPerMile == null ? "" : `${r.profitPerMile < 0 ? "-" : ""}${perMile(Math.abs(r.profitPerMile))}`),
          rph: needs(r.profitPerHour == null, `${usd(r.profitPerHour ?? 0)}/hr`),
          money:
            r.status === "cancelled" || (r.status === "tonu" && !r.paymentStatus) ? (
              <span className="dim">{reasonLabel(r.cancelReason)}</span>
            ) : (
              (() => {
                const m = moneyState({ paymentStatus: r.paymentStatus, billed: r.invoicedAmount ?? r.grossRevenue, received: r.paidAmount, writeOffAmount: r.writeOffAmount, writeOffReason: r.writeOffReason, overdueDays: pastDue ? daysPastDue(r.invoicedAt, r.payTermsDays) : null });
                return (
                  <>
                    <span className={`tl-chip ${m.tone}`}>{m.label}</span>
                    {r.paymentStatus ? (
                      <span className="sub">
                        {r.invoiceNumber} · {r.paymentStatus === "paid" ? shortDate(r.paidAt) : `sent ${shortDate(r.invoicedAt)}`}
                        {m.detail ? ` · ${m.detail}` : ""}
                        {r.status === "tonu" ? " · TONU" : ""}
                      </span>
                    ) : null}
                  </>
                );
              })()
            )
        }
      };
    };

    return (
      <>
        {head}
        <DataTableTools tableId="loads-history" total={hist.total} placeholder="Search load, PO, invoice, customer, MC, city, driver…">
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
        {hist.total === 0 ? (
          <DataTable id="loads-history" label="History" columns={HISTORY_COLUMNS} rows={[]} empty={<EmptyState icon="loads" title="No finished loads match">Try another filter, or clear the search.</EmptyState>} />
        ) : (
          groups.map((g) => {
            const month = hist.months[g.key];
            return (
              <section key={g.key} style={{ marginTop: 18 }}>
                <h2 style={{ fontFamily: "var(--db-font-sans)", fontSize: "var(--db-text-xs)", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--db-fg-dim)", fontWeight: 700, margin: "0 0 10px" }}>
                  {g.label} · {month ? month.loads : g.rows.length} {(month ? month.loads : g.rows.length) === 1 ? "load" : "loads"}
                  {month && month.loads > g.rows.length ? ` (${g.rows.length} on this page)` : ""}
                  {month && month.earned > 0 ? ` · ${usd(month.earned)} earned` : ""}
                </h2>
                <DataTable id={`loads-history--${g.key}`} label={`History, ${g.label}`} columns={HISTORY_COLUMNS} rows={g.rows.map(rowOf)} />
              </section>
            );
          })
        )}
        {hist.windowed ? <p className="tl-note">Sorted across the latest {hist.windowSize.toLocaleString("en-US")} finished loads of {hist.total.toLocaleString("en-US")}; narrow the search to reach older ones.</p> : null}
        <Pager page={hist.page} pageSize={hist.pageSize} total={hist.total} hrefFor={(n) => hrefFor({ page: n })} {...(grouped ? {} : { newer: "Previous", older: "Next" })} />
      </>
    );
  }

  // Open: what is still moving.
  const all = searchBoard(openAll, q);
  const active = asBoardStatus(searchParams?.status);
  const below = searchParams?.flag === "below";
  const shown = filterBoard(openAll, { status: active, flag: below ? "below" : undefined, q });
  const counts = (key: string) => (key === "all" ? all.length : all.filter((r) => onTab(r, key)).length);
  const belowCount = all.filter(isBelowCost).length;
  // Soonest pickup first unless another column is chosen (a pickup already past sits at the top, where it needs looking at), and the Pickup header shows it.
  const sortKey = asSort(searchParams?.sort, OPEN_SORTS, { key: "pickup", dir: "asc" });
  const now = Date.now();
  const href = (status: string, flag: boolean, text = q, extra: { sort?: string | null; page?: number } = {}) => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (flag) p.set("flag", "below");
    if (text) p.set("q", text);
    const sort = extra.sort === undefined ? searchParams?.sort : extra.sort;
    if (sort) p.set("sort", sort);
    if (extra.page && extra.page > 1) p.set("page", String(extra.page));
    const s = p.toString();
    return s ? `/loads?${s}` : "/loads";
  };
  // Sorted and paged on the server: the list can be hundreds of loads, and a sort of the fifty on screen would be a different list than the one asked for.
  const ordered = sortKey
    ? [...shown].sort((a, b) => {
        const x = OPEN_SORT_VALUE[sortKey.key](a);
        const y = OPEN_SORT_VALUE[sortKey.key](b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
        return sortKey.dir === "asc" ? c : -c;
      })
    : shown;
  const pageNo = Math.min(asPage(searchParams?.page), Math.max(1, Math.ceil(ordered.length / OPEN_PAGE)));
  const sortHref: SortHref = (key) => ({ href: href(active, below, q, { sort: nextSortParam(sortKey, key), page: 1 }), dir: sortKey?.key === key ? (sortKey.dir === "asc" ? "asc" : "desc") : "none" });

  const rows: Row[] = ordered.slice((pageNo - 1) * OPEN_PAGE, pageNo * OPEN_PAGE).map((r) => {
    return {
      id: r.id,
      href: `/loads/${r.id}`,
      sort: { pickup: r.scheduledDate?.getTime() ?? null },
      search: [r.loadNumber, r.poNumber, r.brokerName, r.brokerMc, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" "),
      cells: {
        load: (
          <>
            <Link href={`/loads/${r.id}`}>{r.loadNumber ?? "—"}</Link>
            <AlertDot alerts={byLoad.get(r.id)?.filter((a) => a.code !== "BELOW_COST_UNASSIGNED")} />
            <span className="sub">{r.brokerName}</span>
          </>
        ),
        status: (
          <>
            <StatusChip status={r.status} />
            {r.status !== "in_progress" && r.pickupClosesAt && r.pickupClosesAt.getTime() < now ? (
              <span className="tl-chip bad" title="The pickup window has closed and the load has not been picked up">Pickup passed</span>
            ) : null}
          </>
        ),
        lane: (
          <>
            {r.origin} → {r.destination}
          </>
        ),
        // The appointment where the dock is, with the carrier's clock beside it when the two differ (the same rule as the load drawer); a load with no appointment time shows its day.
        pickup: r.pickupAt ? stopTime(r.pickupAt, r.pickupZone) : shortDate(r.scheduledDate),
        truck: r.vehicleName ?? "—",
        miles: miles(r.totalMiles),
        pay: usd(r.grossRevenue),
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
      <DataTableTools tableId="loads-table" total={shown.length} placeholder="Search load, PO, customer, MC, city, driver…" server={{ path: "/loads", q, keep: { ...(active !== "all" ? { status: active } : {}), ...(below ? { flag: "below" } : {}), ...(searchParams?.sort ? { sort: searchParams.sort } : {}) } }}>
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
        sortHref={sortHref}
        empty={<EmptyState icon="loads" title="No open loads match">Another status, or clear the search.</EmptyState>}
      />
      <Pager page={pageNo} pageSize={OPEN_PAGE} total={ordered.length} hrefFor={(n) => href(active, below, q, { page: n })} newer="Previous" older="Next" />
    </>
  );
}
