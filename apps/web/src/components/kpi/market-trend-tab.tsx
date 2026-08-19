"use client";

import Link from "next/link";
import React from "react";
import type { PeriodRollup, VarianceLogView } from "@/server/dat/variance-log";

const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const signedPct = (n: number) => `${n >= 0 ? "+" : "−"}${(Math.abs(n) * 100).toFixed(1)}%`;

/**
 * Market-variance trend inside the KPI dashboard. Fetches the same tracker the
 * Market Variance module writes (loads auto-log into it), and shows portfolio
 * variance vs DAT market week-over-week. Loads once when the tab first opens.
 */
export function MarketTrendTab({ active }: { active: boolean }) {
  const [view, setView] = React.useState<VarianceLogView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [unit, setUnit] = React.useState<"day" | "week">("week");
  const loadedRef = React.useRef(false);

  React.useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    setLoading(true);
    fetch("/api/market-variance")
      .then(async (r) => {
        const v = (await r.json().catch(() => null)) as VarianceLogView | null;
        if (!r.ok || !v) throw new Error("failed");
        setView(v);
      })
      .catch(() => setError("Unable to load market variance."))
      .finally(() => setLoading(false));
  }, [active]);

  const rollups: PeriodRollup[] = view ? (unit === "day" ? view.daily : view.weekly) : [];

  return (
    <div className="db-trend">
      <div className="db-tab-headrow">
        <h2 className="db-tab-h">Market variance trend</h2>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <button type="button" className={`db-btn db-btn-mini${unit === "day" ? " primary" : " db-btn-ghost"}`} onClick={() => setUnit("day")}>Day</button>
          <button type="button" className={`db-btn db-btn-mini${unit === "week" ? " primary" : " db-btn-ghost"}`} onClick={() => setUnit("week")}>Week</button>
          <Link href="/market-variance" className="db-btn db-btn-ghost db-btn-mini">Open tool</Link>
        </div>
      </div>

      {loading ? <p className="dim">Loading…</p> : null}
      {error ? <p className="db-upload-error">{error}</p> : null}

      {view && view.brief?.currentWeek ? (
        <p className="dim" style={{ fontSize: 13 }}>
          This week ({view.brief.currentWeek.period}): {view.brief.currentWeek.entryCount} loads · revenue{" "}
          {money(view.brief.currentWeek.negotiatedTotal)} · portfolio <strong>{signedPct(view.brief.currentWeek.variancePct)}</strong> vs market
          {view.brief.priorWeek ? <> · WoW {view.brief.revenueDelta >= 0 ? "+" : "−"}{money(Math.abs(view.brief.revenueDelta))}</> : null}
        </p>
      ) : null}

      {view && rollups.length > 0 ? (
        <div className="db-card-table">
          <table className="db-table">
            <thead>
              <tr>
                <th>{unit === "day" ? "Day" : "Week"}</th>
                <th className="right" style={{ width: 70 }}>Loads</th>
                <th className="right" style={{ width: 120 }}>Revenue</th>
                <th className="right" style={{ width: 120 }}>vs Market</th>
                <th style={{ width: 170 }}>Above / At / Below</th>
              </tr>
            </thead>
            <tbody>
              {rollups.map((p, i) => (
                <tr key={p.period} className={i === 0 ? "current" : ""}>
                  <td className="mono strong">{i === 0 ? `${p.period} (current)` : p.period}</td>
                  <td className="right mono num">{p.entryCount}</td>
                  <td className="right mono num">{money(p.negotiatedTotal)}</td>
                  <td className="right mono num">{signedPct(p.variancePct)}</td>
                  <td className="mono dim">{p.aboveCount} / {p.atCount} / {p.belowCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : !loading && !error ? (
        <p className="dim">No market-variance data yet. Log a negotiation in the Market Variance tool, or ingest loads to auto-populate.</p>
      ) : null}
    </div>
  );
}
