import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { IftaRatesPanel } from "@/components/desk/ifta-rates-panel";
import { EmptyState } from "@/components/desk/kit/states";
import { PageHead, Stat } from "@/components/desk/ui";
import { dateTime } from "@/lib/desk-format";
import { RATE_STATUS_LABEL, recentQuarters } from "@/lib/ifta-rates-csv";
import { iftaRateQuarters, listIftaRates } from "@/server/partners/ifta-rates";
import { requirePage } from "@/server/tl/access";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { workspaceTimezone } from "@/server/tl/zone";

export const metadata = { title: "IFTA tax rates · TrueLane" };
export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "jurisdiction", label: "Jurisdiction", group: "Where", sticky: true, width: 200 },
  { key: "rate", label: "Rate ($/gal)", group: "Diesel", align: "num", accentBand: true },
  { key: "surcharge", label: "Surcharge ($/gal)", group: "Diesel", align: "num", accentBand: true },
  { key: "status", label: "Status", group: "Kept" },
  { key: "source", label: "From", group: "Kept" }
];

/**
 * A quarter's IFTA tax rates (money plan Wave 5 step 4): the table the quarter's return multiplies by. Loaded from a rate file shaped on IFTA, Inc.'s quarterly table (an assumption), one file
 * replacing the whole quarter; or, for a demo, made-up sample rates labelled not for filing. The billing office's page, like the IFTA calculation.
 */
export default async function IftaRatesPage({ searchParams }: { searchParams?: { quarter?: string } }) {
  await requirePage("bill");
  const tz = await workspaceTimezone(currentWorkspaceId());
  const options = recentQuarters(new Date(), tz);
  const quarter = options.includes(searchParams?.quarter ?? "") ? searchParams!.quarter! : options[0]!;
  const [rates, summaries] = await Promise.all([listIftaRates(quarter), iftaRateQuarters(options)]);
  const here = summaries.find((s) => s.quarter === quarter)!;
  const sample = here.sample > 0;
  const surcharged = rates.filter((r) => r.surcharge !== "0.0000").length;
  const rows: Row[] = rates.map((r) => ({
    id: r.jurisdiction,
    cells: {
      jurisdiction: (
        <>
          <b>{r.jurisdiction}</b> <span className="dim">{r.name}</span>
        </>
      ),
      rate: `$${r.rate}`,
      surcharge: r.surcharge === "0.0000" ? <span className="dim">—</span> : `$${r.surcharge}`,
      status: (
        <span className="t-st" data-tone={r.status === "final" ? "ok" : "warn"}>
          {RATE_STATUS_LABEL[r.status]}
        </span>
      ),
      source: r.isSample ? (
        <span className="t-st" data-tone="bad">
          Sample, not for filing
        </span>
      ) : (
        (r.sourceFile ?? "—")
      )
    }
  }));

  return (
    <>
      <PageHead title="IFTA tax rates" sub="Each quarter's diesel tax rate by state, in US dollars a gallon, with any surcharge kept apart. The quarter's return multiplies by these.">
        <Link className="tl-btn" href={`/ifta?quarter=${quarter}`}>
          Back to IFTA
        </Link>
      </PageHead>
      <nav className="tl-tabs irate-tabs" aria-label="Quarter">
        {summaries.map((s) => (
          <Link key={s.quarter} href={`/ifta/rates?quarter=${s.quarter}`} className="tl-tab" aria-current={s.quarter === quarter ? "true" : undefined}>
            {s.quarter}
            <span className="dim"> {s.count === 0 ? "· none" : s.sample > 0 ? "· sample" : `· ${s.count}`}</span>
          </Link>
        ))}
      </nav>
      {sample ? (
        <p className="tl-note warn irate-note" role="note">
          <b>Sample rates, not for filing.</b> These numbers are made up so the demo has something to multiply by. They are not {quarter}&apos;s real rates. Import the quarter&apos;s rate table below to replace them.
        </p>
      ) : null}
      <div className="tl-grid cols-4">
        <Stat label="Rates kept" value={here.count > 0 ? String(here.count) : "—"} sub={here.count > 0 ? `${surcharged} with a surcharge` : "none for this quarter"} />
        <Stat label="Status" value={here.count === 0 ? "—" : here.final === here.count ? "Final" : here.final === 0 ? "Provisional" : "Mixed"} sub={here.count > 0 && here.final > 0 && here.final < here.count ? `${here.final} final, ${here.count - here.final} provisional` : undefined} tone={here.count > 0 && here.final < here.count ? "warn" : undefined} />
        <Stat label="From" value={here.count === 0 ? "—" : sample ? "Sample" : (here.sourceFile ?? "—")} sub={sample ? "made up, not for filing" : undefined} tone={sample ? "bad" : undefined} />
        <Stat label="Loaded" value={here.at ? dateTime(here.at) : "—"} />
      </div>
      <DataTable
        id="ifta-rates-table"
        label={`Tax rates, ${quarter}`}
        columns={COLUMNS}
        rows={rows}
        empty={
          <EmptyState icon="chart" title={`${quarter} has no tax rates`}>
            Import the quarter&apos;s rate table below. For a demo, sample rates can be loaded instead; they are labelled not for filing.
          </EmptyState>
        }
      />
      <IftaRatesPanel key={quarter} quarter={quarter} kept={{ count: here.count, sample: here.sample, final: here.final, sourceFile: here.sourceFile }} />
      <p className="tl-note irate-note">
        The file is read as IFTA, Inc.&apos;s quarterly rate table is laid out (an assumption until it is checked against a real file): one row per jurisdiction, diesel in US dollars a gallon, and a
        state&apos;s surcharge either in a Surcharge column or on a row of its own (&quot;Kentucky Surcharge&quot;). US states and DC are kept. Canadian provinces are counted and skipped: the desk
        does not work out Canadian fuel tax.
      </p>
    </>
  );
}
