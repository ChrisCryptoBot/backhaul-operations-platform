import Link from "next/link";
import React from "react";
import { listDrivers } from "@/server/tl/queries";
import { AssignmentChip, Empty, PageHead } from "@/components/desk/ui";
import { shortDate } from "@/lib/desk-format";

export default async function DriversPage() {
  const drivers = await listDrivers();
  return (
    <>
      <PageHead title="Drivers" sub="Who can take a load today. A lapsed CDL or medical card blocks the assignment." />
      <div className="tl-card" style={{ padding: 0, overflowX: "auto" }}>
        {drivers.length === 0 ? (
          <Empty>No drivers yet.</Empty>
        ) : (
          <table className="tl-table">
            <thead>
              <tr>
                <th>Driver</th>
                <th>Truck</th>
                <th>CDL</th>
                <th>Medical card</th>
                <th>Clearance</th>
                <th>On now</th>
                <th className="num">Delivered</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => (
                <tr key={d.id}>
                  <td>
                    <b>{d.name}</b>
                    <div className="tl-sub">{d.phone}</div>
                  </td>
                  <td>{d.truck ?? "—"}</td>
                  <td>Class {d.cdlClass ?? "?"} · to {shortDate(d.cdlExpiry)}</td>
                  <td>to {shortDate(d.medicalCardExpiry)}</td>
                  <td>{d.blocker ? <span className="tl-chip bad">{d.blocker}</span> : <span className="tl-chip ok">Clear</span>}</td>
                  <td>
                    {d.current.length === 0 ? (
                      <span className="tl-sub">—</span>
                    ) : (
                      d.current.map((c) => (
                        <div key={c.loadId}>
                          <Link href={`/loads/${c.loadId}`}>{c.loadNumber}</Link> <AssignmentChip status={c.status} />
                        </div>
                      ))
                    )}
                  </td>
                  <td className="num">{d.delivered}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
