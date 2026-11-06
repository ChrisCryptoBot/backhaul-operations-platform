import { termList } from "@/lib/scope";
import { currentTerminal } from "@/server/tl/terminal";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { PageHead, Tabs } from "@/components/desk/ui";
import { LANE_SORTERS, LaneScorecard } from "@/components/desk/kpi/lanes";
import { LaneWeeksCard } from "@/components/desk/kpi/operations";
import { checkAccess } from "@/server/tl/access";
import { DataTableTools } from "@/components/desk/data-table-tools";
import type { SortHref } from "@/components/desk/data-table";
import { Pager } from "@/components/desk/pager";
import { parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { listPage } from "@/lib/list-page";
import { asPage, nextSortParam } from "@/lib/paging";

export const metadata = { title: "Lanes · TrueLane" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Every lane that finished a load in the period: what it paid per mile, against the market, and where the empty miles are. A big fleet has hundreds, so they are searched, sorted and paged on the server. */
export default async function LanesPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams({ ...searchParams, period: searchParams?.period ?? "all" });
  const [k, edit] = await Promise.all([getDeskKpi({ period: params.period, compare: false, terminals: termList(await currentTerminal()) }), checkAccess("dispatch", "bill")]);
  const query = params.period === "all" ? "" : `?period=${params.period}`;
  const list = listPage(k.lanes, { q: one(searchParams?.q), sort: one(searchParams?.sort), page: asPage(one(searchParams?.page)), text: (l) => l.key, sorters: LANE_SORTERS });
  const href = (over: { sort?: string | null; page?: number; q?: string }) => {
    const u = new URLSearchParams();
    if (params.period !== "all") u.set("period", params.period);
    const q = over.q ?? list.q;
    if (q) u.set("q", q);
    const sort = "sort" in over ? over.sort : one(searchParams?.sort);
    if (sort) u.set("sort", sort);
    if (over.page && over.page > 1) u.set("page", String(over.page));
    const s = u.toString();
    return s ? `/lanes?${s}` : "/lanes";
  };
  const sortHref: SortHref = (key) => ({ href: href({ sort: nextSortParam(list.sort, key) }), dir: list.sort?.key === key ? list.sort.dir : "none" });
  return (
    <>
      <PageHead title="Lanes" sub="Each pair of cities you have hauled between: what it paid per mile, how that sits against the market, and how much of the driving was empty.">
        <a className="tl-btn" href={`/export/kpi-lanes${query}`}>Export CSV</a>
      </PageHead>
      <Tabs active={params.period} hrefFor={(key) => (key === "all" ? "/lanes" : `/lanes?period=${key}`)} items={KPI_PERIODS} />
      <p className="tl-sub" style={{ margin: "0 0 12px" }}>{windowLabel(k.window)}</p>
      <DataTableTools tableId="kpi-lanes" total={list.total} placeholder="Search lanes…" server={{ path: "/lanes", q: list.q, keep: { ...(params.period !== "all" ? { period: params.period } : {}), ...(list.sort ? { sort: `${list.sort.dir === "desc" ? "-" : ""}${list.sort.key}` } : {}) } }} />
      <LaneScorecard k={k} canEdit={edit.ok} lanes={list.rows} sortHref={sortHref} />
      <Pager page={list.page} pageSize={list.pageSize} total={list.total} hrefFor={(n) => href({ page: n })} newer="Previous" older="Next" />
      <LaneWeeksCard k={k} />
    </>
  );
}
