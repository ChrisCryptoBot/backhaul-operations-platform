import Link from "next/link";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { Card, Empty, PageHead, Tabs } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { KpiMatrix } from "@/components/desk/kpi/matrix";
import { DriverLeaderboard } from "@/components/desk/kpi/leaderboard";
import { Bullets } from "@/components/desk/kpi/bullets";
import { DeadheadBars, VarianceHistogram } from "@/components/desk/kpi/distribution";
import { GrowthColumns, MonthlyBars, SmallMultiples } from "@/components/desk/kpi/trends";
import { LaneScorecard } from "@/components/desk/kpi/lanes";
import { ReasonsCard } from "@/components/desk/kpi/reasons";
import { hasFilters, kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { KPI_PERIODS, windowLabel } from "@/lib/kpi-periods";
import { shortDate, usd } from "@/lib/desk-format";

const FILTER_LABEL = { lane: "Lane", broker: "Broker", driver: "Driver", truck: "Truck" } as const;

export default async function KpiPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams(searchParams);
  const k = await getDeskKpi({ period: params.period, compare: params.compare, filters: params.filters });
  const href = (over: Partial<typeof params>) => kpiHref("/kpi", params, over);
  const mixTotal = Object.values(k.verdictMix).reduce((a, b) => a + b, 0);
  const mixPart = (n: number) => (mixTotal > 0 ? `${(n / mixTotal) * 100}%` : "0%");
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
        <form method="get" className="kfilters" aria-label="Filter the dashboard">
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
          <button type="submit" className="tl-btn sm">Apply</button>
          {hasFilters(params.filters) ? <Link href={href({ filters: {} })} replace className="tl-btn ghost sm">Clear filters</Link> : null}
        </form>
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

          <LaneScorecard k={k} />
        </div>
      )}

      <div className="tl-grid cols-3" style={{ marginTop: 16 }}>
        <Card title="Pipeline">
          <dl className="tl-kv">
            <dt>Needs a driver</dt><dd>{k.pipeline.needsDriver}</dd>
            <dt>Sent, waiting for an answer</dt><dd>{k.pipeline.sent}</dd>
            <dt>On the road</dt><dd>{k.pipeline.onTheRoad}</dd>
          </dl>
        </Card>
        <Card title="Open loads against your cost">
          {mixTotal === 0 ? (
            <Empty>No open loads.</Empty>
          ) : (
            <>
              <div className="tl-meter" role="img" aria-label="Verdict mix">
                <i style={{ width: mixPart(k.verdictMix.accept), background: "var(--db-pos-fill)" }} />
                <i style={{ width: mixPart(k.verdictMix.caution), background: "var(--db-warn-fill)" }} />
                <i style={{ width: mixPart(k.verdictMix.reject), background: "var(--db-neg-fill)" }} />
              </div>
              <dl className="tl-kv" style={{ marginTop: 10 }}>
                <dt>Cover your cost</dt><dd>{k.verdictMix.accept}</dd>
                <dt>Thin margin</dt><dd>{k.verdictMix.caution}</dd>
                <dt>Below your cost</dt><dd>{k.verdictMix.reject}</dd>
              </dl>
            </>
          )}
        </Card>
        <Card title="Money owed">
          {k.aging.count === 0 ? (
            <Empty>Nothing outstanding.</Empty>
          ) : (
            <dl className="tl-kv">
              <dt>Outstanding</dt><dd>{usd(k.aging.totalOutstanding)}</dd>
              <dt>Invoices</dt><dd>{k.aging.count}</dd>
              <dt>Overdue</dt><dd style={k.aging.overdueCount > 0 ? { color: "var(--db-neg)" } : undefined}>{k.aging.overdueCount}</dd>
              <dt>Oldest overdue</dt><dd>{k.aging.oldestDaysOverdue != null ? `${k.aging.oldestDaysOverdue} days` : "—"}</dd>
            </dl>
          )}
        </Card>
      </div>

      <div className="tl-grid cols-2" style={{ marginTop: 16 }}>
        <Card title="Top brokers">
          {k.analytics.summary.topBrokers.length === 0 ? (
            <Empty>No brokers in this period.</Empty>
          ) : (
            <table className="tl-table">
              <thead><tr><th>Broker</th><th className="num">Loads</th><th className="num">Revenue</th></tr></thead>
              <tbody>
                {k.analytics.summary.topBrokers.map((b) => (
                  <tr key={b.key}>
                    <td>{b.broker}</td>
                    <td className="num">{b.count}</td>
                    <td className="num">{usd(b.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Outstanding invoices, most overdue first">
          {k.outstanding.length === 0 ? (
            <Empty>Nothing outstanding.</Empty>
          ) : (
            <table className="tl-table">
              <thead><tr><th>Load</th><th>Broker</th><th className="num">Billed</th><th>Due</th><th className="num">Days past due</th></tr></thead>
              <tbody>
                {k.outstanding.slice(0, 8).map((o) => (
                  <tr key={o.id}>
                    <td><Link href={`/loads/${o.id}`}>{o.loadNumber}</Link></td>
                    <td>{o.broker}</td>
                    <td className="num">{usd(o.billed)}</td>
                    <td>{o.dueAt ? shortDate(new Date(o.dueAt)) : "—"}</td>
                    <td className="num" style={o.daysPastDue != null && o.daysPastDue > 0 ? { color: "var(--db-neg)" } : undefined}>
                      {o.daysPastDue == null ? "—" : o.daysPastDue > 0 ? o.daysPastDue : o.daysPastDue === 0 ? "due today" : `due in ${Math.abs(o.daysPastDue)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {k.outstanding.length > 8 ? <p className="tl-note" style={{ marginTop: 10 }}><Link href="/invoices">All {k.outstanding.length} on the Invoices page</Link></p> : null}
        </Card>
      </div>
    </>
  );
}
