import Link from "next/link";
import React from "react";
import { listDriversPage } from "@/server/tl/fleet-list";
import { Pager } from "@/components/desk/pager";
import { asPage, nextSortParam } from "@/lib/paging";
import { AssignmentChip, PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { AddDriver, DriverRowActions, type DriverRow } from "@/components/desk/fleet-forms";
import { EmptyState } from "@/components/desk/kit/states";
import { ymdOf } from "@/lib/fleet-forms";
import { payLabel, shortDate } from "@/lib/desk-format";
import { currentTerminal } from "@/server/tl/terminal";
import { partnerState } from "@/server/partners/call";
import { vetLabel } from "@/server/partners/vetting";
import { VetButton } from "@/components/desk/partner-actions";

export const metadata = { title: "Drivers · TrueLane" };

const COLUMNS: Column[] = [
  { key: "driver", sortable: true, label: "Driver", group: "Driver", sticky: true, width: 220 },
  { key: "truck", sortable: true, label: "Truck", group: "Driver" },
  { key: "terminal", label: "Terminal", group: "Driver" },
  { key: "pay", label: "Usual pay", group: "Driver" },
  { key: "cdl", label: "CDL", group: "Compliance" },
  { key: "medical", label: "Medical card", group: "Compliance" },
  { key: "clearance", label: "Clearance", group: "Compliance" },
  { key: "carrier", label: "Carrier insurance", group: "Compliance" },
  { key: "now", label: "On now", group: "Work" },
  { key: "delivered", label: "Delivered", group: "Work", align: "num" },
  { key: "act", label: "", group: "" }
];

export default async function DriversPage({ searchParams }: { searchParams?: { q?: string; sort?: string; page?: string } }) {
  const terminal = await currentTerminal();
  const vetState = await partnerState("vetting");
  const pageData = await listDriversPage({ q: searchParams?.q, sort: searchParams?.sort, page: asPage(searchParams?.page), terminal });
  const drivers = pageData.rows;
  const sortParam = searchParams?.sort ? { key: pageData.sort.key as string, dir: pageData.sort.dir } : null;
  const href = (p: { sort?: string | null; page?: number }) => {
    const q = new URLSearchParams();
    if (pageData.q) q.set("q", pageData.q);
    if (p.sort) q.set("sort", p.sort);
    if (p.page && p.page > 1) q.set("page", String(p.page));
    const s = q.toString();
    return s ? `/drivers?${s}` : "/drivers";
  };
  const sortHref: SortHref = (key) => ({ href: href({ sort: nextSortParam(sortParam, key) }), dir: sortParam?.key === key ? (sortParam.dir === "asc" ? "asc" : "desc") : "none" });
  const rows: Row[] = drivers.map((d) => {
    const row: DriverRow = {
      id: d.id,
      name: d.name,
      phone: d.phone,
      email: d.email,
      cdlClass: d.cdlClass,
      cdlExpiry: ymdOf(d.cdlExpiry),
      medicalCardExpiry: ymdOf(d.medicalCardExpiry),
      truckId: d.truckId,
      truckName: d.truck,
      payKind: d.payKind ?? "",
      payRate: d.payRate == null ? "" : String(d.payRate),
      terminal: d.terminal ?? "",
      carrierMc: d.carrierMc ?? "",
      carrierDot: d.carrierDot ?? "",
      payrollWorkerType: d.payrollWorkerType ?? "",
      payrollEmployeeId: d.payrollEmployeeId ?? "",
      active: d.active,
      onLoads: d.openLoadNumbers.length,
      onLoadNumbers: d.openLoadNumbers
    };
    return {
      id: d.id,
      flag: d.active && d.blocker ? "bad" : undefined,
      search: [d.name, d.phone, d.truck].filter(Boolean).join(" "),
      cells: {
        driver: (
          <>
            <Link href={`/drivers/${d.id}`}><b>{d.name}</b></Link>
            {d.active ? <span className="sub">{d.phone}</span> : <span className="sub"><span className="tl-chip muted">Out of service</span></span>}
          </>
        ),
        truck: d.truck ?? "—",
        terminal: d.terminal ?? <span className="dim">—</span>,
        carrier:
          d.carrierMc || d.carrierDot ? (
            <>
              <span className={`tl-chip ${d.vetStatus === "clear" ? "ok" : d.vetStatus === "unchecked" ? "muted" : "warn"}`}>{vetLabel(d.vetStatus)}</span>
              <span className="sub">{[d.carrierMc ? `MC ${d.carrierMc}` : null, d.carrierDot ? `DOT ${d.carrierDot}` : null].filter(Boolean).join(" · ")}{d.coiExpiresAt ? ` · insured to ${shortDate(d.coiExpiresAt)}` : ""}</span>
              <VetButton driverId={d.id} reason={vetState.reason} />
            </>
          ) : (
            <span className="dim">—</span>
          ),
        pay: payLabel(d.payKind, d.payRate),
        cdl: <>Class {d.cdlClass ?? "?"} · to {shortDate(d.cdlExpiry)}</>,
        medical: <>to {shortDate(d.medicalCardExpiry)}</>,
        clearance: !d.active ? <span className="dim">—</span> : d.blocker ? <span className="tl-chip bad">{d.blocker}</span> : <span className="dim">—</span>,
        now:
          d.current.length === 0 ? (
            <span className="dim">—</span>
          ) : (
            d.current.map((c) => (
              <div key={c.loadId}>
                <Link href={`/loads/${c.loadId}`}>{c.loadNumber}</Link> <AssignmentChip status={c.status} />
              </div>
            ))
          ),
        delivered: d.delivered,
        act: <DriverRowActions driver={row} />
      }
    };
  });

  return (
    <>
      <PageHead title="Drivers" sub={`${terminal ? `${terminal} terminal. ` : ""}Who can take a load today. A lapsed CDL or medical card blocks the assignment. A driver on an open load cannot be taken out of service.`}>
        <Link href="/drivers/import" className="tl-btn">Import from a file</Link>
        <AddDriver />
      </PageHead>
      <DataTableTools tableId="drivers-table" total={pageData.total} placeholder="Search driver, phone, truck…" server={{ path: "/drivers", q: pageData.q, keep: searchParams?.sort ? { sort: searchParams.sort } : {} }} />
      <DataTable id="drivers-table" label="Drivers" columns={COLUMNS} rows={rows} sortHref={sortHref} empty={<EmptyState icon="drivers" title="No drivers yet">Add a driver and they show up here with their CDL and medical card dates.</EmptyState>} />
      <Pager page={pageData.page} pageSize={pageData.pageSize} total={pageData.total} hrefFor={(n) => href({ sort: searchParams?.sort, page: n })} newer="Previous" older="Next" />
    </>
  );
}
