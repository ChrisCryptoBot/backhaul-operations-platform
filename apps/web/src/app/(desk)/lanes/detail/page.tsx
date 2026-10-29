import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getDeskKpi } from "@/server/tl/kpi";
import { listBoardRows } from "@/server/tl/queries";
import { Card, PageHead, Stat, StatusChip } from "@/components/desk/ui";
import { shortLane } from "@/components/desk/kpi/parts";
import { emptyZone } from "@/lib/thresholds";
import { miles, pct, perMile, shortDate, signedPct, usd } from "@/lib/desk-format";

export const dynamic = "force-dynamic";

const MARKET = { above: "above the market", below: "below the market", unknown: "no market rate on its loads" } as const;

/** One lane (a pair of cities): what it has paid, who pays on it, who has driven it, and its loads. */
export default async function LanePage({ searchParams }: { searchParams?: { lane?: string } }) {
  const lane = (searchParams?.lane ?? "").trim();
  if (!lane) notFound();
  const [k, board] = await Promise.all([getDeskKpi({ period: "all", compare: false, filters: { lane } }), listBoardRows()]);
  const row = k.lanes.find((l) => l.key === lane) ?? null;
  const loads = board.filter((r) => `${r.origin ?? "?"} → ${r.destination ?? "?"}` === lane).sort((a, b) => (b.scheduledDate?.getTime() ?? 0) - (a.scheduledDate?.getTime() ?? 0));
  if (!row && loads.length === 0) notFound();
  const zone = row ? emptyZone(row.emptyShare, k.thresholds) : null;

  return (
    <>
      <PageHead title={shortLane(lane)} sub={lane}>
        <Link href="/lanes" className="tl-btn">All lanes</Link>
        <Link href={`/loads?q=${encodeURIComponent(lane.split(" → ")[0]!.split(",")[0]!)}`} className="tl-btn">Loads from here</Link>
      </PageHead>

      {row ? (
        <div className="tl-grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="Finished loads" value={String(row.loads)} sub={`${usd(row.gross)} gross`} />
          <Stat label="Paid per mile" value={perMile(row.rpm)} sub={row.marketVariancePct != null ? `${signedPct(row.marketVariancePct)}, ${MARKET[row.status]}` : MARKET.unknown} tone={row.status === "below" ? "bad" : row.status === "above" ? "ok" : undefined} />
          <Stat label="Empty miles" value={pct(row.emptyShare, 1)} sub={`${miles(row.avgPickupEmpty)} before the pickup, ${miles(row.avgReturnEmpty)} after the delivery`} tone={zone === "red" ? "bad" : zone === "amber" ? "warn" : undefined} />
          <Stat label="On the board now" value={String(loads.filter((l) => ["draft", "accepted", "in_progress"].includes(l.status)).length)} sub="open loads on this lane" />
        </div>
      ) : (
        <p className="tl-note" style={{ marginBottom: 14 }}>No load has finished on this lane yet, so there is nothing to score. Its open loads are below.</p>
      )}

      {k.brokers.length > 0 ? (
        <Card title="Who pays on it" className="tl-card">
          <table className="tl-table" aria-label="Who pays on this lane">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Loads</th>
                <th className="num">Per mile</th>
                <th className="num">Days to pay</th>
              </tr>
            </thead>
            <tbody>
              {k.brokers.map((b) => (
                <tr key={b.name}>
                  <td><Link href={`/customers/new?name=${encodeURIComponent(b.name)}`}>{b.name}</Link></td>
                  <td className="num">{b.loads}</td>
                  <td className="num">{perMile(b.rpm)}</td>
                  <td className="num">{b.avgDaysToPay == null ? <span className="dim">—</span> : `${b.avgDaysToPay.toFixed(1)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {k.drivers.length > 0 ? (
        <Card title="Who has driven it" className="tl-card">
          <table className="tl-table" aria-label="Who has driven this lane">
            <thead>
              <tr>
                <th>Driver</th>
                <th className="num">Loads</th>
                <th className="num">Per mile</th>
                <th className="num">Empty</th>
              </tr>
            </thead>
            <tbody>
              {k.drivers.map((d) => (
                <tr key={d.name}>
                  <td>{d.name}</td>
                  <td className="num">{d.loads}</td>
                  <td className="num">{perMile(d.rpm)}</td>
                  <td className="num">{pct(d.emptyShare, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card title={`Loads on this lane · ${loads.length}`} className="tl-card">
        {loads.length === 0 ? (
          <p className="tl-note">None on the board.</p>
        ) : (
          <table className="tl-table" aria-label="Loads on this lane">
            <thead>
              <tr>
                <th>Load</th>
                <th>Pickup</th>
                <th>Customer</th>
                <th>Driver</th>
                <th>State</th>
                <th className="num">All-in a mile</th>
                <th className="num">Floor</th>
              </tr>
            </thead>
            <tbody>
              {loads.slice(0, 15).map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/loads/${l.id}`}>{l.loadNumber}</Link></td>
                  <td>{shortDate(l.scheduledDate)}</td>
                  <td>{l.brokerName ?? <span className="dim">—</span>}</td>
                  <td>{l.driverName ?? <span className="dim">—</span>}</td>
                  <td><StatusChip status={l.status} /></td>
                  <td className="num">{perMile(l.perMile)}</td>
                  <td className="num">{perMile(l.floorPerMile)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {loads.length > 15 ? <p className="tl-note" style={{ marginTop: 10 }}>The latest 15 of {loads.length}.</p> : null}
      </Card>
    </>
  );
}
