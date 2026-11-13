import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { IftaCalcButton, IftaEldMilesButton } from "@/components/desk/data-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, Stat } from "@/components/desk/ui";
import { dateTime } from "@/lib/desk-format";
import { recentQuarters } from "@/lib/ifta-rates-csv";
import { partnerState, providerName } from "@/server/partners/call";
import { iftaQuarterMiles } from "@/server/partners/ifta-mileage";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "IFTA · TrueLane" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "state", label: "State", group: "Jurisdiction", sticky: true, width: 110 },
  { key: "miles", label: "Miles", group: "The quarter", align: "num", accentBand: true },
  { key: "loaded", label: "Loaded", group: "The quarter", align: "num" },
  { key: "empty", label: "Empty", group: "The quarter", align: "num" },
  { key: "share", label: "Share of miles", group: "The quarter", align: "num" }
];

const n1 = (s: string) => Number(s).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const trucks = (n: number) => `${n} ${n === 1 ? "truck" : "trucks"}`;

/**
 * IFTA: a quarter's miles by state (money plan Wave 5). Each truck counts its ELD miles when the ELD reported it, else its legs routed from its loads (empty legs between loads included); never
 * both. Gallons, tax and the return itself are steps 6 and 7; this page shows the miles they will be worked out from and where each truck's came from.
 */
export default async function IftaPage({ searchParams }: { searchParams?: { quarter?: string } }) {
  await requirePage("read");
  const tz = await workspaceTimezone(currentWorkspaceId());
  const options = recentQuarters(new Date(), tz);
  const quarter = options.includes(searchParams?.quarter ?? "") ? searchParams!.quarter! : options[0]!;
  const [q, router, eld] = await Promise.all([iftaQuarterMiles(quarter), partnerState("ifta"), partnerState("eld")]);
  const states = q?.states ?? [];
  const total = Number(q?.miles ?? "0");
  const rows: Row[] = states.map((l) => ({
    id: l.state,
    cells: { state: <b>{l.state}</b>, miles: n1(l.miles), loaded: n1(l.loadedMiles), empty: n1(l.emptyMiles), share: total > 0 ? `${((Number(l.miles) / total) * 100).toFixed(1)}%` : "—" }
  }));
  const sourceLine = (q?.sources ?? []).map((s) => (s.method === "eld" ? `ELD miles (${providerName(s.source)}) for ${trucks(s.trucks)}` : `routed (${providerName(s.source)}) for ${trucks(s.trucks)}`)).join(" · ");
  const hasEld = (q?.sources ?? []).some((s) => s.method === "eld");
  const hasRouted = (q?.sources ?? []).some((s) => s.method === "routed") || (q?.setAside ?? 0) > 0;

  return (
    <>
      <PageHead title="IFTA" sub="A quarter's miles by state: each truck's ELD miles, or its loads routed when the ELD did not report it. The fuel bought in each state is on the Fuel screen.">
        <a className="tl-btn" href={`/export/ifta?quarter=${quarter}`} aria-disabled={states.length === 0}>Export CSV</a>
        <CanGate caps={["bill"]}>
          <Link className="tl-btn" href={`/ifta/rates?quarter=${quarter}`}>Tax rates</Link>
          <IftaEldMilesButton quarter={quarter} reason={eld.reason} again={hasEld} />
          <IftaCalcButton quarter={quarter} reason={router.reason} again={hasRouted} />
        </CanGate>
      </PageHead>
      <div className="tl-tabs ifta-tabs" role="tablist" aria-label="Quarter">
        {options.map((o) => (
          <Link key={o} href={`/ifta?quarter=${o}`} className="tl-tab" aria-current={o === quarter ? "true" : undefined}>
            {o}
          </Link>
        ))}
      </div>
      <div className="tl-grid cols-4">
        <Stat label="Miles" value={states.length > 0 ? n1(q!.miles) : "—"} sub={states.length > 0 ? `${states.length} ${states.length === 1 ? "state" : "states"}` : "none kept yet"} />
        <Stat label="Loaded / empty" value={states.length > 0 ? `${n1(q!.loadedMiles)} / ${n1(q!.emptyMiles)}` : "—"} />
        <Stat label="Trucks" value={q && q.trucks.length > 0 ? String(q.trucks.length) : "—"} sub={sourceLine || undefined} />
        <Stat label="Last read" value={q?.syncedAt ? dateTime(q.syncedAt) : "—"} />
      </div>
      {q && q.setAside > 0 ? (
        <p className="tl-note ifta-eld-line">
          {trucks(q.setAside)} also {q.setAside === 1 ? "has" : "have"} routed miles, set aside: the ELD reported {q.setAside === 1 ? "it" : "them"}, and ELD miles always come first.
        </p>
      ) : null}
      <DataTable
        id="ifta-table"
        label={`Miles by state, ${quarter}`}
        columns={COLUMNS}
        rows={rows}
        empty={
          <EmptyState icon="chart" title={`${quarter} has no miles kept yet`}>
            Read ELD miles for the trucks your ELD reports, then route the rest from their loads. Both need the company connected in Settings.
          </EmptyState>
        }
      />
      <p className="tl-note ifta-eld-line">
        A truck the ELD reported counts its ELD miles only; any other truck counts its loads routed stop by stop, with the empty runs between them. A first load with empty miles and no home base on the truck has no empty run before it (none is made up). Gallons and tax come with the return.
      </p>
    </>
  );
}
