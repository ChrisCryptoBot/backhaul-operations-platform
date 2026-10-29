import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { pct } from "@/lib/desk-format";
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
};

function Bullet({ label, text, value, max, mark, markLabel, note, over }: BulletProps) {
  const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
  return (
    <div className="bl">
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
    </div>
  );
}

/** Three measures against the one thing that gives each meaning: last period, or the free time you set for a dock. */
export function Bullets({ k }: { k: DeskKpi }) {
  const c = k.current;
  const p = k.prior;
  const grace = k.thresholds.detentionGraceMinutes;
  const waitMax = Math.max(grace * 1.6, (c.avgWaitMinutes ?? 0) * 1.2, 60);
  const none = c.judgedLoads === 0 && c.paidLoads === 0 && c.waitStops === 0;
  return (
    <ChartFrame
      title="Floor, payment and dock time"
      unit="share of loads and invoices · minutes"
      empty={none ? "No finished loads in this period have a floor, a payment or a recorded wait yet." : undefined}
      caption="Each bar is measured against one marker: the previous period for the two shares, your free time for the wait. Amber means the wait is over the free time."
      formula="Cleared the floor and paid within terms are shares of the loads that can be judged (a floor on file, a paid invoice). Wait is the mean recorded wait over stops that have one.">
      <Bullet
        label="Cleared the floor"
        text={pct(c.clearedFloor)}
        value={c.clearedFloor == null ? null : c.clearedFloor * 100}
        max={100}
        mark={p?.clearedFloor == null ? null : p.clearedFloor * 100}
        markLabel={`previous ${pct(p?.clearedFloor)}`}
        note={c.judgedLoads > 0 ? `${c.judgedLoads} loads judged` : "no loads with a floor"}
      />
      <Bullet
        label="Paid within terms"
        text={pct(c.paidWithinTerms)}
        value={c.paidWithinTerms == null ? null : c.paidWithinTerms * 100}
        max={100}
        mark={p?.paidWithinTerms == null ? null : p.paidWithinTerms * 100}
        markLabel={`previous ${pct(p?.paidWithinTerms)}`}
        note={c.paidLoads > 0 ? `${c.paidLoads} paid invoices` : "no paid invoices"}
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
      />
    </ChartFrame>
  );
}
