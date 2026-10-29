import Link from "next/link";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { PageHead, Tabs } from "@/components/desk/ui";
import { ChartFrame } from "@/components/desk/kpi/parts";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { perMile, signedPct, usd } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "broker", label: "Broker", sticky: true, width: 230 },
  { key: "loads", label: "Loads", align: "num" },
  { key: "gross", label: "Gross", align: "num" },
  { key: "rpm", label: "Per mile", align: "num" },
  { key: "market", label: "Against market", align: "num" },
  { key: "pay", label: "Days to pay", align: "num" },
  { key: "wait", label: "Wait at a stop", align: "num" },
  { key: "lost", label: "Fell through", align: "num" }
];

/** What each broker is worth: what they pay, how it compares with the market, how fast they pay, how long drivers wait, how often they let a load fall through. */
export default async function BrokersPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams({ ...searchParams, period: searchParams?.period ?? "all" });
  const k = await getDeskKpi({ period: params.period, compare: false });
  const query = params.period === "all" ? "" : `?period=${params.period}`;

  const rows: Row[] = k.brokers.map((b) => ({
    id: b.name,
    search: b.name,
    cells: {
      broker: (
        <>
          <Link href={`/kpi?broker=${encodeURIComponent(b.name)}${params.period === "all" ? "&period=all" : `&period=${params.period}`}`}>{b.name}</Link>
          <span className="sub">
            <Link href={`/loads?q=${encodeURIComponent(b.name)}`}>Their loads</Link>
          </span>
        </>
      ),
      loads: b.loads,
      gross: usd(b.gross),
      rpm: perMile(b.rpm),
      market: b.marketVariancePct == null ? <span className="dim">no market rate</span> : <span className={b.marketVariancePct < 0 ? "tone-neg" : "tone-pos"}>{signedPct(b.marketVariancePct)}</span>,
      pay: b.avgDaysToPay == null ? <span className="dim">—</span> : `${b.avgDaysToPay.toFixed(1)} days`,
      wait: b.avgWaitMinutes == null ? <span className="dim">—</span> : `${b.avgWaitMinutes.toFixed(0)} min`,
      lost: b.lost > 0 ? <span className="tone-warn">{b.lost}</span> : <span className="dim">0</span>
    }
  }));

  const slow = [...k.brokers].filter((b) => b.avgDaysToPay != null).sort((a, b) => b.avgDaysToPay! - a.avgDaysToPay!)[0];
  return (
    <>
      <PageHead title="Brokers" sub="What each broker pays, how fast, and how often a load falls through. Worked out from the finished loads in the period.">
        <a className="tl-btn" href={`/export/kpi-brokers${query}`}>Export CSV</a>
      </PageHead>
      <Tabs active={params.period} hrefFor={(key) => (key === "all" ? "/brokers" : `/brokers?period=${key}`)} items={KPI_PERIODS} />
      <p className="tl-sub" style={{ margin: "0 0 12px" }}>{windowLabel(k.window)}</p>
      <ChartFrame
        title="Broker scorecard"
        unit="finished loads in the period, by broker"
        empty={k.brokers.length === 0 ? "No finished loads in this period." : undefined}
        caption={slow ? `${slow.name} is the slowest to pay: ${slow.avgDaysToPay!.toFixed(1)} days on average over ${slow.paidLoads} paid ${slow.paidLoads === 1 ? "invoice" : "invoices"}.` : "No paid invoices in this period to measure payment speed."}
        formula="Against market is (Σ all-in pay − Σ market total) ÷ Σ market total over the broker's loads that carry a market rate. Days to pay is invoice to payment on paid invoices. Wait is the mean recorded wait at a stop. Fell through counts cancelled loads and TONUs.">
        <DataTableTools tableId="brokers-table" total={rows.length} placeholder="Search brokers…" />
        <DataTable id="brokers-table" label="Broker scorecard" columns={COLUMNS} rows={rows} />
      </ChartFrame>
    </>
  );
}
