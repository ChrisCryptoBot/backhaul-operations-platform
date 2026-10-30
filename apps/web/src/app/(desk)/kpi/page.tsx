import Link from "next/link";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { Card, PageHead, Tabs } from "@/components/desk/ui";
import { LiveForm } from "@/components/desk/live-form";
import { EmptyState } from "@/components/desk/kit/states";
import { KpiMatrix } from "@/components/desk/kpi/matrix";
import { DriverLeaderboard } from "@/components/desk/kpi/leaderboard";
import { Bullets } from "@/components/desk/kpi/bullets";
import { DeadheadBars, VarianceHistogram } from "@/components/desk/kpi/distribution";
import { GrowthColumns, MonthlyBars, SmallMultiples } from "@/components/desk/kpi/trends";
import { ReasonsCard } from "@/components/desk/kpi/reasons";
import { hasFilters, kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { usd } from "@/lib/desk-format";

export const metadata = { title: "KPI dashboard · TrueLane" };

const FILTER_LABEL = { lane: "Lane", broker: "Customer", driver: "Driver", truck: "Truck" } as const;

export default async function KpiPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams(searchParams);
  const k = await getDeskKpi({ period: params.period, compare: params.compare, filters: params.filters });
  const href = (over: Partial<typeof params>) => kpiHref("/kpi", params, over);
  const choices = { lane: k.choices.lanes, broker: k.choices.brokers, driver: k.choices.drivers, truck: k.choices.trucks };
  const csv = (kind: string) => kpiHref(`/export/${kind}`, params);

  return (
    <>
      <PageHead title="KPI dashboard" sub="Revenue, miles, empty miles, market and money owed, computed from the loads with the same math the phone uses.">
        <Link href={kpiHref("/kpi/report", params)} className="tl-btn">Management report</Link>
        <details className="menu">
          <summary className="tl-btn">Export CSV</summary>
          <div className="menu-pop">
            <a href={csv("kpi-drivers")}>Drivers</a>
            <a href={csv("kpi-lanes")}>Lanes</a>
            <a href={csv("kpi-weeks")}>Twelve weeks</a>
          </div>
        </details>
      </PageHead>

      <div className="kbar">
        <Tabs active={params.period} hrefFor={(key) => href({ period: key as typeof params.period })} items={KPI_PERIODS} />
        {params.period !== "all" ? (
          <Link href={href({ compare: !params.compare })} className="tl-tab" aria-current={params.compare ? "true" : undefined} title="Show how each number moved against the period before">
            Compare with the period before
          </Link>
        ) : null}
        <LiveForm path="/kpi" label="Filter the dashboard" className="kfilters">
          {params.period !== "4w" ? <input type="hidden" name="period" value={params.period} /> : null}
          {!params.compare ? <input type="hidden" name="compare" value="off" /> : null}
          {params.dh === "miles" ? <input type="hidden" name="dh" value="miles" /> : null}
          {(Object.keys(FILTER_LABEL) as Array<keyof typeof FILTER_LABEL>).map((f) => (
            <label key={f} className="tl-field">
              <span className="db-sr-only">{FILTER_LABEL[f]}</span>
              <select name={f} defaultValue={params.filters[f] ?? ""} aria-label={FILTER_LABEL[f]}>
                <option value="">All {FILTER_LABEL[f].toLowerCase()}s</option>
                {choices[f].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </label>
          ))}
          {hasFilters(params.filters) ? <Link href={href({ filters: {} })} replace className="tl-btn ghost sm">Clear filters</Link> : null}
        </LiveForm>
      </div>
      <p className="tl-sub" style={{ margin: "0 0 14px" }}>
        {windowLabel(k.window)}
        {k.previous ? ` · compared with ${windowLabel(k.previous)}` : ""}
        {hasFilters(params.filters) ? ` · ${Object.entries(params.filters).map(([f, v]) => `${FILTER_LABEL[f as keyof typeof FILTER_LABEL]}: ${v}`).join(", ")}` : ""}
      </p>

      {k.current.loads === 0 ? (
        <EmptyState icon="chart" title="No finished loads here">
          Nothing finished in this period{hasFilters(params.filters) ? " with those filters" : ""}. Try All time{hasFilters(params.filters) ? ", or clear the filters" : ""}.
        </EmptyState>
      ) : (
        <div className="kstack">
          <KpiMatrix k={k} />

          <div className="tl-grid cols-2">
            <SmallMultiples k={k} />
            <GrowthColumns k={k} />
          </div>

          <div className="tl-grid cols-2">
            <DriverLeaderboard drivers={k.drivers} thresholds={k.thresholds} mode={params.dh} hrefFor={(dh) => href({ dh })} />
            <Bullets k={k} />
          </div>

          <div className="tl-grid cols-2">
            <VarianceHistogram k={k} />
            <DeadheadBars k={k} />
          </div>

          <div className="tl-grid cols-2">
            <ReasonsCard k={k} />
            <MonthlyBars k={k} />
          </div>

        </div>
      )}

      <Card title="Open now" className="tl-card">
        <ul className="kopen">
          <li>
            <Link href="/dispatch">Needs a driver</Link>
            <span className="v">{k.pipeline.needsDriver}</span>
          </li>
          <li>
            <Link href="/dispatch">Sent, waiting for an answer</Link>
            <span className="v">{k.pipeline.sent}</span>
          </li>
          <li>
            <Link href="/loads">On the road</Link>
            <span className="v">{k.pipeline.onTheRoad}</span>
          </li>
          <li>
            <Link href="/loads">Open loads below your cost</Link>
            <span className="v">{k.verdictMix.reject}</span>
          </li>
          <li>
            <Link href="/invoices">Still out</Link>
            <span className={`v${k.aging.overdueCount > 0 ? " bad" : ""}`}>
              {k.aging.count === 0 ? "nothing" : `${usd(k.aging.totalOutstanding)} · ${k.aging.overdueCount > 0 ? `${k.aging.overdueCount} overdue${k.aging.oldestDaysOverdue != null ? `, oldest ${k.aging.oldestDaysOverdue} days` : ""}` : "none overdue"}`}
            </span>
          </li>
        </ul>
        <p className="tl-note" style={{ marginTop: 10 }}>
          The scorecards for <Link href="/lanes">each lane</Link> and <Link href="/customers">each customer</Link> are on their own pages.
        </p>
      </Card>
    </>
  );
}
