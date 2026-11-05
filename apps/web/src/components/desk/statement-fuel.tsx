import React from "react";
import { dayYear, gallons, usd } from "@/lib/desk-format";
import type { FuelLine } from "@/lib/settlement";

/** A purchase's day is a calendar date: read it at noon UTC so no clock moves it to a neighbouring day. */
const dayOf = (on: string) => dayYear(new Date(`${on}T12:00:00Z`), "UTC");

/**
 * The fuel card ledger on a driver statement: each purchase deducted with its day, where, gallons and what the card was charged, and the total that came off. Plain table markup, so it prints as
 * the sheet's other tables do (the `.rp` sheet). Nothing here when no fuel was deducted.
 */
export function FuelLedger({ fuel, total, caption = "Fuel card purchases deducted" }: { fuel: FuelLine[]; total: number; caption?: string }) {
  if (fuel.length === 0) return null;
  return (
    <>
      <h2>Fuel card</h2>
      <table aria-label={caption}>
        <thead>
          <tr>
            <th>Date</th>
            <th>Where</th>
            <th>Load</th>
            <th className="num">Gallons</th>
            <th className="num">Charged</th>
          </tr>
        </thead>
        <tbody>
          {fuel.map((f) => (
            <tr key={f.id}>
              <td>{dayOf(f.on)}</td>
              <td>{f.location ?? "—"}</td>
              <td>{f.loadNumber ?? "—"}</td>
              <td className="num">{gallons(f.gallons)}</td>
              <td className="num rp-bad">{usd(-f.amount, 2)}</td>
            </tr>
          ))}
          <tr>
            <td colSpan={4}>
              <b>Fuel card, {fuel.length} {fuel.length === 1 ? "purchase" : "purchases"}</b>
            </td>
            <td className="num rp-bad">
              <b>{usd(-total, 2)}</b>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}

/** The statement's bottom line: pay for the loads, less fuel, plus the adjustments, and the net. With no fuel it is the single total line it always was. */
export function NetPay({ driverName, loadsTotal, fuelTotal, adjustmentsTotal, total, hasFuel, label = "Total" }: { driverName: string; loadsTotal: number; fuelTotal: number; adjustmentsTotal: number; total: number; hasFuel: boolean; label?: string }) {
  return (
    <>
      <h2>{hasFuel ? "Net pay" : label}</h2>
      <table aria-label={hasFuel ? "Net pay" : label}>
        <tbody>
          {hasFuel ? (
            <>
              <tr>
                <td>Pay for loads</td>
                <td className="num">{usd(loadsTotal, 2)}</td>
              </tr>
              <tr>
                <td>Fuel card</td>
                <td className="num rp-bad">{usd(-fuelTotal, 2)}</td>
              </tr>
              <tr>
                <td>Adjustments</td>
                <td className={`num ${adjustmentsTotal < 0 ? "rp-bad" : ""}`}>{usd(adjustmentsTotal, 2)}</td>
              </tr>
            </>
          ) : null}
          <tr>
            <td>
              <b>{hasFuel ? `Net pay to ${driverName}` : `Total to ${driverName}`}</b>
            </td>
            <td className="num">
              <b>{usd(total, 2)}</b>
            </td>
          </tr>
        </tbody>
      </table>
    </>
  );
}
