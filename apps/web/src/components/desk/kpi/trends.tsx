import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { combineWeeks, growthOf } from "@/lib/kpi-view";
import { WEEK_MS, windowLabel } from "@/lib/kpi-periods";
import { miles, pct, perMile, usd } from "@/lib/desk-format";
import { Tip, type TipData } from "../kit/tooltip";
import { ChartFrame } from "./parts";
import { TrendGrid } from "./trend-grid";
import type { ChartTable } from "./expand";

type Panel = { title: string; unit: string; values: Array<number | null>; fmt: (v: number) => string };

const weekRange = (end: number) => windowLabel({ start: end - WEEK_MS + 1, end });

/** Four small charts on their own scales, each with its first and last week labelled and its end value in words. Point at a week to read it. */
export function SmallMultiples({ k }: { k: DeskKpi }) {
  const t = k.trend;
  const panels: Panel[] = [
    { title: "Revenue", unit: "per week", values: t.map((w) => (w.loads > 0 ? w.gross : null)), fmt: (v) => usd(v) },
    { title: "Per revenue mile", unit: "per week", values: t.map((w) => w.rpm), fmt: (v) => perMile(v) },
    { title: "Empty miles", unit: "% of miles driven", values: t.map((w) => (w.emptyShare == null ? null : w.emptyShare * 100)), fmt: (v) => `${v.toFixed(1)}%` },
    { title: "Loads delivered", unit: "per week", values: t.map((w) => w.loads), fmt: (v) => String(v) }
  ];
  const any = t.some((w) => w.loads > 0);
  // The tooltip for each week: its own figures, each beside the week before. A week with no finished loads says so rather than showing zeros.
  const weeks = t.map((w, i) => {
    const prev = i > 0 ? t[i - 1]! : null;
    const vs = (cur: number | null, before: number | null | undefined, f: (v: number) => string) => (cur == null ? "—" : before == null ? f(cur) : `${f(cur)}  (was ${f(before)})`);
    const rows: TipData["rows"] =
      w.loads === 0
        ? [["Loads delivered", "0"]]
        : [
            ["Revenue", vs(w.gross, prev && prev.loads > 0 ? prev.gross : null, usd)],
            ["Per revenue mile", vs(w.rpm, prev?.rpm, perMile)],
            ["Loads delivered", vs(w.loads, prev?.loads, (v) => String(v))],
            ["Revenue miles", miles(w.revenueMiles)],
            ["Driven miles", miles(w.drivenMiles)],
            ["Empty miles", `${miles(w.emptyMiles)}  (${pct(w.emptyShare, 1)})`]
          ];
    return { label: w.label, tip: { title: `Week ending ${w.label}`, sub: weekRange(w.end), rows, note: w.loads === 0 ? "No finished loads this week." : undefined } };
  });
  const table: ChartTable = {
    head: ["Week ending", "Revenue", "Per revenue mile", "Empty miles %", "Loads", "Revenue miles", "Driven miles", "Empty miles"],
    rows: t.map((w) => [w.label, w.loads > 0 ? usd(w.gross) : "—", perMile(w.rpm), pct(w.emptyShare, 1), String(w.loads), miles(w.revenueMiles), miles(w.drivenMiles), miles(w.emptyMiles)])
  };
  return (
    <ChartFrame
      title="Twelve weeks"
      unit="trailing seven-day weeks ending now · each chart has its own scale"
      empty={any ? undefined : "No finished loads in the last twelve weeks."}
      caption="Read the shape, not the height: each chart is stretched to its own range. A week with no finished loads leaves a gap rather than a zero."
      formula="Weeks are the seven days ending now, counted back twelve times; a load belongs to the week it finished in. Per mile and empty miles are ratios of that week's sums."
      table={table}>
      <TrendGrid panels={panels.map((p) => ({ title: p.title, unit: p.unit, values: p.values, texts: p.values.map((v) => (v == null ? null : p.fmt(v))) }))} weeks={weeks} />
    </ChartFrame>
  );
}

const signed = (c: number | null, flat = false) => (c == null ? "—" : flat ? "no change" : `${c > 0 ? "+" : "−"}${(Math.abs(c) * 100).toFixed(1)}%`);

/** The last four weeks against the four before, for the four measures, as bars up or down from one zero line on one scale. */
export function GrowthColumns({ k }: { k: DeskKpi }) {
  const { rows, scale } = growthOf(k.trend, 4);
  const known = rows.some((r) => r.change != null);
  // The figures behind each bar, summed the same way the bar is (sums first, then the ratio), so the tooltip and the bar can never disagree.
  const cur = combineWeeks(k.trend.slice(-4));
  const prev = combineWeeks(k.trend.slice(-8, -4));
  const lastEnd = k.trend[k.trend.length - 1]?.end ?? 0;
  const raw: Record<string, [string, string]> = {
    revenue: [usd(cur.gross), usd(prev.gross)],
    rpm: [perMile(cur.rpm), perMile(prev.rpm)],
    loads: [String(cur.loads), String(prev.loads)],
    empty: [pct(cur.emptyShare, 1), pct(prev.emptyShare, 1)]
  };
  const table: ChartTable = { head: ["Measure", "Last four weeks", "The four before", "Change"], rows: rows.map((r) => [r.label, raw[r.key]![0], raw[r.key]![1], signed(r.change)]) };
  return (
    <ChartFrame
      title="Last four weeks against the four before"
      unit={`change, on one scale (± ${(scale * 100).toFixed(0)}%)`}
      empty={known ? undefined : "Not enough weeks of finished loads to compare yet."}
      caption="Green is better and red is worse, so a fall in empty miles is green. The glyph is the direction it moved."
      formula="Each bar is (last four weeks − the four before) ÷ the four before, with ratios taken over summed miles, not averaged."
      table={table}>
      <div className="gr">
        {rows.map((r) => {
          const c = r.change;
          const flat = c != null && Math.abs(c) < 0.0005; // under 0.05% reads as no change, not as a red -0.0%
          const good = c == null || flat ? null : r.lowerIsBetter ? c < 0 : c > 0;
          const h = c == null ? 0 : Math.min(1, Math.abs(c) / scale) * 50;
          return (
            <Tip
              as="div"
              focusable
              className="gr-col"
              key={r.key}
              tip={{
                title: r.label,
                sub: `${windowLabel({ start: lastEnd - 4 * WEEK_MS + 1, end: lastEnd })}, against the four weeks before`,
                rows: [
                  ["Last four weeks", raw[r.key]![0]],
                  ["The four before", raw[r.key]![1]],
                  ["Change", signed(c, flat)]
                ]
              }}>
              <div className="gr-plot">
                <span className="gr-zero" />
                {c != null && !flat ? <i className={`${c > 0 ? "up" : "down"} ${good ? "good" : "bad"}`} style={{ height: `${h}%` }} /> : null}
              </div>
              <b className={good == null ? "" : good ? "good" : "bad"}>{c == null ? "—" : flat ? "no change" : `${c > 0 ? "▲ +" : "▼ −"}${(Math.abs(c) * 100).toFixed(1)}%`}</b>
              <span>{r.label}</span>
            </Tip>
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
    <ChartFrame
      title="Revenue by month"
      unit="gross, the last six months"
      empty={any ? undefined : "No finished loads yet."}
      caption="The month in progress is partial."
      formula="Gross by the month a load finished in (TrueLane's monthly trend)."
      table={{ head: ["Month", "Revenue", "Loads finished", "Per load"], rows: m.map((x) => [`${x.label}${x.isCurrent ? " (so far)" : ""}`, usd(x.revenue), String(x.count), x.count > 0 ? usd(x.revenue / x.count) : "—"]) }}>
      <div className="mo">
        {m.map((x, i) => {
          const before = i > 0 ? m[i - 1]! : null;
          const rows: Array<[string, string]> = [
            ["Revenue", usd(x.revenue)],
            ["Loads finished", String(x.count)]
          ];
          if (x.count > 0) rows.push(["Per load", usd(x.revenue / x.count)]);
          if (before) rows.push(["Month before", usd(before.revenue)]);
          return (
            <Tip as="div" focusable className="mo-col" key={x.key} tip={{ title: `${x.label}${x.isCurrent ? " (so far)" : ""}`, rows, note: x.isCurrent ? "The month is not over, so this is partial." : undefined }}>
              <b>{x.revenue === 0 ? "" : `$${(x.revenue / 1000).toFixed(1)}k`}</b>
              <div className="mo-bar"><i className={x.isCurrent ? "now" : undefined} style={{ height: `${Math.max(x.revenue > 0 ? 2 : 0, (x.revenue / max) * 100)}%` }} /></div>
              <span>{x.label}{x.isCurrent ? "*" : ""}</span>
            </Tip>
          );
        })}
      </div>
    </ChartFrame>
  );
}
