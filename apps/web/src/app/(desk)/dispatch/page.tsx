import Link from "next/link";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { currentTerminal } from "@/server/tl/terminal";
import { currentAllowed } from "@/server/tl/scope";
import { getAlerts } from "@/server/tl/alerts";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { checkAccess } from "@/server/tl/access";
import { topLevel, type Alert } from "@/lib/alerts";
import { Card, PageHead, RowLink } from "@/components/desk/ui";
import { AssignButton } from "@/components/desk/assign-modal";
import { EmptyState } from "@/components/desk/kit/states";
import { dockTime, miles, shortDate, stopTime, usd } from "@/lib/desk-format";
import { recalledLoads, type RecalledLoad } from "@/server/tl/assignment-events";
import { RECALL_LABELS, recallDeliveryText } from "@/lib/recall-reasons";
import { openHandoffs, type OpenHandoff } from "@/server/tl/relay";
import { HANDOFF_STATE_LABEL, OUTGOING_NEXT_LABEL, handoffLevel, waitWords, type HandoffState, type OutgoingNext } from "@/lib/relay";

export const metadata = { title: "Dispatch queue · TrueLane" };

/**
 * One signal per load: the most serious thing the alert rules say about it, else the verdict when it is not a plain "covers your cost", else
 * nothing. A load that is fine does not need a word. The driver, when there is one, is plain text beside it.
 */
function Signal({ r, alerts }: { r: BoardRow; alerts: Alert[] | undefined }) {
  const level = topLevel(alerts);
  const worst = level && level !== "info" ? alerts!.find((a) => a.level === level) : null;
  if (worst) return <span className={`dq-sig ${worst.level}`}>{worst.message}</span>;
  if (r.verdict === "needs_fuel") return <span className="dq-sig warn">Needs fuel price</span>;
  if (r.perMile != null && r.floorPerMile != null && r.verdict && r.verdict !== "accept") {
    const gap = r.perMile - r.floorPerMile;
    return (
      <span className={`dq-sig ${gap < 0 ? "block" : "warn"}`}>
        {gap < 0 ? `$${Math.abs(gap).toFixed(2)}/mi below floor` : `+$${gap.toFixed(2)}/mi vs floor`}
      </span>
    );
  }
  return null;
}

/** One load in a column: which and for how much, where and when, the one thing to know about it, and the one thing to do. The whole row opens the load; the button does the next step without opening it. */
function Row({ r, alerts, assign, recall }: { r: BoardRow; alerts: Alert[] | undefined; assign?: boolean; recall?: RecalledLoad }) {
  return (
    <li className="dq-row row-open">
      <div className="dq-top">
        <span>
          <RowLink href={`/loads/${r.id}`}>{r.loadNumber ?? "Load"}</RowLink> <span className="dq-rate">{usd(r.grossRevenue)}</span>
        </span>
        <span className="tl-sub" title={r.pickupAt ? stopTime(r.pickupAt, r.pickupZone) : undefined}>{r.pickupAt ? dockTime(r.pickupAt, r.pickupZone) : shortDate(r.scheduledDate)}</span>
      </div>
      <div className="dq-lane">
        <span className="cut">
          {r.origin} → {r.destination} · {miles(r.totalMiles)}
        </span>
        {r.driverName ? <span>{r.driverName}</span> : null}
      </div>
      {recall ? (
        <div className="tl-sub">
          <span className="dq-sig warn">Recalled{recall.code ? ` · ${RECALL_LABELS[recall.code]}` : ""}{recall.driverName ? ` · was ${recall.driverName}` : ""}</span>
          <div>{recallDeliveryText(recall.delivery)}</div>
          {recall.note ? <div>“{recall.note}”</div> : null}
        </div>
      ) : null}
      <div className="dq-foot">
        <span className="dq-who">
          <Signal r={r} alerts={alerts} />
        </span>
        {assign ? <AssignButton loadId={r.id} loadNumber={r.loadNumber ?? "This load"} label={r.driverName ? "Change driver" : "Assign"} /> : <span className="row-go" aria-hidden="true">›</span>}
      </div>
    </li>
  );
}

/** A load a driver dropped at a relay point, waiting in the yard for its next driver. The next driver is entered on the load's page, where the drivers and trucks are. */
function HandoffRow({ h, may }: { h: OpenHandoff; may: boolean }) {
  const level = handoffLevel(h, new Date());
  return (
    <li className="dq-row row-open">
      <div className="dq-top">
        <RowLink href={`/loads/${h.load.id}`}>{h.load.loadNumber ?? "Load"}</RowLink>
        <span className="tl-sub">{waitWords(h.waitedMinutes)} waiting</span>
      </div>
      <div className="tl-sub">{h.badge}</div>
      <div className="tl-sub">
        {h.outDriverName ?? "The driver"} left it{h.locationSlot ? ` at spot ${h.locationSlot}` : ""}{h.trailerNumber ? ` · trailer ${h.trailerNumber}` : ""}
        {h.outgoingNext ? ` · they ${OUTGOING_NEXT_LABEL[h.outgoingNext as OutgoingNext]?.toLowerCase() ?? h.outgoingNext}` : ""}
      </div>
      <div className="dq-foot">
        <span className="dq-who">
          {h.discrepancyFlagged && !h.ackAt ? <span className="dq-sig block">Something was reported wrong</span> : level ? <span className={`dq-sig ${level}`}>{HANDOFF_STATE_LABEL[h.state as HandoffState]}, getting long</span> : <span className="tl-sub">{HANDOFF_STATE_LABEL[h.state as HandoffState]}</span>}
        </span>
        {may ? <Link href={`/loads/${h.load.id}`} className="tl-btn sm">Open to hand over</Link> : null}
      </div>
    </li>
  );
}

const soonest = (a: BoardRow, b: BoardRow) => (a.scheduledDate?.getTime() ?? Infinity) - (b.scheduledDate?.getTime() ?? Infinity);

/** Loads shown in each column at a time; a big fleet has hundreds waiting. "Show more" adds this many (the soonest pickups are first, so what matters is on top). */
const COLUMN_STEP = 30;

export default async function DispatchPage({ searchParams }: { searchParams?: { needs?: string; sent?: string; road?: string } }) {
  const [rows, { alerts, byLoad }, dispatchAccess, waiting] = await Promise.all([listBoardRows(currentWorkspaceId(), "open", await currentTerminal()), getAlerts(new Date(), currentWorkspaceId(), "shell", undefined, await currentTerminal()), checkAccess("dispatch"), openHandoffs(currentWorkspaceId(), await currentAllowed())]);
  // A viewer or the accounting office reads this page; the button that changes a driver is only for someone the server would let do it.
  const mayAssign = dispatchAccess.ok;
  const needsAll = rows.filter((r) => r.status === "draft" && (!r.assignmentStatus || r.assignmentStatus === "draft" || r.assignmentStatus === "declined"));
  // A load whose last move was a recall is pinned first: someone was taken off it, and it should not sit quietly among the rest.
  const recalls = await recalledLoads(needsAll.map((r) => r.id), currentWorkspaceId());
  const needs = needsAll.sort((x, y) => Number(recalls.has(y.id)) - Number(recalls.has(x.id)) || soonest(x, y));
  const sent = rows.filter((r) => r.assignmentStatus === "dispatched").sort(soonest);
  const inYard = new Set(waiting.map((h) => h.loadId));
  const road = rows.filter((r) => r.status === "accepted" || r.status === "in_progress").filter((r) => r.assignmentStatus !== "dispatched" && !inYard.has(r.id)).sort(soonest);
  // The alerts are said once, on the Alerts page and on each load below; here they are a count and a way in, so the three columns are what is on screen.
  const blocks = alerts.filter((a) => a.level === "block");
  const warns = alerts.filter((a) => a.level === "warn");
  const unsent = blocks.filter((a) => a.code === "PICKUP_NO_DRIVER").length;
  const clashes = blocks.filter((a) => a.code === "DOUBLE_BOOKED" || a.code === "TRUCK_DOUBLE_BOOKED").length;
  const other = blocks.length - unsent - clashes;
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
        <Link href="/quote" className="tl-btn ghost">Price an offer</Link>
      </PageHead>

      {blocks.length + warns.length > 0 ? (
        <p className="dq-strip row-open" data-level={blocks.length > 0 ? "block" : "warn"} role="status">
          <b>{blocks.length > 0 ? `${blocks.length} to fix before they go out` : `${warns.length} to look at soon`}</b>
          <span>
            {[
              unsent > 0 ? `${unsent} ${unsent === 1 ? "pickup" : "pickups"} with no driver sent` : null,
              clashes > 0 ? `${clashes} on overlapping loads` : null,
              other > 0 ? `${other} other` : null,
              blocks.length > 0 && warns.length > 0 ? `${warns.length} more to look at soon` : null
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <RowLink href={blocks.length > 0 ? "/alerts?level=block" : "/alerts?level=warn"}>See them in Alerts</RowLink>
          <i className="row-go" aria-hidden="true">›</i>
        </p>
      ) : null}

      {waiting.length > 0 ? (
        <Card title={`Awaiting handoff · ${waiting.length}`} className="tl-card">
          <ul className="dq">
            {waiting.map((h) => (
              <HandoffRow key={h.id} h={h} may={mayAssign} />
            ))}
          </ul>
        </Card>
      ) : null}

      <div className="tl-cols dq-cols">
        <Card title={`Needs a driver · ${needs.length}`}>
          {needs.length === 0 ? (
            <EmptyState icon="check" title="Nothing waiting">Every load has a driver.</EmptyState>
          ) : (
            <ul className="dq">
              {needs.slice(0, limits.needs).map((r) => (
                <Row key={r.id} r={r} alerts={byLoad.get(r.id)} assign={mayAssign} recall={recalls.get(r.id)} />
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
                <Row key={r.id} r={r} alerts={byLoad.get(r.id)} assign={mayAssign} />
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
