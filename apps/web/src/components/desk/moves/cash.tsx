import React from "react";
import type { CashMoves, DayStats } from "@/lib/cash";
import { usd } from "@/lib/desk-format";
import { Card } from "../ui";

/**
 * Why it moved, on cash (money plan Wave 6 step 4): cash in this week against the week before, split by where it came from (the effects add back to the change to the cent), by lane or customer
 * (every event lands in one row, so the rows add up too), and how long the invoices paid in full each week took. Beside the gross bridge, never mixed into it.
 */
const m = (cents: number) => usd(cents / 100, 2);
const signed = (cents: number) => `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${usd(Math.abs(cents) / 100, 2)}`;
const daysText = (s: DayStats) => (s.reached === 0 ? "none paid in full" : `median ${s.median} ${s.median === 1 ? "day" : "days"} (${s.reached} paid in full)`);

export function CashMovesCard({ c, before, after, by }: { c: CashMoves & { leftOut: number; truncated: boolean }; before: string; after: string; by: "lane" | "customer" }) {
  const b = c.bridge;
  const rows = c.rows.slice(0, 25);
  const rest = c.rows.slice(25);
  return (
    <Card title="Cash in, and what moved it">
      <p>
        <b>{m(b.after.net)}</b> came in the week ending {after}, against {m(b.before.net)} the week before: <b>{signed(b.change)}</b>. Days from invoice to paid in full: {daysText(c.days.after)} this week,{" "}
        {daysText(c.days.before)} the week before.
      </p>
      <table className="tl-table" aria-label="Cash bridge">
        <thead>
          <tr>
            <th>Where it came from</th>
            <th className="num">Week ending {before}</th>
            <th className="num">Week ending {after}</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {b.effects.map((e) => (
            <tr key={e.source}>
              <td>{e.label}</td>
              <td className="num">{m(b.before[e.source])}</td>
              <td className="num">{m(b.after[e.source])}</td>
              <td className="num">{signed(e.cents)}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Cash in, net</th>
            <td className="num">{m(b.before.net)}</td>
            <td className="num">{m(b.after.net)}</td>
            <td className="num">
              <b>{signed(b.change)}</b>
            </td>
          </tr>
        </tbody>
      </table>
      <h3 className="kc-sub cash-by">{by === "lane" ? "Cash in by lane" : "Cash in by customer"}</h3>
      {rows.length === 0 ? (
        <p className="tl-sub">No cash came in either week.</p>
      ) : (
        <table className="tl-table" aria-label="Cash by row">
          <thead>
            <tr>
              <th>{by === "lane" ? "Lane" : "Customer"}</th>
              <th className="num">Before</th>
              <th className="num">After</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td>
                <td className="num">{m(r.before)}</td>
                <td className="num">{m(r.after)}</td>
                <td className="num">{signed(r.change)}</td>
              </tr>
            ))}
            {rest.length > 0 ? (
              <tr>
                <td className="tl-sub">{rest.length} more</td>
                <td />
                <td />
                <td className="num">{signed(rest.reduce((s, r) => s + r.change, 0))}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      )}
      <p className="tl-sub">
        Cash is booked as the journal books it: customer payments (not while a factor owned the invoice), the factor&apos;s advance on the day it funded, its reserve on the day it released it, and a
        chargeback taking the advance back. An invoice of several loads is grouped as &quot;Several lanes&quot;. Gross above is the agreed rate and is not changed by any of this.
        {c.leftOut > 0 ? ` ${c.leftOut} ${c.leftOut === 1 ? "invoice is" : "invoices are"} left out: ${c.leftOut === 1 ? "its" : "their"} loads are both in and out of the terminals in view, or carry no load.` : ""}
      </p>
    </Card>
  );
}
