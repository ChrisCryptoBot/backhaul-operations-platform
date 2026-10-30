import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { deltaOf, type Delta } from "@/lib/kpi-view";
import { emptyZone } from "@/lib/thresholds";
import { windowLabel } from "@/lib/kpi-periods";
import { miles, pct, perMile, usd } from "@/lib/desk-format";
import { Tip, type TipData } from "../kit/tooltip";
import { DeltaChip } from "./parts";

type Cell = { label: string; value: string; sub: string; delta: Delta | null; tone?: "ok" | "warn" | "bad"; tip: TipData };

/** The headline numbers as a hairline grid, each with its change against the previous period. */
export function KpiMatrix({ k }: { k: DeskKpi }) {
  const c = k.current;
  const p = k.prior;
  const zone = emptyZone(c.emptyShare, k.thresholds);
  const grace = k.thresholds.detentionGraceMinutes;
  // What sits behind each headline number: the counts it is a share of, and the same figure for the period before. All of it is already on PeriodStats.
  const windowText = windowLabel(k.window);
  const before = (text: string): Array<[string, string]> => (k.previous ? [[windowLabel(k.previous), text]] : []);
  const of = (share: number | null, n: number) => (share == null || n === 0 ? "—" : `${Math.round(share * n)} of ${n}`);
  const hero: Cell = {
    label: "Gross revenue",
    value: usd(c.gross),
    sub: `${c.loads} finished ${c.loads === 1 ? "load" : "loads"}${c.tonuLoads > 0 ? ` (${c.tonuLoads} TONU)` : ""}${p ? `, ${p.loads} in the period before` : ""} · ${usd(c.netEstimate)} after tracked costs`,
    delta: deltaOf(c.gross, p?.gross, { kind: "pct" }),
    tip: {
      title: "Gross revenue",
      sub: windowText,
      rows: [
        ["Gross", usd(c.gross)],
        ["Finished loads", `${c.loads}${c.tonuLoads > 0 ? ` (${c.tonuLoads} TONU)` : ""}`],
        ["Tracked costs", usd(c.expenses)],
        ["After tracked costs", usd(c.netEstimate)],
        ...before(p ? `${usd(p.gross)} · ${p.loads} loads` : "—")
      ]
    }
  };
  const cells: Cell[] = [
    { label: "Per revenue mile", value: perMile(c.rpm), sub: `on ${miles(c.totalMiles)} driven`, delta: deltaOf(c.rpm, p?.rpm, { kind: "pct" }), tip: { title: "Per revenue mile", sub: windowText, rows: [["Gross", usd(c.gross)], ["Miles driven", miles(c.totalMiles)], ["Per revenue mile", perMile(c.rpm)], ...before(perMile(p?.rpm))] } },
    {
      label: "Empty miles",
      value: pct(c.emptyShare, 1),
      sub: `${miles(c.emptyMiles)} of ${miles(c.totalMiles)} driven`,
      delta: deltaOf(c.emptyShare, p?.emptyShare, { kind: "pts", lowerIsBetter: true }),
      tone: zone === "red" ? "bad" : zone === "amber" ? "warn" : zone === "ok" ? "ok" : undefined,
      tip: {
        title: "Empty miles",
        sub: windowText,
        rows: [["Empty miles", miles(c.emptyMiles)], ["Every mile driven", miles(c.totalMiles)], ["Share", pct(c.emptyShare, 1)], ["Amber / red lines", `${k.thresholds.emptyAmberPct}% / ${k.thresholds.emptyRedPct}%`], ...before(pct(p?.emptyShare, 1))]
      }
    },
    { label: "Cleared the floor", value: pct(c.clearedFloor), sub: c.judgedLoads > 0 ? `of ${c.judgedLoads} loads with a floor on file` : "no loads with a floor on file", delta: deltaOf(c.clearedFloor, p?.clearedFloor, { kind: "pts" }), tip: { title: "Cleared the floor", sub: windowText, rows: [["Cleared", of(c.clearedFloor, c.judgedLoads)], ["Share", pct(c.clearedFloor)], ...before(pct(p?.clearedFloor))], note: "Pay after tracked costs, per mile driven, at or above the truck's floor frozen when the load was accepted." } },
    { label: "Paid within terms", value: pct(c.paidWithinTerms), sub: c.paidLoads > 0 ? `of ${c.paidLoads} paid ${c.paidLoads === 1 ? "invoice" : "invoices"}` : "no paid invoices yet", delta: deltaOf(c.paidWithinTerms, p?.paidWithinTerms, { kind: "pts" }), tip: { title: "Paid within terms", sub: windowText, rows: [["Paid in time", of(c.paidWithinTerms, c.paidLoads)], ["Share", pct(c.paidWithinTerms)], ...before(pct(p?.paidWithinTerms))] } },
    { label: "Days to pay", value: c.avgDaysToPay == null ? "—" : `${c.avgDaysToPay.toFixed(1)} days`, sub: "invoice to payment, on paid invoices", delta: deltaOf(c.avgDaysToPay, p?.avgDaysToPay, { kind: "pct", lowerIsBetter: true }), tip: { title: "Days to pay", sub: windowText, rows: [["Average", c.avgDaysToPay == null ? "—" : `${c.avgDaysToPay.toFixed(1)} days`], ["Paid invoices", String(c.paidLoads)], ...before(p?.avgDaysToPay == null ? "—" : `${p.avgDaysToPay.toFixed(1)} days`)] } },
    {
      label: "Wait at a stop",
      value: c.avgWaitMinutes == null ? "—" : `${c.avgWaitMinutes.toFixed(0)} min`,
      sub: c.waitStops > 0 ? `${c.waitStops} stops · ${grace} min free` : "no waits recorded",
      delta: deltaOf(c.avgWaitMinutes, p?.avgWaitMinutes, { kind: "pct", lowerIsBetter: true }),
      tone: c.avgWaitMinutes != null && c.avgWaitMinutes > grace ? "warn" : undefined,
      tip: {
        title: "Wait at a stop",
        sub: windowText,
        rows: [["Average wait", c.avgWaitMinutes == null ? "—" : `${c.avgWaitMinutes.toFixed(0)} min`], ["Stops with a wait", String(c.waitStops)], ["Free time", `${grace} min`], ...before(p?.avgWaitMinutes == null ? "—" : `${p.avgWaitMinutes.toFixed(0)} min`)]
      }
    }
  ];

  const chip = <DeltaChip delta={hero.delta} title={k.previous ? `Against ${windowLabel(k.previous)}` : undefined} />;
  return (
    <section aria-label="Headline numbers">
      <Tip as="div" focusable className="km-hero" tip={hero.tip}>
        <div className="km-label">{hero.label}</div>
        <div className="km-herorow">
          <span className="km-big">{hero.value}</span>
          {chip}
        </div>
        <div className="km-sub">{hero.sub}</div>
      </Tip>
      <div className="km">
        {cells.map((cell) => (
          <Tip as="div" focusable className="km-cell" key={cell.label} tip={cell.tip}>
            <div className="km-label">{cell.label}</div>
            <div className={`km-value${cell.tone ? ` ${cell.tone}` : ""}`}>{cell.value}</div>
            <div className="km-foot">
              <span className="km-sub">{cell.sub}</span>
              <DeltaChip delta={cell.delta} title={k.previous ? `Against ${windowLabel(k.previous)}` : undefined} />
            </div>
          </Tip>
        ))}
      </div>
      <details className="kc-how">
        <summary>How these are worked out</summary>
        <p>
          {k.previous ? `Changes are against ${windowLabel(k.previous)}. ` : "Nothing to compare against for this period. "}
          Gross is the line-haul plus fuel surcharge and layover, as on the phone. Per revenue mile is gross over the miles the pay covers.
          Empty miles are deadhead over every mile driven. Cleared the floor: pay after tracked fuel, tolls and other costs, per mile driven, at or above the truck&apos;s floor
          frozen when the load was accepted. Days to pay and paid within terms use paid invoices only. Wait at a stop is the recorded wait, against the free time in Settings.
        </p>
      </details>
    </section>
  );
}
