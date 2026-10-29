import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { PageHead, Tabs } from "@/components/desk/ui";
import { LaneScorecard } from "@/components/desk/kpi/lanes";
import { DataTableTools } from "@/components/desk/data-table-tools";
import { parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";

/** Every lane that finished a load in the period: what it paid per mile, against the market, and where the empty miles are. */
export default async function LanesPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams({ ...searchParams, period: searchParams?.period ?? "all" });
  const k = await getDeskKpi({ period: params.period, compare: false });
  const query = params.period === "all" ? "" : `?period=${params.period}`;
  return (
    <>
      <PageHead title="Lanes" sub="Each pair of cities you have hauled between: what it paid per mile, how that sits against the market, and how much of the driving was empty.">
        <a className="tl-btn" href={`/export/kpi-lanes${query}`}>Export CSV</a>
      </PageHead>
      <Tabs active={params.period} hrefFor={(key) => (key === "all" ? "/lanes" : `/lanes?period=${key}`)} items={KPI_PERIODS} />
      <p className="tl-sub" style={{ margin: "0 0 12px" }}>{windowLabel(k.window)}</p>
      <DataTableTools tableId="kpi-lanes" total={k.lanes.length} placeholder="Search lanes…" />
      <LaneScorecard k={k} />
    </>
  );
}
