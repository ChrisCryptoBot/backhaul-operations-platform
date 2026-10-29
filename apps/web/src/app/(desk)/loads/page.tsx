import Link from "next/link";
import React from "react";
import { listBoardRows } from "@/server/tl/queries";
import { AssignmentChip, Empty, PageHead, StatusChip, Tabs, VerdictChip } from "@/components/desk/ui";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";

const FILTERS = [
  { key: "all", label: "All" },
  { key: "draft", label: "Needs a driver" },
  { key: "accepted", label: "Accepted" },
  { key: "in_progress", label: "On the road" },
  { key: "completed", label: "Delivered" }
] as const;

export default async function LoadsPage({ searchParams }: { searchParams?: { status?: string } }) {
  const rows = await listBoardRows();
  const active = FILTERS.some((f) => f.key === searchParams?.status) ? (searchParams!.status as string) : "all";
  const shown = active === "all" ? rows : rows.filter((r) => r.status === active);
  const counts = (key: string) => (key === "all" ? rows.length : rows.filter((r) => r.status === key).length);

  return (
    <>
      <PageHead title="Loads" sub="Every load, with the verdict on the truck's own cost: the same figure TrueLane gives a driver on the Calculate screen." />
      <Tabs active={active} hrefFor={(k) => (k === "all" ? "/loads" : `/loads?status=${k}`)} items={FILTERS.map((f) => ({ ...f, count: counts(f.key) }))} />
      <div className="tl-card" style={{ padding: 0, overflowX: "auto" }}>
        {shown.length === 0 ? (
          <Empty>No loads here.</Empty>
        ) : (
          <table className="tl-table">
            <thead>
              <tr>
                <th>Load</th>
                <th>Lane</th>
                <th>Pickup</th>
                <th>Truck</th>
                <th className="num">Miles</th>
                <th className="num">Pay</th>
                <th className="num">$/mi</th>
                <th>Verdict</th>
                <th>Status</th>
                <th>Driver</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/loads/${r.id}`}>{r.loadNumber ?? "—"}</Link>
                    <div className="tl-sub">{r.brokerName}</div>
                  </td>
                  <td>
                    {r.origin} → {r.destination}
                  </td>
                  <td>{shortDate(r.scheduledDate)}</td>
                  <td>{r.vehicleName ?? "—"}</td>
                  <td className="num">{miles(r.totalMiles)}</td>
                  <td className="num">{usd(r.quotedRevenue)}</td>
                  <td className="num">
                    {perMile(r.perMile)}
                    <div className="tl-sub">floor {perMile(r.floorPerMile)}</div>
                  </td>
                  <td>{r.status === "completed" ? <span className="tl-sub">—</span> : <VerdictChip verdict={r.verdict} />}</td>
                  <td>
                    <StatusChip status={r.status} />
                  </td>
                  <td>
                    {r.driverName ?? <span className="tl-sub">—</span>}
                    {r.assignmentStatus && r.status !== "completed" ? (
                      <div>
                        <AssignmentChip status={r.assignmentStatus} />
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
