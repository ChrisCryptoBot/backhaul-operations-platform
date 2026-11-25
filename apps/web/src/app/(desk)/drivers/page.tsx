import { scopeWords } from "@/lib/scope";
import Link from "next/link";
import React from "react";
import { listDriversPage } from "@/server/tl/fleet-list";
import { Pager } from "@/components/desk/pager";
import { asPage, nextSortParam } from "@/lib/paging";
import { AssignmentChip, PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { AddDriver, DriverRowActions, type DriverRow } from "@/components/desk/fleet-forms";
import { unitUse } from "@/server/tl/plan";
import { EmptyState } from "@/components/desk/kit/states";
import { ymdOf } from "@/lib/fleet-forms";
import { ASSIGNMENT_STATUS, payLabel, shortDate } from "@/lib/desk-format";
import { papersCell } from "@/lib/papers";
import { currentTerminal } from "@/server/tl/terminal";
import { workspacePaySettings } from "@/server/tl/dispatch";
import { partnerState } from "@/server/partners/call";
import { vetLabel } from "@/server/partners/vetting";
import { VetButton } from "@/components/desk/partner-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { CarrierStatus } from "@/components/desk/carrier-status";

export const metadata = { title: "Drivers · TrueLane" };

/** Who, how to reach them, what they drive and are paid, whether their papers hold, and what they are on. Each paper has its own column behind "Show all columns". */
const COLUMNS: Column[] = [
  { key: "driver", sortable: true, label: "Driver", sticky: true, width: 190 },
  { key: "phone", label: "Phone", priority: 2 },
  { key: "truck", sortable: true, label: "Truck" },
  { key: "terminal", label: "Terminal", max: 130, priority: 2 },
  { key: "pay", label: "Usual pay", align: "num" },
  { key: "papers", label: "Papers", max: 190 },
  { key: "now", label: "On now", max: 220 },
  { key: "delivered", label: "Delivered", align: "num", priority: 2 },
  { key: "cdl", label: "CDL", priority: 3 },
  { key: "medical", label: "Medical card", priority: 3 },
  { key: "clearance", label: "Clearance", priority: 3 },
  { key: "carrier", label: "Carrier insurance", priority: 3 },
  { key: "act", label: "" }
];

/** Furthest along first: what they are on now before what they have said yes to, before what is waiting on them. */
const NOW_ORDER = ["in_progress", "accepted", "dispatched", "draft"];

export default async function DriversPage({ searchParams }: { searchParams?: { q?: string; sort?: string; page?: string } }) {
  const terminal = await currentTerminal();
  const [vetState, pageData, paySettings] = await Promise.all([
    partnerState("vetting"),
    listDriversPage({ q: searchParams?.q, sort: searchParams?.sort, page: asPage(searchParams?.page), terminal }),
    workspacePaySettings()
  ]);
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
  const now = new Date();
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
      payArrangement: d.payArrangement ?? "",
      payKind: d.payKind ?? "",
      payRate: d.payRate == null ? "" : String(d.payRate),
      terminal: d.terminal ?? "",
      carrierMc: d.carrierMc ?? "",
      carrierDot: d.carrierDot ?? "",
      payrollWorkerType: d.payrollWorkerType ?? "",
      payrollEmployeeId: d.payrollEmployeeId ?? "",
      phoneUserId: d.phoneUserId ?? "",
      active: d.active,
      onLoads: d.openLoadNumbers.length,
      onLoadNumbers: d.openLoadNumbers
    };
    const papers = papersCell([{ name: "CDL", expires: d.cdlExpiry }, { name: "Medical", expires: d.medicalCardExpiry }], now);
    const current = [...d.current].sort((x, y) => NOW_ORDER.indexOf(x.status) - NOW_ORDER.indexOf(y.status));
    return {
      id: d.id,
      href: `/drivers/${d.id}`,
      flag: d.active && d.blocker ? "bad" : undefined,
      search: [d.name, d.code, d.phone, d.truck].filter(Boolean).join(" "),
      cells: {
        driver: (
          <>
            <Link href={`/drivers/${d.id}`}>{d.name}</Link>
            {d.code ? <i className="pl-code">{d.code}</i> : null}
            {d.active ? null : <span className="tl-chip muted">Out</span>}
            <span className="sub fold-2">{[d.phone, d.terminal].filter(Boolean).join(" · ") || "No phone on file"}</span>
          </>
        ),
        phone: d.phone ?? <span className="dim">Not on file</span>,
        papers: (
          <span className="t-st say" data-tone={d.active && d.blocker ? "bad" : papers.tone === "muted" ? undefined : papers.tone} title={papers.title}>
            {d.active && d.blocker ? d.blocker : papers.text}
          </span>
        ),
        truck: d.truck ?? "—",
        terminal: d.terminal ?? <span className="dim">—</span>,
        carrier:
          d.carrierMc || d.carrierDot ? (
            <>
              <span className={`tl-chip ${d.vetStatus === "clear" ? "ok" : d.vetStatus === "unchecked" ? "muted" : "warn"}`}>{vetLabel(d.vetStatus)}</span>
              <span className="sub">{[d.carrierMc ? `MC ${d.carrierMc}` : null, d.carrierDot ? `DOT ${d.carrierDot}` : null].filter(Boolean).join(" · ")}</span>
              <CarrierStatus coiExpiresAt={d.coiExpiresAt} safetyScore={d.vetSafetyScore} authorityActive={d.vetAuthorityActive} flags={d.vetFlags} now={new Date()} />
              <CanGate caps={["dispatch"]}>
                <VetButton driverId={d.id} reason={vetState.reason} />
              </CanGate>
            </>
          ) : (
            <span className="dim">—</span>
          ),
        pay: payLabel(d.payKind, d.payRate),
        cdl: d.cdlClass || d.cdlExpiry ? [d.cdlClass ? `Class ${d.cdlClass}` : null, d.cdlExpiry ? `to ${shortDate(d.cdlExpiry)}` : "no date"].filter(Boolean).join(" · ") : <span className="dim">Not on file</span>,
        medical: d.medicalCardExpiry ? `to ${shortDate(d.medicalCardExpiry)}` : <span className="dim">Not on file</span>,
        clearance: !d.active ? <span className="dim">—</span> : d.blocker ? <span className="tl-chip bad">{d.blocker}</span> : <span className="dim">—</span>,
        // One line: the load they are furthest into, and how many more. All of them are in the title and on the driver's page.
        now: current.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          <span title={current.map((c) => `${c.loadNumber ?? "A load"}: ${ASSIGNMENT_STATUS[c.status]?.label ?? c.status}`).join(" · ")}>
            <Link href={`/loads/${current[0]!.loadId}`}>{current[0]!.loadNumber}</Link> <AssignmentChip status={current[0]!.status} />
            {current.length > 1 ? <em className="more">+{current.length - 1}</em> : null}
          </span>
        ),
        delivered: d.delivered,
        act: (
          <CanGate caps={["dispatch"]}>
            <DriverRowActions driver={row} list defaultArrangement={paySettings.defaultPayArrangement} />
          </CanGate>
        )
      }
    };
  });

  const use = await unitUse("driver");
  return (
    <>
      <PageHead title="Drivers" sub={`${scopeWords(terminal) ? `${scopeWords(terminal)}. ` : ""}Who can take a load today. A lapsed CDL or medical card blocks the assignment. A driver on an open load cannot be taken out of service.`}>
        <Link href="/drivers/import" className="tl-btn">Import from a file</Link>
        <CanGate caps={["dispatch"]}>
          <AddDriver use={use} defaultArrangement={paySettings.defaultPayArrangement} />
        </CanGate>
      </PageHead>
      <DataTableTools tableId="drivers-table" total={pageData.total} placeholder="Search driver, code, phone, truck…" server={{ path: "/drivers", q: pageData.q, keep: searchParams?.sort ? { sort: searchParams.sort } : {} }} />
      <DataTable id="drivers-table" label="Drivers" columns={COLUMNS} rows={rows} sortHref={sortHref} empty={<EmptyState icon="drivers" title="No drivers yet">Add a driver and they show up here with their CDL and medical card dates.</EmptyState>} />
      <Pager page={pageData.page} pageSize={pageData.pageSize} total={pageData.total} hrefFor={(n) => href({ sort: searchParams?.sort, page: n })} newer="Previous" older="Next" />
    </>
  );
}
