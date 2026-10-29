import Link from "next/link";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { shortLane } from "@/components/desk/kpi/parts";
import { hasFilters, kpiHref, parseKpiParams } from "@/lib/kpi-params";
import { windowLabel } from "@/lib/kpi-periods";
import { deltaOf, type Delta } from "@/lib/kpi-view";
import { dateTime, miles, pct, perMile, shortDate, signedPct, usd } from "@/lib/desk-format";

const FILTER_LABEL = { lane: "Lane", broker: "Broker", driver: "Driver", truck: "Truck" } as const;
const PERIOD_NAME = { "4w": "Last four weeks", month: "This month", ytd: "Year to date", all: "All time" } as const;

/** A one-sheet management report for the period and filters on the dashboard. Print it, or save it as a PDF from the print dialog. */
export default async function KpiReportPage({ searchParams }: { searchParams?: Record<string, string | string[] | undefined> }) {
  const params = parseKpiParams(searchParams);
  const now = new Date();
  const k = await getDeskKpi({ period: params.period, compare: params.compare, filters: params.filters }, now);
  const c = k.current;
  const p = k.prior;

  const rows: Array<{ label: string; now: string; before: string; delta: Delta | null }> = [
    { label: "Gross revenue", now: usd(c.gross), before: p ? usd(p.gross) : "—", delta: deltaOf(c.gross, p?.gross, { kind: "pct" }) },
    { label: "Gross after tracked fuel, tolls and other costs", now: usd(c.netEstimate), before: p ? usd(p.netEstimate) : "—", delta: deltaOf(c.netEstimate, p?.netEstimate, { kind: "pct" }) },
    { label: "Per revenue mile", now: perMile(c.rpm), before: p ? perMile(p.rpm) : "—", delta: deltaOf(c.rpm, p?.rpm, { kind: "pct" }) },
    { label: "Loads finished (a TONU counts)", now: String(c.loads), before: p ? String(p.loads) : "—", delta: deltaOf(c.loads, p?.loads, { kind: "pct" }) },
    { label: "Miles driven", now: miles(c.totalMiles), before: p ? miles(p.totalMiles) : "—", delta: null },
    { label: "Empty miles, share of miles driven", now: pct(c.emptyShare, 1), before: p ? pct(p.emptyShare, 1) : "—", delta: deltaOf(c.emptyShare, p?.emptyShare, { kind: "pts", lowerIsBetter: true }) },
    { label: "Loads that cleared the truck's floor", now: pct(c.clearedFloor), before: p ? pct(p.clearedFloor) : "—", delta: deltaOf(c.clearedFloor, p?.clearedFloor, { kind: "pts" }) },
    { label: "Invoices paid within terms", now: pct(c.paidWithinTerms), before: p ? pct(p.paidWithinTerms) : "—", delta: deltaOf(c.paidWithinTerms, p?.paidWithinTerms, { kind: "pts" }) },
    { label: "Days to pay", now: c.avgDaysToPay == null ? "—" : c.avgDaysToPay.toFixed(1), before: p?.avgDaysToPay == null ? "—" : p.avgDaysToPay.toFixed(1), delta: deltaOf(c.avgDaysToPay, p?.avgDaysToPay, { kind: "pct", lowerIsBetter: true }) },
    { label: "Average wait at a stop (minutes)", now: c.avgWaitMinutes == null ? "—" : c.avgWaitMinutes.toFixed(0), before: p?.avgWaitMinutes == null ? "—" : p.avgWaitMinutes.toFixed(0), delta: deltaOf(c.avgWaitMinutes, p?.avgWaitMinutes, { kind: "pct", lowerIsBetter: true }) }
  ];

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href={kpiHref("/kpi", params)} className="tl-btn">Back to the dashboard</Link>
        <PrintButton />
      </div>
      <article className="rp">
        <h1>Management report</h1>
        <p className="rp-meta">
          {PERIOD_NAME[params.period]}: {windowLabel(k.window)}
          {k.previous ? ` · compared with ${windowLabel(k.previous)}` : ""}
        </p>
        {hasFilters(params.filters) ? (
          <p className="rp-meta">Filtered to {Object.entries(params.filters).map(([f, v]) => `${FILTER_LABEL[f as keyof typeof FILTER_LABEL].toLowerCase()} ${v}`).join(", ")}</p>
        ) : null}
        <p className="rp-meta">Prepared {dateTime(now)}</p>

        <h2>Summary</h2>
        {c.loads === 0 ? (
          <p>No loads finished in this period.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Measure</th>
                <th className="num">This period</th>
                <th className="num">{k.previous ? "Before" : ""}</th>
                <th className="num">{k.previous ? "Change" : ""}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td className="num">{r.now}</td>
                  <td className="num">{k.previous ? r.before : ""}</td>
                  <td className={`num ${r.delta?.tone === "good" ? "rp-good" : r.delta?.tone === "bad" ? "rp-bad" : ""}`}>{k.previous && r.delta ? `${r.delta.glyph} ${r.delta.text}` : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Drivers</h2>
        {k.drivers.length === 0 ? (
          <p>No finished loads with a driver in this period.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Driver</th><th className="num">Loads</th><th className="num">Gross</th><th className="num">Per mile</th><th className="num">Empty miles</th><th className="num">Pay owed (estimate)</th></tr>
            </thead>
            <tbody>
              {k.drivers.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td className="num">{d.loads}</td>
                  <td className="num">{usd(d.gross)}</td>
                  <td className="num">{perMile(d.rpm)}</td>
                  <td className="num">{pct(d.emptyShare, 1)}</td>
                  <td className="num">{usd(d.payOwed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Lanes</h2>
        {k.lanes.length === 0 ? (
          <p>No finished loads in this period.</p>
        ) : (
          <table>
            <thead>
              <tr><th>Lane</th><th className="num">Loads</th><th className="num">Gross</th><th className="num">Per mile</th><th className="num">Empty miles</th><th className="num">Against market</th></tr>
            </thead>
            <tbody>
              {k.lanes.map((l) => (
                <tr key={l.key}>
                  <td>{shortLane(l.key)}</td>
                  <td className="num">{l.loads}</td>
                  <td className="num">{usd(l.gross)}</td>
                  <td className="num">{perMile(l.rpm)}</td>
                  <td className="num">{pct(l.emptyShare, 1)}</td>
                  <td className={`num ${l.marketVariancePct == null ? "" : l.marketVariancePct < 0 ? "rp-bad" : "rp-good"}`}>{l.marketVariancePct == null ? "no market rate" : signedPct(l.marketVariancePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <h2>Money owed</h2>
        {k.aging.count === 0 ? (
          <p>Nothing outstanding.</p>
        ) : (
          <>
            <p>
              {usd(k.aging.totalOutstanding)} outstanding on {k.aging.count} {k.aging.count === 1 ? "invoice" : "invoices"}; {k.aging.overdueCount} overdue
              {k.aging.oldestDaysOverdue != null ? `, the oldest by ${k.aging.oldestDaysOverdue} days` : ""}.
            </p>
            <table>
              <thead>
                <tr><th>Load</th><th>Broker</th><th className="num">Billed</th><th>Due</th><th className="num">Days past due</th></tr>
              </thead>
              <tbody>
                {k.outstanding.map((o) => (
                  <tr key={o.id}>
                    <td>{o.loadNumber}</td>
                    <td>{o.broker}</td>
                    <td className="num">{usd(o.billed)}</td>
                    <td>{o.dueAt ? shortDate(new Date(o.dueAt)) : "—"}</td>
                    <td className="num">{o.daysPastDue == null ? "—" : o.daysPastDue > 0 ? o.daysPastDue : o.daysPastDue === 0 ? "due today" : `due in ${Math.abs(o.daysPastDue)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        <h2>How these are worked out</h2>
        <p>Gross is the line-haul plus fuel surcharge and layover. Per mile is gross over the miles the pay covers. Empty miles are deadhead over every mile driven, as a ratio of sums.</p>
        <p>
          Cleared the floor: pay after tracked fuel, tolls and other costs, per mile driven, at or above the truck&apos;s floor frozen when the load was accepted. Paid within terms and days to pay use paid invoices only.
          Against market compares all-in pay with the market rate captured for the load, over the planned miles. Pay owed is the estimate shown on each assignment; the phone works out the final payout.
        </p>
        <p className="rp-foot">Sample data only. Every name, broker and number here is invented.</p>
      </article>
    </>
  );
}
