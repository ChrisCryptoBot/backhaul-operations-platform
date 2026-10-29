import Link from "next/link";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { Card, Empty, PageHead, VerdictChip } from "@/components/desk/ui";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";

function Item({ r }: { r: BoardRow }) {
  return (
    <Link href={`/loads/${r.id}`} className="tl-queue-item">
      <b>{r.loadNumber} · {usd(r.quotedRevenue)}</b>
      <span className="tl-sub">{r.origin} → {r.destination} · {shortDate(r.scheduledDate)} · {miles(r.totalMiles)}</span>
      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <VerdictChip verdict={r.verdict} />
        <span className="tl-sub">{perMile(r.perMile)} vs floor {perMile(r.floorPerMile)}</span>
        {r.driverName ? <span className="tl-sub">· {r.driverName}</span> : null}
      </div>
    </Link>
  );
}

export default async function DispatchPage() {
  const rows = await listBoardRows();
  const needs = rows.filter((r) => r.status === "draft" && (!r.assignmentStatus || r.assignmentStatus === "draft" || r.assignmentStatus === "declined"));
  const sent = rows.filter((r) => r.assignmentStatus === "dispatched");
  const road = rows.filter((r) => r.status === "accepted" || r.status === "in_progress").filter((r) => r.assignmentStatus !== "dispatched");

  return (
    <>
      <PageHead title="Dispatch queue" sub="What still needs a driver, what is waiting on an answer, and what is moving." />
      <div className="tl-cols">
        <Card title={`Needs a driver · ${needs.length}`}>{needs.length === 0 ? <Empty>Nothing waiting.</Empty> : needs.map((r) => <Item key={r.id} r={r} />)}</Card>
        <Card title={`Sent, waiting · ${sent.length}`}>{sent.length === 0 ? <Empty>No loads out for an answer.</Empty> : sent.map((r) => <Item key={r.id} r={r} />)}</Card>
        <Card title={`Accepted and moving · ${road.length}`}>{road.length === 0 ? <Empty>Nothing on the road.</Empty> : road.map((r) => <Item key={r.id} r={r} />)}</Card>
      </div>
    </>
  );
}
