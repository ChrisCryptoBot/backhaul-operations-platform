import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { pct } from "@/lib/desk-format";
import { Tip, type TipData } from "../kit/tooltip";
import { ChartFrame } from "./parts";

type BulletProps = {
  label: string;
  text: string;
  /** The bar, on a 0 to `max` scale; null draws no bar (nothing to measure). */
  value: number | null;
  max: number;
  /** The marker: the previous period, or a limit set in Settings. */
  mark: number | null;
  markLabel: string;
  note: string;
  over?: boolean;
  tip: TipData;
};

function Bullet({ label, text, value, max, mark, markLabel, note, over, tip }: BulletProps) {
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <Tip as="div" focusable className="bl" tip={tip}>
      <div className="bl-head">
        <span>{label}</span>
        <b>{text}</b>
      </div>
      <div className="bl-track" role="img" aria-label={`${label}: ${text}${mark != null ? `, ${markLabel}` : ""}`}>
        {value != null ? <i className={over ? "over" : undefined} style={{ width: at(value) }} /> : null}
        {mark != null ? <b style={{ left: at(mark) }} title={markLabel} /> : null}
      </div>
      <div className="bl-foot">
        <span>{note}</span>
        <span>{mark != null ? `| ${markLabel}` : ""}</span>
      </div>
    </Tip>
  );
}

/** Three measures against the one thing that gives each meaning: last period, or the free time you set for a dock. */
export function Bullets({ k }: { k: DeskKpi }) {
  const c = k.current;
  const p = k.prior;
  const grace = k.thresholds.detentionGraceMinutes;
  const waitMax = Math.max(grace * 1.6, (c.avgWaitMinutes ?? 0) * 1.2, 60);
  const of = (share: number | null | undefined, n: number) => (share == null || n === 0 ? "—" : `${Math.round(share * n)} of ${n}`);
  const none = c.judgedLoads === 0 && c.paidLoads === 0 && c.waitStops === 0 && c.arrivalStops === 0;
  return (
    <ChartFrame
      title="On time, floor, payment and dock time"
      unit="share of stops, loads and invoices · minutes"
      empty={none ? "No finished loads in this period have a floor, a payment or a recorded wait yet." : undefined}
      caption="Each bar is measured against one marker: the previous period for the two shares, your free time for the wait. Amber means the wait is over the free time."
      formula="Arrived on time: stops reached by the time their window closed, over stops with both an arrival and a window. Cleared the floor and paid within terms are shares of the loads that can be judged (a floor on file, a paid invoice). Wait is the mean recorded wait over stops that have one.">
      <Bullet
        label="Arrived on time"
        text={pct(c.onTimeArrivals)}
        value={c.onTimeArrivals == null ? null : c.onTimeArrivals * 100}
        max={100}
        mark={p?.onTimeArrivals == null ? null : p.onTimeArrivals * 100}
        markLabel={`previous ${pct(p?.onTimeArrivals)}`}
        note={c.arrivalStops > 0 ? `${c.arrivalStops} stops with an arrival` : "no arrivals recorded"}
        tip={{ title: "Arrived on time", rows: [["On time", of(c.onTimeArrivals, c.arrivalStops)], ["Share", pct(c.onTimeArrivals)], ["Previous period", pct(p?.onTimeArrivals)]], note: "Stops reached by the time their window closed." }}
      />
      <Bullet
        label="Cleared the floor"
        text={pct(c.clearedFloor)}
        value={c.clearedFloor == null ? null : c.clearedFloor * 100}
        max={100}
        mark={p?.clearedFloor == null ? null : p.clearedFloor * 100}
        markLabel={`previous ${pct(p?.clearedFloor)}`}
        note={c.judgedLoads > 0 ? `${c.judgedLoads} loads judged` : "no loads with a floor"}
        tip={{ title: "Cleared the floor", rows: [["Cleared", of(c.clearedFloor, c.judgedLoads)], ["Share", pct(c.clearedFloor)], ["Previous period", pct(p?.clearedFloor)]] }}
      />
      <Bullet
        label="Paid within terms"
        text={pct(c.paidWithinTerms)}
        value={c.paidWithinTerms == null ? null : c.paidWithinTerms * 100}
        max={100}
        mark={p?.paidWithinTerms == null ? null : p.paidWithinTerms * 100}
        markLabel={`previous ${pct(p?.paidWithinTerms)}`}
        note={c.paidLoads > 0 ? `${c.paidLoads} paid invoices` : "no paid invoices"}
        tip={{ title: "Paid within terms", rows: [["Paid in time", of(c.paidWithinTerms, c.paidLoads)], ["Share", pct(c.paidWithinTerms)], ["Previous period", pct(p?.paidWithinTerms)]] }}
      />
      <Bullet
        label="Average wait at a stop"
        text={c.avgWaitMinutes == null ? "—" : `${c.avgWaitMinutes.toFixed(0)} min`}
        value={c.avgWaitMinutes}
        max={waitMax}
        mark={grace}
        markLabel={`${grace} min free`}
        note={c.waitStops > 0 ? `${c.waitStops} stops with a wait` : "no waits recorded"}
        over={c.avgWaitMinutes != null && c.avgWaitMinutes > grace}
        tip={{ title: "Average wait at a stop", rows: [["Average", c.avgWaitMinutes == null ? "—" : `${c.avgWaitMinutes.toFixed(0)} min`], ["Stops with a wait", String(c.waitStops)], ["Free time", `${grace} min`], ["Previous period", p?.avgWaitMinutes == null ? "—" : `${p.avgWaitMinutes.toFixed(0)} min`]] }}
      />
    </ChartFrame>
  );
}
