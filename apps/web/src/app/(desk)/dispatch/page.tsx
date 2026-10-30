import Link from "next/link";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { currentTerminal } from "@/server/tl/terminal";
import { getAlerts } from "@/server/tl/alerts";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { topLevel, type Alert } from "@/lib/alerts";
import { Card, PageHead, VerdictChip } from "@/components/desk/ui";
import { AlertList } from "@/components/desk/alert-bits";
import { AssignButton } from "@/components/desk/assign-modal";
import { EmptyState } from "@/components/desk/kit/states";
import { miles, shortDate, usd } from "@/lib/desk-format";

export const metadata = { title: "Dispatch queue · TrueLane" };

/**
 * One signal per load: the most serious thing the alert rules say about it, else the verdict when it is not a plain "covers your cost", else
 * nothing. A load that is fine does not need a word. The driver, when there is one, is plain text beside it.
 */
function Signal({ r, alerts }: { r: BoardRow; alerts: Alert[] | undefined }) {
  const level = topLevel(alerts);
  const worst = level && level !== "info" ? alerts!.find((a) => a.level === level) : null;
  if (worst) return <span className={`dq-sig ${worst.level}`}>{worst.message}</span>;
  if (r.verdict && r.verdict !== "accept") return <VerdictChip verdict={r.verdict} />;
  return null;
}

function Row({ r, alerts, assign }: { r: BoardRow; alerts: Alert[] | undefined; assign?: boolean }) {
  return (
    <li className="dq-row">
      <div className="dq-top">
        <Link href={`/loads/${r.id}`}>
          {r.loadNumber} <span className="dq-rate">{usd(r.quotedRevenue)}</span>
        </Link>
        <span className="tl-sub">{shortDate(r.scheduledDate)}</span>
      </div>
      <div className="tl-sub">
        {r.origin} → {r.destination} · {miles(r.totalMiles)}
      </div>
      <div className="dq-foot">
        <span className="dq-who">
          <Signal r={r} alerts={alerts} />
          {r.driverName ? <span className="tl-sub">{r.driverName}</span> : null}
        </span>
        {assign ? <AssignButton loadId={r.id} loadNumber={r.loadNumber ?? "This load"} label={r.driverName ? "Change driver" : "Assign"} /> : null}
      </div>
    </li>
  );
}

const soonest = (a: BoardRow, b: BoardRow) => (a.scheduledDate?.getTime() ?? Infinity) - (b.scheduledDate?.getTime() ?? Infinity);

/** Loads shown in each column at a time; a big fleet has hundreds waiting. "Show more" adds this many (the soonest pickups are first, so what matters is on top). */
const COLUMN_STEP = 30;

export default async function DispatchPage({ searchParams }: { searchParams?: { needs?: string; sent?: string; road?: string } }) {
  const [rows, { alerts, byLoad }] = await Promise.all([listBoardRows(currentWorkspaceId(), "open", await currentTerminal()), getAlerts(new Date(), currentWorkspaceId(), "shell")]);
  const needs = rows.filter((r) => r.status === "draft" && (!r.assignmentStatus || r.assignmentStatus === "draft" || r.assignmentStatus === "declined")).sort(soonest);
  const sent = rows.filter((r) => r.assignmentStatus === "dispatched").sort(soonest);
  const road = rows.filter((r) => r.status === "accepted" || r.status === "in_progress").filter((r) => r.assignmentStatus !== "dispatched").sort(soonest);
  const urgent = alerts.filter((a) => a.level !== "info");
  const shownOf = (param: string | undefined) => Math.max(COLUMN_STEP, Math.min(Number.parseInt(param ?? "", 10) || COLUMN_STEP, 5_000));
  const limits = { needs: shownOf(searchParams?.needs), sent: shownOf(searchParams?.sent), road: shownOf(searchParams?.road) };
  const moreHref = (column: keyof typeof limits) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...limits, [column]: limits[column] + COLUMN_STEP })) if (v > COLUMN_STEP) u.set(k, String(v));
    return `/dispatch?${u.toString()}`;
  };
  const More = ({ column, total }: { column: keyof typeof limits; total: number }) =>
    total > limits[column] ? (
      <p className="tl-note" style={{ marginTop: 10 }}>
        The soonest {limits[column]} of {total}. <Link href={moreHref(column)} scroll={false}>Show {Math.min(COLUMN_STEP, total - limits[column])} more</Link>
      </p>
    ) : null;

  return (
    <>
      <PageHead title="Dispatch queue" sub="What needs a driver, what is waiting on an answer, and what is moving. Soonest pickup first.">
        <Link href="/quote" className="tl-btn">Price an offer</Link>
      </PageHead>

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
          {needs.length === 0 ? (
            <EmptyState icon="check" title="Nothing waiting">Every load has a driver.</EmptyState>
          ) : (
            <ul className="dq">
              {needs.slice(0, limits.needs).map((r) => (
                <Row key={r.id} r={r} alerts={byLoad.get(r.id)} assign />
              ))}
            </ul>
          )}
          <More column="needs" total={needs.length} />
        </Card>
        <Card title={`Sent, waiting · ${sent.length}`}>
          {sent.length === 0 ? (
            <EmptyState icon="dispatch" title="Nothing out for an answer">Loads you send appear here until the driver answers.</EmptyState>
          ) : (
            <ul className="dq">
              {sent.slice(0, limits.sent).map((r) => (
                <Row key={r.id} r={r} alerts={byLoad.get(r.id)} />
              ))}
            </ul>
          )}
          <More column="sent" total={sent.length} />
        </Card>
        <Card title={`Accepted and moving · ${road.length}`}>
          {road.length === 0 ? (
            <EmptyState icon="trucks" title="Nothing on the road">Accepted loads show here until they are delivered.</EmptyState>
          ) : (
            <ul className="dq">
              {road.slice(0, limits.road).map((r) => (
                <Row key={r.id} r={r} alerts={byLoad.get(r.id)} />
              ))}
            </ul>
          )}
          <More column="road" total={road.length} />
        </Card>
      </div>
    </>
  );
}
