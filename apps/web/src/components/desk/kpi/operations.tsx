import React from "react";
import type { DeskKpi } from "@/server/tl/kpi";
import { deltaOf } from "@/lib/kpi-view";
import { changeOf } from "@/lib/kpi-extras";
import { miles, pct, perGallon, perMile, usd } from "@/lib/desk-format";
import { ChartFrame, DeltaChip, shortLane } from "./parts";
import { DieselReadButton } from "./inputs";

/**
 * The cards that make the dashboard read like a weekly operations tracker (docs/LEAK_AUDIT_2026-11.md): service (on time by pickup and drop, how far ahead loads are booked, loads moved), the
 * fuel surcharge week by week against the diesel price, offers received and booked, what kind of freight the revenue is, and the trucks running empty. Server rendered, no figure invented: a
 * number that cannot be told is a dash.
 */
const dash = <span className="dim">{"—"}</span>;
const days = (n: number | null) => (n == null ? dash : `${n.toFixed(1)} days`);

export function ServiceCard({ k }: { k: DeskKpi }) {
  const c = k.current;
  const p = k.prior;
  const rows: Array<[string, React.ReactNode, React.ReactNode, string]> = [
    ["On-time pickups", c.onTimePickup == null ? dash : pct(c.onTimePickup, 0), <DeltaChip key="a" delta={deltaOf(c.onTimePickup, p?.onTimePickup, { kind: "pts" })} />, `${c.pickupStops} stops with an arrival and a window`],
    ["On-time deliveries", c.onTimeDrop == null ? dash : pct(c.onTimeDrop, 0), <DeltaChip key="b" delta={deltaOf(c.onTimeDrop, p?.onTimeDrop, { kind: "pts" })} />, `${c.dropStops} stops with an arrival and a window`],
    ["Books ahead", days(c.leadDays), <DeltaChip key="c" delta={deltaOf(c.leadDays, p?.leadDays, { kind: "pct" })} />, `${c.leadLoads} loads with a pickup date`],
    ["Loads rolled", String(k.rolled.count), <DeltaChip key="d" delta={deltaOf(k.rolled.count, k.rolled.prior, { kind: "pct", lowerIsBetter: true })} />, "moved to a new pickup time"]
  ];
  return (
    <ChartFrame
      title="Service"
      unit="the period"
      empty={c.loads === 0 ? "Nothing finished in this period." : undefined}
      caption={k.rolled.reasons.length > 0 ? `Loads rolled most often because: ${k.rolled.reasons[0]!.label} (${k.rolled.reasons[0]!.count}).` : "No load was rolled in this period."}
      formula="On time is the share of stops the driver reached by the time the window closed, over stops that have both an arrival and a window, split by pickups and deliveries. Books ahead is the mean days from booking to the pickup date, over loads with a pickup date. Rolled is the loads moved to a new pickup time (a reschedule), counted when it happened."
      table={{ head: ["Measure", "Value", "Basis"], rows: rows.map((r) => [r[0], typeof r[1] === "string" ? r[1] : "", r[3]]) }}>
      <table className="tl-table" aria-label="Service">
        <tbody>
          {rows.map((r) => (
            <tr key={r[0]}>
              <th scope="row">{r[0]}</th>
              <td className="num">{r[1]}</td>
              <td>{r[2]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartFrame>
  );
}

export function FuelSurchargeCard({ k, canRead }: { k: DeskKpi; canRead: boolean }) {
  const weeks = k.trend.slice(-8);
  const last = k.trend[k.trend.length - 1];
  const before = k.trend[k.trend.length - 2];
  const perMileOf = (w: { fsc: number; loadedMiles: number }) => (w.loadedMiles > 0 ? w.fsc / w.loadedMiles : null);
  const dieselMove = changeOf(last?.diesel ?? null, before?.diesel ?? null);
  const c = k.current;
  return (
    <ChartFrame
      title="Fuel surcharge"
      unit="week by week against the diesel price"
      empty={c.loads === 0 && k.trend.every((w) => w.fsc === 0) ? "No surcharge on any finished load yet." : undefined}
      caption={
        <>
          {usd(c.fuelSurcharge, 0)} in this period: {c.fscPerMile == null ? "no loaded miles" : `${perMile(c.fscPerMile)} loaded`}
          {c.fscPct == null ? "" : `, ${pct(c.fscPct, 1)} of the line haul`}.{" "}
          {dieselMove != null ? `Diesel moved ${dieselMove >= 0 ? "+" : "−"}${(Math.abs(dieselMove) * 100).toFixed(1)}% since the week before.` : "The diesel history builds as the price is read: read it each week."}
          {canRead ? <> <DieselReadButton /></> : null}
        </>
      }
      formula="Surcharge is the fuel surcharge dollars on the loads finished in the week (loads store it as dollars). Per loaded mile divides it by loaded miles; the percentage divides it by the line haul (the rate without the surcharge). Diesel is the national on-highway price EIA published for the week in force at the end of that week, kept each time the desk reads it."
      table={{ head: ["Week", "Diesel", "Surcharge", "Per loaded mile", "Of line haul"], rows: weeks.map((w) => [w.label, perGallon(w.diesel, 3), usd(w.fsc, 0), perMile(perMileOf(w)), w.lineHaul > 0 ? pct(w.fsc / w.lineHaul, 1) : "—"]) }}>
      <table className="tl-table" aria-label="Fuel surcharge by week">
        <thead>
          <tr>
            <th>Week ending</th>
            <th className="num">Diesel</th>
            <th className="num">Surcharge</th>
            <th className="num">Per loaded mile</th>
            <th className="num">Of line haul</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((w) => (
            <tr key={w.end}>
              <td>{w.label}</td>
              <td className="num">{perGallon(w.diesel, 3)}</td>
              <td className="num">{usd(w.fsc, 0)}</td>
              <td className="num">{perMile(perMileOf(w))}</td>
              <td className="num">{w.lineHaul > 0 ? pct(w.fsc / w.lineHaul, 1) : dash}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartFrame>
  );
}

export function TenderCard({ k }: { k: DeskKpi }) {
  const t = k.tender;
  const c = t.current;
  return (
    <ChartFrame
      title="Offers and acceptance"
      unit="quotes received and what became of them"
      empty={c.received === 0 ? "No offer was saved or decided in this period." : undefined}
      caption={
        <>
          {c.received} {c.received === 1 ? "offer" : "offers"} received, {c.booked} booked, {c.passed} passed, {c.open} still open: {pct(c.acceptance, 0)} booked.{" "}
          <DeltaChip delta={deltaOf(c.acceptance, t.prior?.acceptance, { kind: "pts" })} title="Against the period before" />
        </>
      }
      formula="Offers received are quotes saved or decided in the period (a quote still undecided counts as received and open). Booked are offers that became a load (accepted, or overridden with a reason); passed are offers you turned down. Acceptance is booked over received."
      table={{ head: ["Week ending", "Received", "Booked", "Passed", "Acceptance"], rows: t.weeks.map((w) => [w.label, String(w.received), String(w.booked), String(w.passed), w.acceptance == null ? "—" : pct(w.acceptance, 0)]) }}>
      <table className="tl-table" aria-label="Offers by week">
        <thead>
          <tr>
            <th>Week ending</th>
            <th className="num">Received</th>
            <th className="num">Booked</th>
            <th className="num">Passed</th>
            <th className="num">Accepted</th>
          </tr>
        </thead>
        <tbody>
          {t.weeks.slice(-8).map((w) => (
            <tr key={w.end}>
              <td>{w.label}</td>
              <td className="num">{w.received}</td>
              <td className="num">{w.booked}</td>
              <td className="num">{w.passed}</td>
              <td className="num">{w.acceptance == null ? dash : pct(w.acceptance, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartFrame>
  );
}

export function MixCard({ k }: { k: DeskKpi }) {
  const m = k.mix;
  const block = (title: string, rows: typeof m.trailer) => (
    <div>
      <h3 className="kc-sub">{title}</h3>
      <table className="tl-table" aria-label={title}>
        <thead>
          <tr>
            <th>{title}</th>
            <th className="num">Loads</th>
            <th className="num">Of loads</th>
            <th className="num">Of revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{r.loads}</td>
              <td className="num">{pct(r.loadShare, 0)}</td>
              <td className="num">{pct(r.grossShare, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
  return (
    <ChartFrame
      title="Load mix"
      unit="finished loads in the period"
      empty={k.current.loads === 0 ? "Nothing finished in this period." : undefined}
      caption={m.customers[0] ? `${m.customers[0].label} is ${pct(m.customers[0].grossShare, 0)} of the revenue.` : undefined}
      formula="Each group's share of the finished loads and of the revenue (gross, with surcharge). The trailer and the load type are the ones typed on the load; a load with none is Not recorded. Customers are the top eight by revenue."
      className="kc-wide">
      <div className="tl-grid cols-3">
        {block("Trailer", m.trailer)}
        {block("Load type", m.loadType)}
        {block("Customer", m.customers)}
      </div>
    </ChartFrame>
  );
}

export function TruckEmptyCard({ k }: { k: DeskKpi }) {
  const rows = k.trucks;
  return (
    <ChartFrame
      title="Empty miles by truck"
      unit="the ten with the most, in the period"
      empty={rows.length === 0 ? "No finished load has a truck on it in this period." : undefined}
      caption={rows[0] ? `${rows[0].name} ran ${miles(rows[0].emptyMiles)} empty (${pct(rows[0].emptyShare, 0)} of its miles).` : undefined}
      formula="Empty miles are the deadhead before the pickup and after the delivery, over every mile the truck drove on its finished loads in the period."
      table={{ head: ["Truck", "Loads", "Miles driven", "Empty miles", "Empty"], rows: rows.map((r) => [r.name, String(r.loads), miles(r.drivenMiles), miles(r.emptyMiles), pct(r.emptyShare, 0)]) }}>
      <table className="tl-table" aria-label="Empty miles by truck">
        <thead>
          <tr>
            <th>Truck</th>
            <th className="num">Loads</th>
            <th className="num">Driven</th>
            <th className="num">Empty</th>
            <th className="num">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{r.name}</td>
              <td className="num">{r.loads}</td>
              <td className="num">{miles(r.drivenMiles)}</td>
              <td className="num">{miles(r.emptyMiles)}</td>
              <td className="num">{pct(r.emptyShare, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ChartFrame>
  );
}

/** The busiest lanes across the last six weeks: loads, revenue per mile and empty share for each week, and how the latest week moved against the one before. */
export function LaneWeeksCard({ k }: { k: DeskKpi }) {
  const heads = k.trend.slice(-6).map((w) => w.label);
  return (
    <ChartFrame
      title="Lanes, week by week"
      unit="the ten busiest lanes over the last six weeks"
      empty={k.laneWeeks.length === 0 ? "No lane finished a load in the last six weeks." : undefined}
      caption="Each cell is loads, then revenue per mile. The last column is the latest week against the week before."
      formula="Weeks end on the dates shown, counted on the workspace's clock. Revenue per mile is gross over the miles the pay covers. Change compares the latest week with the one before when both have loads."
      className="kc-wide">
      <table className="tl-table" aria-label="Lanes by week">
        <thead>
          <tr>
            <th>Lane</th>
            {heads.map((h) => (
              <th key={h} className="num">{h}</th>
            ))}
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {k.laneWeeks.map((l) => {
            const a = l.weeks[l.weeks.length - 1]!;
            const b = l.weeks[l.weeks.length - 2]!;
            return (
              <tr key={l.key}>
                <td title={l.key}>{shortLane(l.key)}</td>
                {l.weeks.map((w, i) => (
                  <td key={i} className="num">{w.loads === 0 ? dash : `${w.loads} · ${perMile(w.rpm)}`}</td>
                ))}
                <td className="num">{a.loads > 0 && b.loads > 0 ? <DeltaChip delta={deltaOf(a.rpm, b.rpm, { kind: "pct" })} /> : dash}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ChartFrame>
  );
}
