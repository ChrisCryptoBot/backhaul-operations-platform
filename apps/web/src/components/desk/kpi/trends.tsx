import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { growthOf, sparkPath } from "@/lib/kpi-view";
import { perMile, usd } from "@/lib/desk-format";
import { ChartFrame } from "./parts";

type Panel = { title: string; unit: string; values: Array<number | null>; fmt: (v: number) => string };

/** Four small charts on their own scales, each with its first and last week labelled and its end value in words. */
export function SmallMultiples({ k }: { k: DeskKpi }) {
  const t = k.trend;
  const panels: Panel[] = [
    { title: "Revenue", unit: "per week", values: t.map((w) => (w.loads > 0 ? w.gross : null)), fmt: (v) => usd(v) },
    { title: "Per revenue mile", unit: "per week", values: t.map((w) => w.rpm), fmt: (v) => perMile(v) },
    { title: "Empty miles", unit: "% of miles driven", values: t.map((w) => (w.emptyShare == null ? null : w.emptyShare * 100)), fmt: (v) => `${v.toFixed(1)}%` },
    { title: "Loads delivered", unit: "per week", values: t.map((w) => w.loads), fmt: (v) => String(v) }
  ];
  const any = t.some((w) => w.loads > 0);
  return (
    <ChartFrame
      title="Twelve weeks"
      unit="trailing seven-day weeks ending now · each chart has its own scale"
      empty={any ? undefined : "No finished loads in the last twelve weeks."}
      caption="Read the shape, not the height: each chart is stretched to its own range. A week with no finished loads leaves a gap rather than a zero."
      formula="Weeks are the seven days ending now, counted back twelve times; a load belongs to the week it finished in. Per mile and empty miles are ratios of that week's sums.">
      <div className="sm-grid">
        {panels.map((p) => {
          const s = sparkPath(p.values, 220, 56);
          const first = t[0]?.label;
          const lastVal = [...p.values].reverse().find((v) => v != null) ?? null;
          return (
            <figure className="sm" key={p.title}>
              <figcaption>
                {p.title} <span>{p.unit}</span>
              </figcaption>
              <div className="sm-plot">
                <svg viewBox="0 0 220 56" preserveAspectRatio="none" role="img" aria-label={`${p.title}, last twelve weeks${lastVal != null ? `, ending at ${p.fmt(lastVal)}` : ""}`}>
                  <line x1="0" x2="220" y1="55" y2="55" className="sm-base" />
                  {s.d ? <path d={s.d} className="sm-line" /> : null}
                </svg>
                {s.last ? <i className="sm-end" style={{ left: `${(s.last.x / 220) * 100}%`, top: `${(s.last.y / 56) * 100}%` }} /> : null}
              </div>
              <div className="sm-ends">
                <span>{first}</span>
                <b>{lastVal == null ? "—" : p.fmt(lastVal)}</b>
              </div>
            </figure>
          );
        })}
      </div>
    </ChartFrame>
  );
}

/** The last four weeks against the four before, for the four measures, as bars up or down from one zero line on one scale. */
export function GrowthColumns({ k }: { k: DeskKpi }) {
  const { rows, scale } = growthOf(k.trend, 4);
  const known = rows.some((r) => r.change != null);
  return (
    <ChartFrame
      title="Last four weeks against the four before"
      unit={`change, on one scale (± ${(scale * 100).toFixed(0)}%)`}
      empty={known ? undefined : "Not enough weeks of finished loads to compare yet."}
      caption="Green is better and red is worse, so a fall in empty miles is green. The glyph is the direction it moved."
      formula="Each bar is (last four weeks − the four before) ÷ the four before, with ratios taken over summed miles, not averaged.">
      <div className="gr">
        {rows.map((r) => {
          const c = r.change;
          const flat = c != null && Math.abs(c) < 0.0005; // under 0.05% reads as no change, not as a red -0.0%
          const good = c == null || flat ? null : r.lowerIsBetter ? c < 0 : c > 0;
          const h = c == null ? 0 : Math.min(1, Math.abs(c) / scale) * 50;
          return (
            <div className="gr-col" key={r.key}>
              <div className="gr-plot">
                <span className="gr-zero" />
                {c != null && !flat ? <i className={`${c > 0 ? "up" : "down"} ${good ? "good" : "bad"}`} style={{ height: `${h}%` }} /> : null}
              </div>
              <b className={good == null ? "" : good ? "good" : "bad"}>{c == null ? "—" : flat ? "no change" : `${c > 0 ? "▲ +" : "▼ −"}${(Math.abs(c) * 100).toFixed(1)}%`}</b>
              <span>{r.label}</span>
            </div>
          );
        })}
      </div>
    </ChartFrame>
  );
}

/** Revenue by calendar month (TrueLane's own monthly trend over everything in the filter). */
export function MonthlyBars({ k }: { k: DeskKpi }) {
  const m = k.analytics.monthly;
  const max = Math.max(1, k.analytics.maxMonthlyRevenue);
  const any = m.some((x) => x.revenue > 0);
  return (
    <ChartFrame title="Revenue by month" unit="gross, the last six months" empty={any ? undefined : "No finished loads yet."} caption="The month in progress is partial." formula="Gross by the month a load finished in (TrueLane's monthly trend).">
      <div className="mo">
        {m.map((x) => (
          <div className="mo-col" key={x.key}>
            <b>{x.revenue === 0 ? "" : `$${(x.revenue / 1000).toFixed(1)}k`}</b>
            <div className="mo-bar"><i className={x.isCurrent ? "now" : undefined} style={{ height: `${Math.max(x.revenue > 0 ? 2 : 0, (x.revenue / max) * 100)}%` }} /></div>
            <span>{x.label}{x.isCurrent ? "*" : ""}</span>
          </div>
        ))}
      </div>
    </ChartFrame>
  );
}
