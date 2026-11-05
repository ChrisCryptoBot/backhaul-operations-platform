import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { IftaCalcButton } from "@/components/desk/data-actions";
import { CanGate } from "@/components/desk/kit/can-gate";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, Stat } from "@/components/desk/ui";
import { dateTime } from "@/lib/desk-format";
import { centralParts } from "@/lib/zoned";
import { partnerState, providerName } from "@/server/partners/call";
import { storedIfta } from "@/server/partners/ifta";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "IFTA · TrueLane" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "state", label: "State", group: "Jurisdiction", sticky: true, width: 110 },
  { key: "miles", label: "Miles", group: "The quarter", align: "num", accentBand: true },
  { key: "gallons", label: "Gallons used", group: "The quarter", align: "num", accentBand: true },
  { key: "share", label: "Share of miles", group: "The quarter", align: "num" }
];

const n1 = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** The four quarters ending with the one the carrier's clock is in, newest first: "2026-Q4", "2026-Q3", ... */
function quarters(now: Date, tz: string): string[] {
  const p = centralParts(now.getTime(), tz);
  let y = p.y;
  let q = Math.floor(p.m0 / 3) + 1;
  const out: string[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(`${y}-Q${q}`);
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return out;
}

/**
 * IFTA: a quarter's miles by state, from the quarter's delivered loads, worked out by the mileage company and kept here (one answer per quarter, replaced each time it is worked out). The
 * numbers are the loaded miles of each delivered load split over the states its route runs through; the fuel bought in each state, which IFTA nets against the gallons used, is on the Fuel screen.
 */
export default async function IftaPage({ searchParams }: { searchParams?: { quarter?: string } }) {
  await requirePage("read");
  const tz = await workspaceTimezone(currentWorkspaceId());
  const options = quarters(new Date(), tz);
  const quarter = options.includes(searchParams?.quarter ?? "") ? searchParams!.quarter! : options[0]!;
  const [lines, mileage] = await Promise.all([storedIfta(quarter), partnerState("ifta")]);
  const miles = lines.reduce((s, l) => s + l.miles, 0);
  const gallons = lines.reduce((s, l) => s + l.gallons, 0);
  const worked = lines[0]?.computedAt ?? null;
  const rows: Row[] = lines.map((l) => ({
    id: l.state,
    cells: { state: <b>{l.state}</b>, miles: n1(l.miles), gallons: l.gallons.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }), share: miles > 0 ? `${((l.miles / miles) * 100).toFixed(1)}%` : "—" }
  }));

  return (
    <>
      <PageHead title="IFTA" sub="A quarter's miles by state, from the quarter's delivered loads. The fuel bought in each state is on the Fuel screen.">
        <a className="tl-btn" href={`/export/ifta?quarter=${quarter}`} aria-disabled={lines.length === 0}>Export CSV</a>
        <CanGate caps={["bill"]}>
          <IftaCalcButton quarter={quarter} reason={mileage.reason} again={lines.length > 0} />
        </CanGate>
      </PageHead>
      <div className="tl-tabs" role="tablist" aria-label="Quarter" style={{ display: "flex", gap: 6, marginBottom: 12 }}>
        {options.map((o) => (
          <Link key={o} href={`/ifta?quarter=${o}`} className="tl-tab" aria-current={o === quarter ? "true" : undefined}>
            {o}
          </Link>
        ))}
      </div>
      <div className="tl-grid cols-4">
        <Stat label="Miles" value={lines.length > 0 ? n1(miles) : "—"} sub={lines.length > 0 ? `${lines.length} ${lines.length === 1 ? "state" : "states"}` : "not worked out yet"} />
        <Stat label="Gallons used" value={lines.length > 0 ? gallons.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "—"} sub="miles over each truck's miles to the gallon" />
        <Stat label="Delivered loads" value={lines[0] ? String(lines[0].loads) : "—"} />
        <Stat label="Worked out" value={worked ? dateTime(worked) : "—"} sub={lines[0] ? `by ${providerName(lines[0].source)}` : undefined} />
      </div>
      <DataTable
        id="ifta-table"
        label={`Miles by state, ${quarter}`}
        columns={COLUMNS}
        rows={rows}
        empty={
          <EmptyState icon="chart" title={`${quarter} has not been worked out`}>
            Connect a mileage company in Settings, then press Work out this quarter. It reads the quarter&apos;s delivered loads and keeps the miles by state.
          </EmptyState>
        }
      />
      <p className="tl-note" style={{ marginTop: 12, maxWidth: "80ch" }}>
        These are the loaded miles of delivered loads. Empty miles have no places on a load, so they are not in these numbers until an ELD reports its own miles by state. Gallons are fuel used, worked out from the miles; the return for the quarter nets them against the fuel bought in each state.
      </p>
    </>
  );
}
