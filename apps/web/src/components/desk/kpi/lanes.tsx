import Link from "next/link";
import React from "react";
import type { DeskKpi, LaneKpi, LaneStatus } from "@/server/tl/kpi";
import type { LaneScore } from "@/lib/kpi-extras";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { emptyZone } from "@/lib/thresholds";
import { signedPct, miles, pct, perMile, usd } from "@/lib/desk-format";
import { ChartFrame, shortLane } from "./parts";
import { LaneTargetCell } from "./inputs";

const STATUS: Record<LaneStatus, { label: string; tone: "ok" | "bad" | "muted" }> = {
  above: { label: "Above market", tone: "ok" },
  below: { label: "Below market", tone: "bad" },
  unknown: { label: "No market rate", tone: "muted" }
};

const SCORE: Record<LaneScore, { label: string; tone: "ok" | "bad" | "muted" }> = {
  below: { label: "BELOW", tone: "bad" },
  ok: { label: "OK", tone: "ok" },
  no_target: { label: "NO TARGET", tone: "muted" }
};

const COLUMNS: Column[] = [
  { key: "lane", sortable: true, label: "Lane", sticky: true, width: 230 },
  { key: "loads", sortable: true, label: "Loads", align: "num" },
  { key: "gross", sortable: true, label: "Gross", align: "num" },
  { key: "perload", sortable: true, label: "Per load", align: "num" },
  { key: "rpm", sortable: true, label: "Per mile", align: "num" },
  { key: "loaded", sortable: true, label: "Loaded miles", align: "num" },
  { key: "emptytotal", sortable: true, label: "Empty miles (total)", align: "num" },
  { key: "trip", sortable: true, label: "Trip miles", align: "num" },
  { key: "empty", sortable: true, label: "Empty miles", align: "num" },
  { key: "before", sortable: true, label: "Before pickup", align: "num" },
  { key: "after", sortable: true, label: "After delivery", align: "num" },
  { key: "market", sortable: true, label: "Against market", align: "num" },
  { key: "target", label: "Target per load", align: "num" },
  { key: "vs", sortable: true, label: "Vs target", align: "num" },
  { key: "score", label: "Scorecard" },
  { key: "status", label: "Status" }
];

/** Every lane that finished a load in the period, busiest first, with how its rate sits against the market. */
/** What the lane table can sort by, and how each column is read (the page sorts and pages the lanes on the server). */
export const LANE_SORTERS: Record<string, (l: LaneKpi) => number | string | null> = {
  lane: (l) => l.key,
  loads: (l) => l.loads,
  gross: (l) => l.gross,
  perload: (l) => l.revPerLoad,
  rpm: (l) => l.rpm,
  loaded: (l) => l.loadedMiles,
  emptytotal: (l) => l.pickupEmptyMiles + l.returnEmptyMiles,
  trip: (l) => l.drivenMiles,
  empty: (l) => l.emptyShare,
  before: (l) => l.avgPickupEmpty,
  after: (l) => l.avgReturnEmpty,
  market: (l) => l.marketVariancePct,
  vs: (l) => l.vsTarget
};

/** `lanes` is the page being shown (the whole list is read for the caption); `sortHref` makes the headers sort on the server. */
export function LaneScorecard({ k, canEdit = false, lanes, sortHref }: { k: DeskKpi; canEdit?: boolean; lanes?: LaneKpi[]; sortHref?: SortHref }) {
  const rows: Row[] = (lanes ?? k.lanes).map((l) => {
    const zone = emptyZone(l.emptyShare, k.thresholds);
    const s = STATUS[l.status];
    return {
      id: l.key,
      search: l.key,
      cells: {
        lane: (
          <>
            <Link href={`/lanes/detail?lane=${encodeURIComponent(l.key)}`}>
              <b>{shortLane(l.key)}</b>
            </Link>
            <span className="sub">{l.key}</span>
          </>
        ),
        loads: l.loads,
        gross: usd(l.gross),
        perload: usd(l.revPerLoad),
        rpm: perMile(l.rpm),
        loaded: miles(l.loadedMiles),
        emptytotal: miles(l.pickupEmptyMiles + l.returnEmptyMiles),
        trip: miles(l.drivenMiles),
        empty: <span className={zone === "red" ? "tone-neg" : zone === "amber" ? "tone-warn" : ""}>{pct(l.emptyShare, 1)}</span>,
        before: miles(l.avgPickupEmpty),
        after: miles(l.avgReturnEmpty),
        market: l.marketVariancePct == null ? <span className="dim">—</span> : <span className={l.marketVariancePct < 0 ? "tone-neg" : "tone-pos"}>{signedPct(l.marketVariancePct)}</span>,
        target: <LaneTargetCell lane={l.key} target={l.targetRate} canEdit={canEdit} />,
        vs: l.vsTarget == null ? <span className="dim">{"—"}</span> : <span className={l.vsTarget < 0 ? "tone-neg" : "tone-pos"}>{usd(l.vsTarget, 0)}</span>,
        score: <span className={`tl-chip ${SCORE[l.score].tone}`}>{SCORE[l.score].label}</span>,
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
      caption={`${k.lanes.filter((l) => l.score === "below").length} of ${k.lanes.filter((l) => l.score !== "no_target").length} lanes with a target are BELOW it. `.concat(checked > 0 ? `${below} of ${checked} lanes with a market rate paid below it.` : "None of these lanes has a market rate on its loads yet.")}
      formula="Target per load is typed by a person (dispatch or billing); Vs target is the lane's revenue per load minus it, and the scorecard is BELOW when the lane pays less than its target per load, OK at or above it, NO TARGET when none is set. Loaded, empty and trip miles are the lane's totals in the period. Against market is (Σ all-in pay − Σ market total) ÷ Σ market total over the loads on the lane that carry a market rate. Empty miles are deadhead over every mile driven on the lane.">
      <DataTable id="kpi-lanes" label="Lane scorecard" columns={COLUMNS} rows={rows} sortHref={sortHref} />
    </ChartFrame>
  );
}
