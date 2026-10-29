import Link from "next/link";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import type { Alert } from "@/lib/alerts";
import { Card, PageHead, VerdictChip } from "@/components/desk/ui";
import { AlertDot, AlertList } from "@/components/desk/alert-bits";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, perMile, shortDate, usd } from "@/lib/desk-format";

function Item({ r, alerts }: { r: BoardRow; alerts: Alert[] | undefined }) {
  return (
    <Link href={`/loads/${r.id}`} className="tl-queue-item">
      <b>
        {r.loadNumber} · {usd(r.quotedRevenue)}
        <AlertDot alerts={alerts} />
      </b>
      <span className="tl-sub">{r.origin} → {r.destination}</span>
      <span className="tl-sub">Pickup {shortDate(r.scheduledDate)} · {miles(r.totalMiles)}</span>
      <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <VerdictChip verdict={r.verdict} />
        <span className="tl-sub">{perMile(r.perMile)} vs floor {perMile(r.floorPerMile)}</span>
        {r.driverName ? <span className="tl-sub">· {r.driverName}</span> : null}
      </div>
    </Link>
  );
}

const soonest = (a: BoardRow, b: BoardRow) => (a.scheduledDate?.getTime() ?? Infinity) - (b.scheduledDate?.getTime() ?? Infinity);

export default async function DispatchPage() {
  const [rows, { alerts, byLoad }] = await Promise.all([listBoardRows(), getAlerts()]);
  const needs = rows.filter((r) => r.status === "draft" && (!r.assignmentStatus || r.assignmentStatus === "draft" || r.assignmentStatus === "declined")).sort(soonest);
  const sent = rows.filter((r) => r.assignmentStatus === "dispatched").sort(soonest);
  const road = rows.filter((r) => r.status === "accepted" || r.status === "in_progress").filter((r) => r.assignmentStatus !== "dispatched").sort(soonest);
  const urgent = alerts.filter((a) => a.level !== "info");

  return (
    <>
      <PageHead title="Dispatch queue" sub="What still needs a driver, what is waiting on an answer, and what is moving. The soonest pickup is first in each column." />

      {urgent.length > 0 ? (
        <Card title={`Needs attention · ${urgent.length}`} className="tl-card">
          <AlertList alerts={urgent.slice(0, 5)} withLoad />
          {urgent.length > 5 ? (
            <p className="tl-note" style={{ marginTop: 10 }}>
              <Link href="/alerts">See all {urgent.length} alerts</Link>
            </p>
          ) : null}
        </Card>
      ) : null}

      <div className="tl-cols" style={{ marginTop: urgent.length > 0 ? 16 : 0 }}>
        <Card title={`Needs a driver · ${needs.length}`}>
          {needs.length === 0 ? <EmptyState icon="check" title="Nothing waiting">Every load has a driver.</EmptyState> : needs.map((r) => <Item key={r.id} r={r} alerts={byLoad.get(r.id)} />)}
        </Card>
        <Card title={`Sent, waiting · ${sent.length}`}>
          {sent.length === 0 ? <EmptyState icon="dispatch" title="Nothing out for an answer">Loads you send appear here until the driver answers.</EmptyState> : sent.map((r) => <Item key={r.id} r={r} alerts={byLoad.get(r.id)} />)}
        </Card>
        <Card title={`Accepted and moving · ${road.length}`}>
          {road.length === 0 ? <EmptyState icon="trucks" title="Nothing on the road">Accepted loads show here until they are delivered.</EmptyState> : road.map((r) => <Item key={r.id} r={r} alerts={byLoad.get(r.id)} />)}
        </Card>
      </div>
    </>
  );
}
