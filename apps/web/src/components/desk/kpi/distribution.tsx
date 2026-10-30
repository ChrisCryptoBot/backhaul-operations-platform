import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { binVariances } from "@/lib/kpi-view";
import { miles, pct, perMile, usd } from "@/lib/desk-format";
import { Tip } from "../kit/tooltip";
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
      formula="(all-in pay − market total) ÷ market total, over the planned miles the market rate was entered for. A TONU has no lane rate and is left out."
      table={{
        head: ["Band", "Loads", "Share of loads with a market rate"],
        rows: [...bins.map((b) => [b.label, String(b.count), verified > 0 ? pct(b.count / verified, 0) : "—"]), ["No market rate", String(unverified), "—"]]
      }}>
      <div className="hg" role="img" aria-label="Loads by rate against the market">
        {bins.map((b) => (
          <Tip as="div" focusable className="hg-col" key={b.label} tip={{ title: b.label, sub: "rate against the market", rows: [["Loads", String(b.count)], ["Share of loads with a market rate", verified > 0 ? pct(b.count / verified, 0) : "—"]] }}>
            <span className="hg-n">{b.count > 0 ? b.count : ""}</span>
            <div className="hg-bar">
              <i className={b.tone} style={{ height: `${(b.count / tallest) * 100}%` }} />
            </div>
            <span className="hg-x">{b.label}</span>
          </Tip>
        ))}
        <div className="hg-col gap" />
        <Tip as="div" focusable className="hg-col" tip={{ title: "No market rate", rows: [["Loads", String(unverified)], ["Of all finished loads", total > 0 ? pct(unverified / total, 0) : "—"]], note: "Add a market rate when you price a load to compare it." }}>
          <span className="hg-n">{unverified > 0 ? unverified : ""}</span>
          <div className="hg-bar">
            <i className="none" style={{ height: `${(unverified / tallest) * 100}%` }} />
          </div>
          <span className="hg-x">no market rate</span>
        </Tip>
      </div>
    </ChartFrame>
  );
}

type LaneRow = DeskKpi["lanes"][number];

function DeadheadRows({ lanes, max }: { lanes: LaneRow[]; max: number }) {
  return (
    <div className="dv">
      <div className="dv-head">
        <span>◀ empty to the pickup</span>
        <span>empty home after the delivery ▶</span>
      </div>
      {lanes.map((l) => (
        <Tip
          as="div"
          focusable
          className="dv-row"
          key={l.key}
          tip={{
            title: l.key,
            rows: [
              ["Loads finished", String(l.loads)],
              ["Empty to the pickup", `${miles(l.avgPickupEmpty)} on average`],
              ["Empty home after", `${miles(l.avgReturnEmpty)} on average`],
              ["Empty share", pct(l.emptyShare, 1)],
              ["Gross", usd(l.gross)],
              ["Per revenue mile", perMile(l.rpm)],
              ["Against the market", l.marketVariancePct == null ? "no market rate" : `${l.marketVariancePct > 0 ? "+" : "−"}${Math.abs(l.marketVariancePct).toFixed(1)}%`]
            ]
          }}>
          <div className="dv-l">
            <b>{miles(l.avgPickupEmpty)}</b>
            <i style={{ width: `${(l.avgPickupEmpty / max) * 100}%` }} />
          </div>
          <span className="dv-lane">{shortLane(l.key)}</span>
          <div className="dv-r">
            <i style={{ width: `${(l.avgReturnEmpty / max) * 100}%` }} />
            <b>{miles(l.avgReturnEmpty)}</b>
          </div>
        </Tip>
      ))}
    </div>
  );
}

/** Empty miles on each lane, split into the run to the pickup (left) and the run home after the delivery (right), on one scale. The card shows the busiest seven; Expand shows every lane. */
export function DeadheadBars({ k }: { k: DeskKpi }) {
  const all = k.lanes;
  const lanes = all.slice(0, 7);
  const max = Math.max(1, ...lanes.flatMap((l) => [l.avgPickupEmpty, l.avgReturnEmpty]));
  const maxAll = Math.max(1, ...all.flatMap((l) => [l.avgPickupEmpty, l.avgReturnEmpty]));
  const worst = [...lanes].sort((a, b) => b.avgPickupEmpty + b.avgReturnEmpty - (a.avgPickupEmpty + a.avgReturnEmpty))[0];
  return (
    <ChartFrame
      title="Where the empty miles are"
      unit="average empty miles per load, by lane"
      empty={lanes.length === 0 ? "No finished loads in this period." : undefined}
      caption={worst ? `${shortLane(worst.key)} carries the most empty miles per load: ${miles(worst.avgPickupEmpty)} to the pickup and ${miles(worst.avgReturnEmpty)} home.` : undefined}
      formula="Per lane: the average pickup deadhead (left) and the average return deadhead (right) over finished loads. Both sides share one scale. The card shows the seven busiest lanes; Expand lists them all."
      table={{
        head: ["Lane", "Loads", "Avg empty to pickup", "Avg empty home", "Empty share", "Gross", "Per revenue mile"],
        rows: all.map((l) => [l.key, String(l.loads), miles(l.avgPickupEmpty), miles(l.avgReturnEmpty), pct(l.emptyShare, 1), usd(l.gross), perMile(l.rpm)])
      }}
      large={<DeadheadRows lanes={all} max={maxAll} />}>
      <DeadheadRows lanes={lanes} max={max} />
    </ChartFrame>
  );
}
