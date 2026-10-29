import React from "react";
import type { DeskKpi, LaneStatus } from "@/server/tl/kpi";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { emptyZone } from "@/lib/thresholds";
import { signedPct, miles, pct, perMile, usd } from "@/lib/desk-format";
import { ChartFrame, shortLane } from "./parts";

const STATUS: Record<LaneStatus, { label: string; tone: "ok" | "bad" | "muted" }> = {
  above: { label: "Above market", tone: "ok" },
  below: { label: "Below market", tone: "bad" },
  unknown: { label: "No market rate", tone: "muted" }
};

const COLUMNS: Column[] = [
  { key: "lane", label: "Lane", sticky: true, width: 230 },
  { key: "loads", label: "Loads", align: "num" },
  { key: "gross", label: "Gross", align: "num" },
  { key: "rpm", label: "Per mile", align: "num" },
  { key: "empty", label: "Empty miles", align: "num" },
  { key: "before", label: "Before pickup", align: "num" },
  { key: "after", label: "After delivery", align: "num" },
  { key: "market", label: "Against market", align: "num" },
  { key: "status", label: "Status" }
];

/** Every lane that finished a load in the period, busiest first, with how its rate sits against the market. */
export function LaneScorecard({ k }: { k: DeskKpi }) {
  const rows: Row[] = k.lanes.map((l) => {
    const zone = emptyZone(l.emptyShare, k.thresholds);
    const s = STATUS[l.status];
    return {
      id: l.key,
      search: l.key,
      cells: {
        lane: (
          <>
            <b>{shortLane(l.key)}</b>
            <span className="sub">{l.key}</span>
          </>
        ),
        loads: l.loads,
        gross: usd(l.gross),
        rpm: perMile(l.rpm),
        empty: <span className={zone === "red" ? "tone-neg" : zone === "amber" ? "tone-warn" : ""}>{pct(l.emptyShare, 1)}</span>,
        before: miles(l.avgPickupEmpty),
        after: miles(l.avgReturnEmpty),
        market: l.marketVariancePct == null ? <span className="dim">—</span> : <span className={l.marketVariancePct < 0 ? "tone-neg" : "tone-pos"}>{signedPct(l.marketVariancePct)}</span>,
        status: <span className={`tl-chip ${s.tone}`}>{s.label}</span>
      }
    };
  });
  const below = k.lanes.filter((l) => l.status === "below").length;
  const checked = k.lanes.filter((l) => l.status !== "unknown").length;
  return (
    <ChartFrame
      title="Lane scorecard"
      unit="finished loads in the period, by lane"
      empty={k.lanes.length === 0 ? "No finished loads in this period." : undefined}
      caption={checked > 0 ? `${below} of ${checked} lanes with a market rate paid below it.` : "None of these lanes has a market rate on its loads yet."}
      formula="Against market is (Σ all-in pay − Σ market total) ÷ Σ market total over the loads on the lane that carry a market rate. Empty miles are deadhead over every mile driven on the lane.">
      <DataTable id="kpi-lanes" label="Lane scorecard" columns={COLUMNS} rows={rows} />
    </ChartFrame>
  );
}
