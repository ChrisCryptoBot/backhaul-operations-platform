import Link from "next/link";
import React from "react";
import { listTrucksPage } from "@/server/tl/fleet-list";
import { Pager } from "@/components/desk/pager";
import { asPage, nextSortParam } from "@/lib/paging";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { AddTruck, TruckRowActions } from "@/components/desk/fleet-forms";
import { unitUse } from "@/server/tl/plan";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, perGallon, perMile, usd } from "@/lib/desk-format";
import { currentTerminal } from "@/server/tl/terminal";
import { partnerState } from "@/server/partners/call";
import { SyncEldButton } from "@/components/desk/partner-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { FleetMapPanel } from "@/components/desk/radar-map";
import { readRadarParams } from "@/lib/radar-points";
import { clampRadius, milesText } from "@/lib/radius";
import { getRadarData } from "@/server/tl/radar";
import { radarPoints } from "@/server/tl/radar-query";
import { unitsNear } from "@/server/tl/radar-near";
import { currentWorkspaceId } from "@/server/tl/workspace";

export const metadata = { title: "Trucks · TrueLane" };

const COLUMNS: Column[] = [
  { key: "truck", sortable: true, label: "Truck", group: "Truck", sticky: true, width: 200 },
  { key: "type", sortable: true, label: "Type", group: "Truck" },
  { key: "terminal", label: "Terminal", group: "Truck" },
  { key: "mpg", sortable: true, label: "MPG", group: "Truck", align: "num" },
  { key: "fuel", sortable: true, label: "Fuel price", group: "Truck", align: "num" },
  { key: "planned", sortable: true, label: "Planned miles / month", group: "Cost floor", accentBand: true, align: "num" },
  { key: "breakEven", sortable: true, label: "Break-even floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "survival", sortable: true, label: "Survival floor", group: "Cost floor", accentBand: true, align: "num" },
  { key: "detention", sortable: true, label: "Detention rate", group: "Dock", align: "num" },
  { key: "idle", label: "Idling now", group: "Telemetry" },
  { key: "loads", label: "Loads", group: "Work", align: "num" },
  { key: "open", label: "Open", group: "Work", align: "num" },
  { key: "act", label: "", group: "" }
];

export default async function FleetPage({ searchParams }: { searchParams?: { q?: string; sort?: string; page?: string; near?: string; r?: string } }) {
  // Read a page at a time: the database searches, sorts and counts, so a fleet of thousands opens as fast as a fleet of three.
  const terminal = await currentTerminal();
  const eld = await partnerState("eld");
  // A search by place ("75201", "Dallas, TX", "TX") narrows the table and the map to the trucks within a radius of it.
  const nearText = searchParams?.near?.trim() ?? "";
  const rGiven = searchParams?.r ? clampRadius(searchParams.r) : null;
  const near = nearText ? await unitsNear("trucks", nearText, rGiven, currentWorkspaceId(), terminal) : null;
  const nearOk = near && !("error" in near) ? near : null;
  const pageData = await listTrucksPage({ q: searchParams?.q, sort: searchParams?.sort, page: asPage(searchParams?.page), terminal, onlyIds: nearOk ? [...nearOk.miles.keys()] : undefined });
  // Where every tractor is and what standing with the engine on is costing: one read for the strip and the Idling cell.
  const radar = await getRadarData(currentWorkspaceId(), terminal);
  const radarOf = new Map(radar.tractors.map((u) => [u.id, u]));
  const mapParams = readRadarParams((k) => (k === "kind" ? "tractor" : searchParams?.[k as "near" | "r"]));
  const points = await radarPoints(radar, mapParams);
  const columns: Column[] = nearOk ? [...COLUMNS.slice(0, 3), { key: "away", label: "Away", group: "Truck", align: "num" }, ...COLUMNS.slice(3)] : COLUMNS;
  const trucks = pageData.rows;
  const sortParam = searchParams?.sort ? { key: pageData.sort.key as string, dir: pageData.sort.dir } : null;
  const href = (p: { sort?: string | null; page?: number }) => {
    const q = new URLSearchParams();
    if (pageData.q) q.set("q", pageData.q);
    if (nearText) q.set("near", nearText);
    if (nearText && searchParams?.r) q.set("r", searchParams.r);
    if (p.sort) q.set("sort", p.sort);
    if (p.page && p.page > 1) q.set("page", String(p.page));
    const s = q.toString();
    return s ? `/fleet?${s}` : "/fleet";
  };
  const sortHref: SortHref = (key) => ({ href: href({ sort: nextSortParam(sortParam, key) }), dir: sortParam?.key === key ? (sortParam.dir === "asc" ? "asc" : "desc") : "none" });
  const rows: Row[] = trucks.map((t) => ({
    id: t.id,
    search: [t.name, t.type, t.make, t.model].filter(Boolean).join(" "),
    cells: {
      truck: (
        <>
          <Link href={`/fleet/${t.id}`}><b>{t.name}</b></Link>
          <span className="sub">
            {[t.make, t.model, t.year].filter(Boolean).join(" ")}
            {t.make || t.model ? " · " : ""}
            {t.archived ? <span className="tl-chip muted">Archived</span> : (t.archetype?.replace("_", " ") ?? "no cost profile")}
          </span>
        </>
      ),
      type: t.type?.replace("_", " ") ?? "—",
      terminal: t.terminal ?? <span className="dim">—</span>,
      away: nearOk?.miles.has(t.id) ? milesText(nearOk.miles.get(t.id)!) : "—",
      mpg: t.mpg ?? "—",
      fuel: perGallon(t.fuelPrice),
      planned: miles(t.monthlyMiles),
      breakEven: perMile(t.breakEvenRpm),
      survival: perMile(t.survivalFloorRpm),
      detention: t.detentionRate != null ? `${usd(t.detentionRate)}/h` : <span className="dim">none</span>,
      idle: radarOf.get(t.id)?.idle ? (
        <span className="rd-leak">{`\u25A0 ${radarOf.get(t.id)!.idle!.sentence}`}</span>
      ) : (
        <span className="dim">—</span>
      ),
      loads: t.loads,
      open: t.open,
      act: (
        <CanGate caps={["dispatch"]}>
          <TruckRowActions truck={{ id: t.id, name: t.name, archived: t.archived, open: t.open }} />
        </CanGate>
      )
    }
  }));

  const use = await unitUse("truck");
  const table = (
    <>
      <DataTableTools tableId="trucks-table" total={pageData.total} placeholder="Search trucks…" server={{ path: "/fleet", q: pageData.q, keep: { ...(searchParams?.sort ? { sort: searchParams.sort } : {}), ...(nearText ? { near: nearText } : {}), ...(nearText && searchParams?.r ? { r: searchParams.r } : {}) } }} />
      <DataTable id="trucks-table" label="Trucks" columns={columns} rows={rows} sortHref={sortHref} empty={<EmptyState icon="trucks" title="No trucks yet">A truck and its cost profile set the floor every load is measured against.</EmptyState>} />
      <Pager page={pageData.page} pageSize={pageData.pageSize} total={pageData.total} hrefFor={(n) => href({ sort: searchParams?.sort, page: n })} newer="Previous" older="Next" />
    </>
  );
  const showMap = radar.tractors.length > 0 || radar.connected;
  return (
    <>
      <PageHead title="Trucks" sub={`${terminal ? `${terminal} terminal. ` : ""}Each truck's break-even floor, from its own cost profile. Every verdict on the Loads screen is measured against it. Open a truck to change its costs and see the floor move.`}>
        <CanGate caps={["dispatch"]}>
          <SyncEldButton reason={eld.reason} />
        </CanGate>
        <Link href="/fleet/import" className="tl-btn">Import from a file</Link>
        <CanGate caps={["dispatch"]}>
          <AddTruck use={use} />
        </CanGate>
      </PageHead>
      {showMap ? <FleetMapPanel initial={points} params={{ near: nearText, r: nearOk?.radius ?? rGiven ?? 50, rGiven: rGiven != null }} fullHref={`/fleet/map?kind=tractor${nearText ? `&near=${encodeURIComponent(nearText)}${rGiven ? `&r=${rGiven}` : ""}` : ""}`}>{table}</FleetMapPanel> : table}
      <p className="tl-note" style={{ marginTop: 12 }}>
        The break-even floor is cost per mile before fuel (fixed costs spread over planned miles, plus maintenance and tires). The verdict adds fuel for the load&apos;s own miles.
      </p>
    </>
  );
}
