import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { deltaOf } from "@/lib/kpi-view";
import { pct } from "@/lib/desk-format";
import { Tip } from "../kit/tooltip";
import { ChartFrame, DeltaChip } from "./parts";

/** Cancelled loads and TONUs by the reason the dispatcher picked, most common first, with the share of loads that fell through. */
export function ReasonsCard({ k }: { k: DeskKpi }) {
  const r = k.reliability;
  const top = Math.max(1, ...r.reasons.map((x) => x.count));
  const planned = r.delivered + r.lost;
  return (
    <ChartFrame
      title="Why loads fell through"
      unit="cancelled loads and TONUs, by the reason given"
      empty={r.lost === 0 ? "No load was cancelled or turned into a TONU in this period." : undefined}
      caption={
        <>
          {r.lost} of {planned} loads that were meant to run fell through ({pct(r.rate, 1)}): {r.cancelled} cancelled, {r.tonu} TONU.{" "}
          <DeltaChip delta={deltaOf(r.rate, r.priorRate, { kind: "pts", lowerIsBetter: true })} title="Against the period before" />
        </>
      }
      formula="(cancelled loads + TONUs) ÷ (delivered freight loads + cancelled loads + TONUs), in the period. The reason is the one picked when the load was cancelled or recorded as a TONU."
      table={{ head: ["Reason", "Loads", "Share of those that fell through"], rows: r.reasons.map((x) => [x.label, String(x.count), r.lost > 0 ? pct(x.count / r.lost, 0) : "—"]) }}>
      <ol className="rs">
        {r.reasons.map((x) => (
          <Tip as="li" focusable className="rs-row" key={x.key} tip={{ title: x.label, rows: [["Loads", String(x.count)], ["Of those that fell through", r.lost > 0 ? pct(x.count / r.lost, 0) : "—"], ["Of loads meant to run", planned > 0 ? pct(x.count / planned, 1) : "—"]] }}>
            <span className="rs-name">{x.label}</span>
            <div className="rs-track">
              <i style={{ width: `${(x.count / top) * 100}%` }} />
            </div>
            <b>{x.count}</b>
          </Tip>
        ))}
      </ol>
    </ChartFrame>
  );
}
