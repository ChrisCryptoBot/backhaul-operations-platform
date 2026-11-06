import Link from "next/link";
import React from "react";
import type { DriverKpi } from "@/server/tl/kpi";
import { emptyZone, type Thresholds } from "@/lib/thresholds";
import { miles, pct, perMile, usd } from "@/lib/desk-format";
import { Tip } from "../kit/tooltip";
import { ChartFrame } from "./parts";

/**
 * Drivers ranked by empty miles, best first. In percent the bars are coloured by the amber and red lines from Settings and those
 * lines are drawn as ticks; in miles the bars are neutral. The fleet's own figure is always a tick, so each driver reads against it.
 */
/** A fleet has thousands of drivers: past this many the chart shows the best ten and the worst ten, and "All drivers" opens the rest. */
export const LEADERS = 10;

export function DriverLeaderboard({ drivers, thresholds, mode, hrefFor, all = false, allHref }: { drivers: DriverKpi[]; thresholds: Thresholds; mode: "pct" | "miles"; hrefFor: (m: "pct" | "miles") => string; all?: boolean; allHref?: string }) {
  const usable = mode === "pct" ? drivers.filter((d) => d.emptyShare != null) : drivers;
  const rows = usable.map((d) => ({ d, v: mode === "pct" ? d.emptyShare! * 100 : d.emptyMiles })).sort((a, b) => a.v - b.v);
  const trimmed = !all && rows.length > LEADERS * 2;
  const shown = trimmed ? [...rows.slice(0, LEADERS), ...rows.slice(rows.length - LEADERS)] : rows;
  const hidden = rows.length - shown.length;
  const driven = drivers.reduce((s, d) => s + d.drivenMiles, 0);
  const empty = drivers.reduce((s, d) => s + d.emptyMiles, 0);
  const avg = mode === "pct" ? (driven > 0 ? (empty / driven) * 100 : 0) : drivers.length > 0 ? empty / drivers.length : 0;
  const top = Math.max(0, ...rows.map((r) => r.v), avg, mode === "pct" ? thresholds.emptyRedPct * 1.2 : 0) * 1.06 || 1;
  const at = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  const fmt = (v: number) => (mode === "pct" ? `${v.toFixed(1)}%` : miles(v));

  return (
    <ChartFrame
      title="Drivers by empty miles"
      unit={mode === "pct" ? "% of every mile driven · best first" : "empty miles in the period · best first"}
      empty={rows.length === 0 ? "No finished loads with a driver in this period." : undefined}
      caption={
        rows.length > 0
          ? mode === "pct"
            ? `${rows.filter((r) => emptyZone(r.v / 100, thresholds) !== "ok").length} of ${rows.length} drivers are past the amber line (${thresholds.emptyAmberPct}%). The fleet is at ${avg.toFixed(1)}%.`
            : `The average driver ran ${miles(avg)} empty in this period.`
          : undefined
      }
      formula={mode === "pct" ? "A driver's empty miles ÷ every mile that driver drove, over finished loads with that driver assigned. Lines are set in Settings." : "Pickup deadhead + return deadhead, summed over the driver's finished loads."}
      table={{
        head: ["Driver", "Loads", "Gross", "Per mile", "Miles driven", "Empty miles", "Empty %", "Est. driver pay"],
        rows: (trimmed ? shown.map((r) => r.d) : drivers).map((d) => [d.name, String(d.loads), usd(d.gross), perMile(d.rpm), miles(d.drivenMiles), miles(d.emptyMiles), pct(d.emptyShare, 1), usd(d.payOwed)])
      }}>
      <div className="lb-head">
        <div className="t-seg" role="group" aria-label="Show empty miles as">
          <Link href={hrefFor("pct")} aria-current={mode === "pct" ? "true" : undefined} replace scroll={false}>Empty %</Link>
          <Link href={hrefFor("miles")} aria-current={mode === "miles" ? "true" : undefined} replace scroll={false}>Empty miles</Link>
        </div>
        <span className="lb-key">
          {mode === "pct" ? (
            <>
              <i className="amber" /> amber line <i className="red" /> red line{" "}
            </>
          ) : null}
          <i className="avg" /> {mode === "pct" ? "fleet" : "average driver"}
        </span>
      </div>
      <ol className="lb">
        {shown.map(({ d, v }, i) => {
          const zone = mode === "pct" ? emptyZone(v / 100, thresholds) : null;
          return (
            <React.Fragment key={d.name}>
              {trimmed && i === LEADERS ? (
                <li className="lb-gap">
                  {hidden} {hidden === 1 ? "driver" : "drivers"} between{allHref ? <> · <Link href={allHref} replace scroll={false}>All {rows.length} drivers</Link></> : null}
                </li>
              ) : null}
            <Tip
              as="li"
              focusable
              className="lb-row"
              tip={{
                title: d.name,
                rows: [
                  ["Loads finished", String(d.loads)],
                  ["Gross", usd(d.gross)],
                  ["Per revenue mile", perMile(d.rpm)],
                  ["Miles driven", miles(d.drivenMiles)],
                  ["Empty miles", `${miles(d.emptyMiles)}  (${pct(d.emptyShare, 1)})`],
                  ["Est. driver pay", usd(d.payOwed)]
                ]
              }}>
              <span className="lb-name">{d.name}</span>
              <div className="lb-track">
                <i className={`lb-fill ${zone ?? "plain"}`} style={{ width: at(v) }} />
                {mode === "pct" ? (
                  <>
                    <b className="lb-tick amber" style={{ left: at(thresholds.emptyAmberPct) }} />
                    <b className="lb-tick red" style={{ left: at(thresholds.emptyRedPct) }} />
                  </>
                ) : null}
                <b className="lb-tick avg" style={{ left: at(avg) }} />
              </div>
              <span className="lb-val">{fmt(v)}</span>
              <span className="lb-meta">
                {d.loads} {d.loads === 1 ? "load" : "loads"} · {perMile(d.rpm)}
              </span>
            </Tip>
            </React.Fragment>
          );
        })}
      </ol>
    </ChartFrame>
  );
}
