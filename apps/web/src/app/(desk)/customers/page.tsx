import Link from "next/link";
import React from "react";
import { getDeskKpi, type BrokerKpi } from "@/server/tl/kpi";
import { listCustomerRecords } from "@/server/tl/customers";
import { PageHead, Tabs } from "@/components/desk/ui";
import { ChartFrame } from "@/components/desk/kpi/parts";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { kindLabel } from "@/lib/customer";
import { parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { perMile, signedPct, usd } from "@/lib/desk-format";

export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "broker", sortable: true, label: "Customer", sticky: true, width: 230 },
  { key: "kind", sortable: true, label: "Kind" },
  { key: "loads", sortable: true, label: "Loads", align: "num" },
  { key: "gross", sortable: true, label: "Gross", align: "num" },
  { key: "rpm", sortable: true, label: "Per mile", align: "num" },
  { key: "market", sortable: true, label: "Against market", align: "num" },
  { key: "pay", sortable: true, label: "Days to pay", align: "num" },
  { key: "wait", sortable: true, label: "Wait at a stop", align: "num" },
  { key: "lost", sortable: true, label: "Fell through", align: "num" }
];

const empty = (name: string): BrokerKpi => ({ name, loads: 0, gross: 0, rpm: null, marketVariancePct: null, benchmarked: 0, paidLoads: 0, avgDaysToPay: null, avgWaitMinutes: null, waitStops: 0, lost: 0 });

/** Who the loads are for: what each customer pays, how fast, and how often a load falls through, with the record (kind, MC, terms) beside it. */
export default async function CustomersPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams({ ...searchParams, period: searchParams?.period ?? "all" });
  const [k, records] = await Promise.all([getDeskKpi({ period: params.period, compare: false }), listCustomerRecords()]);
  const query = params.period === "all" ? "" : `?period=${params.period}`;
  const byName = new Map(records.map((r) => [r.name.toLowerCase(), r]));

  // Every customer with finished loads in the period, and every customer with a record even when it has none yet.
  const known = new Set(k.brokers.map((b) => b.name.toLowerCase()));
  const all = [...k.brokers, ...records.filter((r) => !known.has(r.name.toLowerCase())).map((r) => empty(r.name))];

  const rows: Row[] = all.map((b) => {
    const rec = byName.get(b.name.toLowerCase());
    return {
      id: b.name,
      search: [b.name, rec?.mcNumber, rec ? kindLabel(rec.kind) : null].filter(Boolean).join(" "),
      cells: {
        broker: (
          <>
            <Link href={rec ? `/customers/${rec.id}` : `/customers/new?name=${encodeURIComponent(b.name)}`}>
              <b>{b.name}</b>
            </Link>
            <span className="sub">
              {rec?.mcNumber ? `MC ${rec.mcNumber} · ` : ""}
              <Link href={`/loads?q=${encodeURIComponent(b.name)}`}>Their loads</Link>
            </span>
          </>
        ),
        kind: rec ? kindLabel(rec.kind) : <span className="dim">no details yet</span>,
        loads: b.loads,
        gross: usd(b.gross),
        rpm: perMile(b.rpm),
        market: b.marketVariancePct == null ? <span className="dim">no market rate</span> : <span className={b.marketVariancePct < 0 ? "tone-neg" : "tone-pos"}>{signedPct(b.marketVariancePct)}</span>,
        pay: b.avgDaysToPay == null ? <span className="dim">—</span> : `${b.avgDaysToPay.toFixed(1)} days`,
        wait: b.avgWaitMinutes == null ? <span className="dim">—</span> : `${b.avgWaitMinutes.toFixed(0)} min`,
        lost: b.lost > 0 ? <span className="tone-warn">{b.lost}</span> : <span className="dim">0</span>
      }
    };
  });

  const slow = [...k.brokers].filter((b) => b.avgDaysToPay != null).sort((a, b) => b.avgDaysToPay! - a.avgDaysToPay!)[0];
  return (
    <>
      <PageHead title="Customers" sub="Who the loads are for: what each pays, how fast, and how often a load falls through. Open one for its record and its history.">
        <a className="tl-btn" href={`/export/kpi-brokers${query}`}>Export CSV</a>
        <Link href="/customers/new" className="tl-btn primary">Add a customer</Link>
      </PageHead>
      <Tabs active={params.period} hrefFor={(key) => (key === "all" ? "/customers" : `/customers?period=${key}`)} items={KPI_PERIODS} />
      <p className="tl-sub" style={{ margin: "0 0 12px" }}>{windowLabel(k.window)}</p>
      <ChartFrame
        title="Customer scorecard"
        unit="finished loads in the period, by customer"
        empty={all.length === 0 ? "No finished loads in this period." : undefined}
        caption={slow ? `${slow.name} is the slowest to pay: ${slow.avgDaysToPay!.toFixed(1)} days on average over ${slow.paidLoads} paid ${slow.paidLoads === 1 ? "invoice" : "invoices"}.` : "No paid invoices in this period to measure payment speed."}
        formula="Against market is (Σ all-in pay − Σ market total) ÷ Σ market total over the customer's loads that carry a market rate. Days to pay is invoice to payment on paid invoices. Wait is the mean recorded wait at a stop. Fell through counts cancelled loads and TONUs.">
        <DataTableTools tableId="brokers-table" total={rows.length} placeholder="Search customers…" />
        <DataTable id="brokers-table" label="Customer scorecard" columns={COLUMNS} rows={rows} />
      </ChartFrame>
    </>
  );
}
