import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { deltaOf, type Delta } from "@/lib/kpi-view";
import { emptyZone } from "@/lib/thresholds";
import { windowLabel } from "@/lib/kpi-periods";
import { miles, pct, perMile, usd } from "@/lib/desk-format";
import { DeltaChip } from "./parts";

type Cell = { label: string; value: string; sub: string; delta: Delta | null; tone?: "ok" | "warn" | "bad" };

/** The headline numbers as a hairline grid, each with its change against the previous period. */
export function KpiMatrix({ k }: { k: DeskKpi }) {
  const c = k.current;
  const p = k.prior;
  const zone = emptyZone(c.emptyShare, k.thresholds);
  const grace = k.thresholds.detentionGraceMinutes;
  const cells: Cell[] = [
    { label: "Gross revenue", value: usd(c.gross), sub: `${c.loads} finished ${c.loads === 1 ? "load" : "loads"} · ${usd(c.netEstimate)} after tracked costs`, delta: deltaOf(c.gross, p?.gross, { kind: "pct" }) },
    { label: "Per revenue mile", value: perMile(c.rpm), sub: `on ${miles(c.totalMiles)} driven`, delta: deltaOf(c.rpm, p?.rpm, { kind: "pct" }) },
    { label: "Loads finished", value: String(c.loads), sub: `${p ? `${p.loads} in the previous period` : "in this period"}${c.tonuLoads > 0 ? ` · ${c.tonuLoads} TONU` : ""}`, delta: deltaOf(c.loads, p?.loads, { kind: "pct" }) },
    {
      label: "Empty miles",
      value: pct(c.emptyShare, 1),
      sub: `${miles(c.emptyMiles)} of ${miles(c.totalMiles)} driven`,
      delta: deltaOf(c.emptyShare, p?.emptyShare, { kind: "pts", lowerIsBetter: true }),
      tone: zone === "red" ? "bad" : zone === "amber" ? "warn" : zone === "ok" ? "ok" : undefined
    },
    { label: "Cleared the floor", value: pct(c.clearedFloor), sub: c.judgedLoads > 0 ? `of ${c.judgedLoads} loads with a floor on file` : "no loads with a floor on file", delta: deltaOf(c.clearedFloor, p?.clearedFloor, { kind: "pts" }) },
    { label: "Paid within terms", value: pct(c.paidWithinTerms), sub: c.paidLoads > 0 ? `of ${c.paidLoads} paid ${c.paidLoads === 1 ? "invoice" : "invoices"}` : "no paid invoices yet", delta: deltaOf(c.paidWithinTerms, p?.paidWithinTerms, { kind: "pts" }) },
    { label: "Days to pay", value: c.avgDaysToPay == null ? "—" : `${c.avgDaysToPay.toFixed(1)} days`, sub: "invoice to payment, on paid invoices", delta: deltaOf(c.avgDaysToPay, p?.avgDaysToPay, { kind: "pct", lowerIsBetter: true }) },
    {
      label: "Wait at a stop",
      value: c.avgWaitMinutes == null ? "—" : `${c.avgWaitMinutes.toFixed(0)} min`,
      sub: c.waitStops > 0 ? `${c.waitStops} stops · ${grace} min free` : "no waits recorded",
      delta: deltaOf(c.avgWaitMinutes, p?.avgWaitMinutes, { kind: "pct", lowerIsBetter: true }),
      tone: c.avgWaitMinutes != null && c.avgWaitMinutes > grace ? "warn" : undefined
    }
  ];

  return (
    <section aria-label="Headline numbers">
      <div className="km">
        {cells.map((cell) => (
          <div className="km-cell" key={cell.label}>
            <div className="km-label">{cell.label}</div>
            <div className={`km-value${cell.tone ? ` ${cell.tone}` : ""}`}>{cell.value}</div>
            <div className="km-foot">
              <span className="km-sub">{cell.sub}</span>
              <DeltaChip delta={cell.delta} title={k.previous ? `Against ${windowLabel(k.previous)}` : undefined} />
            </div>
          </div>
        ))}
      </div>
      <p className="kc-formula">
        {k.previous ? `Changes are against ${windowLabel(k.previous)}. ` : "Nothing to compare against for this period. "}
        Gross is the line-haul plus fuel surcharge and layover, as on the phone. Per revenue mile is gross over the miles the pay covers.
        Empty miles are deadhead over every mile driven. Cleared the floor: pay after tracked fuel, tolls and other costs, per mile driven, at or above the truck&apos;s floor
        frozen when the load was accepted. Days to pay and paid within terms use paid invoices only. Wait at a stop is the recorded wait, against the free time in Settings.
      </p>
    </section>
  );
}
