import Link from "next/link";
import React from "react";
import { listBoardRows } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { AssignmentChip, PageHead, StatusChip, Tabs, VerdictChip } from "@/components/desk/ui";
import { AlertDot } from "@/components/desk/alert-bits";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Needs a driver" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "On the road" },
  { key: "completed", label: "Delivered" }
] as const;

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

export default async function LoadsPage({ searchParams }: { searchParams?: { status?: string; flag?: string; q?: string } }) {
  const [everything, { byLoad }] = await Promise.all([listBoardRows(), getAlerts()]);
  const q = searchParams?.q?.trim() ?? "";
  const needle = q.toLowerCase();
  // `q` comes from the header search (a driver, broker or city) and narrows everything below, counts included.
  const all = needle
    ? everything.filter((r) => [r.loadNumber, r.brokerName, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" ").toLowerCase().includes(needle))
    : everything;
  const active = FILTERS.some((f) => f.key === searchParams?.status) ? (searchParams!.status as string) : "all";
  const below = searchParams?.flag === "below";
  const isBelow = (r: (typeof all)[number]) => r.verdict === "reject" && r.status !== "completed";
  const byStatus = active === "all" ? all : all.filter((r) => r.status === active);
  const shown = below ? byStatus.filter(isBelow) : byStatus;
  const counts = (key: string) => (key === "all" ? all.length : all.filter((r) => r.status === key).length);
  const belowCount = all.filter(isBelow).length;
  const href = (status: string, flag: boolean, text = q) => {
    const p = new URLSearchParams();
    if (status !== "all") p.set("status", status);
    if (flag) p.set("flag", "below");
    if (text) p.set("q", text);
    const s = p.toString();
    return s ? `/loads?${s}` : "/loads";
  };

  const rows: Row[] = shown.map((r) => {
    const tone = r.verdict === "reject" ? "tone-neg" : r.verdict === "caution" ? "tone-warn" : r.verdict === "accept" ? "tone-pos" : "";
    return {
      id: r.id,
      href: `/loads/${r.id}`,
      flag: isBelow(r) ? "bad" : undefined,
      search: [r.loadNumber, r.brokerName, r.origin, r.destination, r.vehicleName, r.driverName].filter(Boolean).join(" "),
      cells: {
        load: (
          <>
            <Link href={`/loads/${r.id}`}>{r.loadNumber ?? "—"}</Link>
            <AlertDot alerts={byLoad.get(r.id)} />
            <span className="sub">{r.brokerName}</span>
          </>
        ),
        status: <StatusChip status={r.status} />,
        lane: <>{r.origin} → {r.destination}</>,
        pickup: shortDate(r.scheduledDate),
        truck: r.vehicleName ?? "—",
        miles: miles(r.totalMiles),
        pay: usd(r.quotedRevenue),
        perMile: <span className={r.status === "completed" ? "" : tone}>{perMile(r.perMile)}</span>,
        floor: <span className="dim">{perMile(r.floorPerMile)}</span>,
        verdict: r.status === "completed" ? <span className="dim">—</span> : <VerdictChip verdict={r.verdict} />,
        driver: r.driverName ?? <span className="dim">—</span>,
        assignment: r.assignmentStatus && r.status !== "completed" ? <AssignmentChip status={r.assignmentStatus} /> : <span className="dim">—</span>
      }
    };
  });

  return (
    <>
      <PageHead title="Loads" sub="Every load, with the verdict on the truck's own cost: the same figure TrueLane gives a driver on the Calculate screen." />
      <DataTableTools tableId="loads-table" total={shown.length} placeholder="Search load, broker, city, driver…">
        <Tabs active={active} hrefFor={(k) => href(k, below)} items={FILTERS.map((f) => ({ ...f, count: counts(f.key) }))} />
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
        empty={<EmptyState icon="loads" title="No loads match">Try another status, or clear the search.</EmptyState>}
      />
    </>
  );
}
