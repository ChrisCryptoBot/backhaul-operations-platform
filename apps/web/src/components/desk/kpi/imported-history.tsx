import Link from "next/link";
import React from "react";
import { HISTORY_LABEL } from "@/lib/tracker-import";
import { pct, perMile, usd } from "@/lib/desk-format";
import type { ImportedHistory } from "@/server/tl/tracker-import";
import { Card } from "../ui";

/**
 * The carrier's own weekly tracker, as imported. It is shown under its own heading and is never added to a figure built from the desk's loads: the weeks above are the desk's, these are the spreadsheet's. Per mile
 * is over loaded miles (a tracker has no revenue-mile basis), and empty share is empty miles over every mile driven.
 */
const WEEKS_SHOWN = 26;
const LANES_SHOWN = 10;
const n = (v: number) => v.toLocaleString("en-US");
const day = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export function ImportedHistoryCard({ h }: { h: ImportedHistory }) {
  if (h.rows === 0) return null;
  const recent = [...h.weeks].slice(-WEEKS_SHOWN).reverse();
  return (
    <Card title={HISTORY_LABEL} action={<Link href="/loads/import/weekly" className="tl-btn sm">Import another tracker</Link>}>
      <p className="tl-sub" style={{ marginTop: 0 }}>
        Your own weekly tracker, {h.first ? `${day(h.first)} to ${day(h.last!)}` : ""}, from {h.sources.join(", ")}. It is kept apart from the loads on this desk: none of it is in the figures above, and none of it is a load.
      </p>
      <div className="tl-grid cols-2">
        <section aria-label="Imported weeks">
          <h3>The newest {recent.length} {recent.length === 1 ? "week" : "weeks"}</h3>
          <table className="tl-table" aria-label="Imported weeks">
            <thead>
              <tr>
                <th scope="col">Week of</th>
                <th scope="col" className="num">Loads</th>
                <th scope="col" className="num">Revenue</th>
                <th scope="col" className="num">Per loaded mile</th>
                <th scope="col" className="num">Empty miles</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((w) => (
                <tr key={w.weekStart}>
                  <td>{day(w.weekStart)}</td>
                  <td className="num">{n(w.loads)}</td>
                  <td className="num">{usd(w.revenue)}</td>
                  <td className="num">{perMile(w.perLoadedMile)}</td>
                  <td className="num">{pct(w.emptyShare, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section aria-label="Imported lanes">
          <h3>The biggest {Math.min(LANES_SHOWN, h.lanes.length)} {h.lanes.length === 1 ? "lane" : "lanes"}</h3>
          <table className="tl-table" aria-label="Imported lanes">
            <thead>
              <tr>
                <th scope="col">Lane</th>
                <th scope="col" className="num">Weeks</th>
                <th scope="col" className="num">Loads</th>
                <th scope="col" className="num">Revenue</th>
                <th scope="col" className="num">Per loaded mile</th>
                <th scope="col" className="num">Empty miles</th>
              </tr>
            </thead>
            <tbody>
              {h.lanes.slice(0, LANES_SHOWN).map((l) => (
                <tr key={l.lane}>
                  <td>{l.lane}</td>
                  <td className="num">{n(l.weeks)}</td>
                  <td className="num">{n(l.loads)}</td>
                  <td className="num">{usd(l.revenue)}</td>
                  <td className="num">{perMile(l.perLoadedMile)}</td>
                  <td className="num">{pct(l.emptyShare, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </Card>
  );
}
