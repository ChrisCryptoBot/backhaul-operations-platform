import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { binVariances } from "@/lib/kpi-view";
import { miles } from "@/lib/desk-format";
import { ChartFrame, shortLane } from "./parts";

/** How each finished load's rate compares with the market rate captured for it, in eight steps. Loads with no market rate sit apart. */
export function VarianceHistogram({ k }: { k: DeskKpi }) {
  const { bins, unverified, total } = binVariances(k.variance);
  const verified = total - unverified;
  const tallest = Math.max(1, ...bins.map((b) => b.count), unverified);
  const under = bins.filter((b) => b.hi <= 0).reduce((s, b) => s + b.count, 0);
  return (
    <ChartFrame
      title="Rate against the market"
      unit="number of loads, by how far above or below the market rate they paid"
      empty={total === 0 ? "No finished loads in this period." : verified === 0 ? `None of the ${total} finished loads has a market rate on it, so there is nothing to compare. Add one when you price a load.` : undefined}
      caption={`${verified} of ${total} loads carry a market rate; ${under} of them paid under it.${unverified > 0 ? ` ${unverified} have none, shown apart.` : ""}`}
      formula="(all-in pay − market total) ÷ market total, over the planned miles the market rate was entered for. A TONU has no lane rate and is left out.">
      <div className="hg" role="img" aria-label="Loads by rate against the market">
        {bins.map((b) => (
          <div className="hg-col" key={b.label}>
            <span className="hg-n">{b.count > 0 ? b.count : ""}</span>
            <div className="hg-bar">
              <i className={b.tone} style={{ height: `${(b.count / tallest) * 100}%` }} />
            </div>
            <span className="hg-x">{b.label}</span>
          </div>
        ))}
        <div className="hg-col gap" />
        <div className="hg-col">
          <span className="hg-n">{unverified > 0 ? unverified : ""}</span>
          <div className="hg-bar">
            <i className="none" style={{ height: `${(unverified / tallest) * 100}%` }} />
          </div>
          <span className="hg-x">no market rate</span>
        </div>
      </div>
    </ChartFrame>
  );
}

/** Empty miles on each lane, split into the run to the pickup (left) and the run home after the delivery (right), on one scale. */
export function DeadheadBars({ k }: { k: DeskKpi }) {
  const lanes = k.lanes.slice(0, 7);
  const max = Math.max(1, ...lanes.flatMap((l) => [l.avgPickupEmpty, l.avgReturnEmpty]));
  const worst = [...lanes].sort((a, b) => b.avgPickupEmpty + b.avgReturnEmpty - (a.avgPickupEmpty + a.avgReturnEmpty))[0];
  return (
    <ChartFrame
      title="Where the empty miles are"
      unit="average empty miles per load, by lane"
      empty={lanes.length === 0 ? "No finished loads in this period." : undefined}
      caption={worst ? `${shortLane(worst.key)} carries the most empty miles per load: ${miles(worst.avgPickupEmpty)} to the pickup and ${miles(worst.avgReturnEmpty)} home.` : undefined}
      formula="Per lane: the average pickup deadhead (left) and the average return deadhead (right) over finished loads. Both sides share one scale. The seven busiest lanes.">
      <div className="dv">
        <div className="dv-head">
          <span>◀ empty to the pickup</span>
          <span>empty home after the delivery ▶</span>
        </div>
        {lanes.map((l) => (
          <div className="dv-row" key={l.key}>
            <div className="dv-l">
              <b>{miles(l.avgPickupEmpty)}</b>
              <i style={{ width: `${(l.avgPickupEmpty / max) * 100}%` }} />
            </div>
            <span className="dv-lane" title={l.key}>{shortLane(l.key)}</span>
            <div className="dv-r">
              <i style={{ width: `${(l.avgReturnEmpty / max) * 100}%` }} />
              <b>{miles(l.avgReturnEmpty)}</b>
            </div>
          </div>
        ))}
      </div>
    </ChartFrame>
  );
}
