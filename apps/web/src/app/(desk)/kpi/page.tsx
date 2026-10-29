import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import type { AnalyticsPeriod } from "@/truelane/lib/analytics";
import { Bars, Card, Empty, PageHead, Stat, Tabs } from "@/components/desk/ui";
import { miles, pct, perMile, shortDate, signedPct, usd } from "@/lib/desk-format";

const PERIODS: Array<{ key: AnalyticsPeriod; label: string }> = [
  { key: "month", label: "This month" },
  { key: "ytd", label: "Year to date" },
  { key: "all", label: "All time" }
];

const shortLane = (a: string, b: string) => `${a.split(",")[0]} → ${b.split(",")[0]}`;

export default async function KpiPage({ searchParams }: { searchParams?: { period?: string } }) {
  const period = (PERIODS.find((p) => p.key === searchParams?.period)?.key ?? "all") as AnalyticsPeriod;
  const k = await getDeskKpi(period);
  const s = k.analytics.summary;
  const dis = k.analytics.disparity;
  const mixTotal = Object.values(k.verdictMix).reduce((a, b) => a + b, 0);
  const mixPart = (n: number) => (mixTotal > 0 ? `${(n / mixTotal) * 100}%` : "0%");

  return (
    <>
      <PageHead title="KPI dashboard" sub="Revenue, miles, empty miles, market and money owed, computed from the loads with the same math the phone uses.">
        <span className="tl-sub">{period === "all" ? "Every finished load" : period === "ytd" ? "This year" : "This month"}</span>
      </PageHead>
      <Tabs active={period} hrefFor={(key) => `/kpi?period=${key}`} items={PERIODS} />

      {s.loadCount === 0 ? (
        <Card><Empty>No finished loads in this period yet. Try All time.</Empty></Card>
      ) : (
        <>
          <div className="tl-grid cols-4">
            <Stat label="Gross revenue" value={usd(s.grossRevenue)} sub={`${s.loadCount} finished ${s.loadCount === 1 ? "load" : "loads"}`} />
            <Stat label="Gross minus tracked costs" value={usd(s.netEstimate)} sub={`fuel, tolls and other: ${usd(s.totalExpenses)}`} tone={s.netEstimate >= 0 ? "ok" : "bad"} />
            <Stat label="Average per revenue mile" value={perMile(s.avgRpm)} sub={`${miles(s.totalMiles)} driven`} />
            <Stat label="Empty miles" value={pct(k.deadheadShare)} sub="of every mile driven" tone={k.deadheadShare != null && k.deadheadShare > 0.3 ? "warn" : undefined} />
          </div>

          <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
            <Card title="Revenue by week, last 12 weeks">
              <Bars data={k.weekly} format={(n) => (n === 0 ? "" : `$${(n / 1000).toFixed(1)}k`)} />
            </Card>
            <Card title="Revenue by month">
              <Bars data={k.analytics.monthly.map((m) => ({ label: m.label, value: Math.round(m.revenue) }))} format={(n) => (n === 0 ? "" : `$${(n / 1000).toFixed(1)}k`)} />
            </Card>
          </div>
        </>
      )}

      <div className="tl-grid cols-3" style={{ marginTop: 14 }}>
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
                <i style={{ width: mixPart(k.verdictMix.accept), background: "var(--db-pos)" }} />
                <i style={{ width: mixPart(k.verdictMix.caution), background: "var(--db-warn)" }} />
                <i style={{ width: mixPart(k.verdictMix.reject), background: "var(--db-neg)" }} />
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

      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Top lanes">
          {s.topLanes.length === 0 ? (
            <Empty>No lanes yet.</Empty>
          ) : (
            <table className="tl-table">
              <thead><tr><th>Lane</th><th className="num">Loads</th><th className="num">Revenue</th><th className="num">$/mi</th></tr></thead>
              <tbody>
                {s.topLanes.map((l) => (
                  <tr key={l.key}>
                    <td>{shortLane(l.origin, l.destination)}</td>
                    <td className="num">{l.count}</td>
                    <td className="num">{usd(l.revenue)}</td>
                    <td className="num">{perMile(l.miles > 0 ? l.revenue / l.miles : null)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Top brokers">
          {s.topBrokers.length === 0 ? (
            <Empty>No brokers yet.</Empty>
          ) : (
            <table className="tl-table">
              <thead><tr><th>Broker</th><th className="num">Loads</th><th className="num">Revenue</th></tr></thead>
              <tbody>
                {s.topBrokers.map((b) => (
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
      </div>

      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title={dis ? `Against the market · ${dis.benchmarkedLoadCount} loads with a market rate` : "Against the market"}>
          {!dis ? (
            <Empty>Add a market rate when you price a load, and this shows how far above or below market you are landing.</Empty>
          ) : (
            <>
              <dl className="tl-kv">
                <dt>Average against market</dt><dd>{signedPct(dis.avgVariancePct)}</dd>
                <dt>Your pay per mile on these loads</dt><dd>{perMile(dis.avgActualRpm)}</dd>
                <dt>Market per mile (every mile)</dt><dd>{perMile(dis.avgBenchmarkRpm)}</dd>
              </dl>
              {dis.byLane.length > 0 ? (
                <>
                  <h2 style={{ marginTop: 14 }}>Lanes where you land furthest under market</h2>
                  <table className="tl-table">
                    <tbody>
                      {dis.byLane.map((g) => (
                        <tr key={g.key}>
                          <td>{g.label}</td>
                          <td className="num">{g.count} {g.count === 1 ? "load" : "loads"}</td>
                          <td className="num" style={{ color: g.avgVariancePct < 0 ? "var(--db-neg)" : "var(--db-pos)" }}>{signedPct(g.avgVariancePct)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : null}
            </>
          )}
        </Card>
        <Card title="Drivers">
          {k.drivers.length === 0 ? (
            <Empty>No finished loads with a driver in this period.</Empty>
          ) : (
            <table className="tl-table">
              <thead><tr><th>Driver</th><th className="num">Loads</th><th className="num">Gross</th><th className="num">$/mi</th><th className="num">Pay owed</th></tr></thead>
              <tbody>
                {k.drivers.map((d) => (
                  <tr key={d.name}>
                    <td>{d.name}</td>
                    <td className="num">{d.loads}</td>
                    <td className="num">{usd(d.gross)}</td>
                    <td className="num">{perMile(d.rpm)}</td>
                    <td className="num">{usd(d.payOwed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="tl-note" style={{ marginTop: 10 }}>Pay owed is the display estimate from each assignment; the phone works out the final payout.</p>
        </Card>
      </div>

      {k.outstanding.length > 0 ? (
        <Card title="Outstanding invoices, most overdue first" className="tl-card">
          <table className="tl-table">
            <thead><tr><th>Load</th><th>Broker</th><th className="num">Billed</th><th>Due</th><th className="num">Days past due</th></tr></thead>
            <tbody>
              {k.outstanding.map((o) => (
                <tr key={o.id}>
                  <td>{o.loadNumber}</td>
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
        </Card>
      ) : null}
    </>
  );
}
