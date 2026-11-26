import Link from "next/link";
import React from "react";
import { listBoardRows, type BoardRow } from "@/server/tl/queries";
import { currentTerminal } from "@/server/tl/terminal";
import { getAlerts } from "@/server/tl/alerts";
import { currentWorkspaceId } from "@/server/tl/workspace";
import { checkAccess } from "@/server/tl/access";
import { topLevel, type Alert } from "@/lib/alerts";
import { Card, PageHead, RowLink } from "@/components/desk/ui";
import { AssignButton } from "@/components/desk/assign-modal";
import { SendButton } from "@/components/desk/send-button";
import { AnswerForDriver, RetryDelivery } from "@/components/desk/answer-for-driver";
import { RecallForm } from "@/components/desk/recall-form";
import { DiscrepancyForm, ReceiveForm } from "@/components/desk/relay-forms";
import { EmptyState } from "@/components/desk/kit/states";
import { dockTime, miles, shortDate, stopTime, usd } from "@/lib/desk-format";
import { ageWords } from "@/lib/telematics";
import { recalledLoads, type RecalledLoad } from "@/server/tl/assignment-events";
import { RECALL_LABELS, recallDeliveryText } from "@/lib/recall-reasons";
import { openHandoffs, receiveOptions, type OpenHandoff } from "@/server/tl/relay";
import { HANDOFF_STATE_LABEL, OUTGOING_NEXT_LABEL, handoffLevel, waitWords, type HandoffState, type OutgoingNext } from "@/lib/relay";
import { NEEDS_ORDER, QUEUE_CHIP, queueColumnOf, type QueueColumn } from "@/lib/dispatch-queue";
import { recallAction, receiveRelayAction, discrepancyRelayAction } from "@/app/(desk)/actions";
import { rateConTotal } from "@/lib/pay";
import { LiveRefresh } from "@/components/desk/live-refresh";
import { linkStall } from "@/server/bridge/health";
import { num } from "@/server/tl/convert";

export const metadata = { title: "Dispatch queue · TrueLane" };

/**
 * One signal per load: the most serious thing the alert rules say about it, else the verdict when it is not a plain "covers your cost", else
 * nothing. A load that is fine does not need a word.
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

const minutesSince = (d: Date | null | undefined, now: number) => (d ? Math.max(0, (now - d.getTime()) / 60_000) : 0);

/** The state of a row, as a dot and a word (never a coloured edge): which of Needs a driver it is, or where a sent offer is. */
function Chip({ col, r, now }: { col: QueueColumn; r: BoardRow; now: number }) {
  if (col === "sent") {
    const a = r.assignment;
    const age = ageWords(minutesSince(a?.dispatchedAt, now));
    if (!r.driverLinked) return <span className="tl-chip warn">No app · sent {age} ago</span>;
    if (a?.bridgeError) return <span className="tl-chip warn">Not on the phone yet · {age}</span>;
    if (a?.bridgeSyncedAt) return <span className="tl-chip">On the phone · {age}</span>;
    return <span className="tl-chip">Going to the phone · {age}</span>;
  }
  if (col === "declined") return <span className="tl-chip warn">{QUEUE_CHIP.declined}{r.driverName ? ` by ${r.driverName}` : ""}</span>;
  if (col === "ready_to_send") return <span className="tl-chip">{QUEUE_CHIP.ready_to_send}{r.driverName ? ` · ${r.driverName}` : ""}</span>;
  if (col === "no_driver") return <span className="tl-chip">{QUEUE_CHIP.no_driver}</span>;
  return null;
}

/** What the freight is, in one line: the customer, the equipment and weight, and how many stops when it is more than a pickup and a delivery. */
function What({ r }: { r: BoardRow }) {
  const parts = [r.brokerName, r.equipment ? r.equipment.replace(/_/g, " ") : null, r.weightLbs ? `${r.weightLbs.toLocaleString("en-US")} lb` : null, r.stopCount > 2 ? `${r.stopCount} stops` : null].filter(Boolean);
  return parts.length > 0 ? <div className="tl-sub cut">{parts.join(" · ")}</div> : null;
}

/** One load in a column: which and for how much, where and when, what it is, the one thing to know, and the next step. The load number opens it; the buttons act without opening it. */
function Row({ r, col, alerts, may, recall, now }: { r: BoardRow; col: QueueColumn; alerts: Alert[] | undefined; may: boolean; recall?: RecalledLoad; now: number }) {
  const label = r.loadNumber ?? "This load";
  const onRoad = r.status === "in_progress";
  return (
    <li className="dq-row row-open">
      <div className="dq-top">
        <span>
          <RowLink href={`/loads/${r.id}`}>{r.loadNumber ?? "Load"}</RowLink> <span className="dq-rate">{usd(r.grossRevenue)}</span>
        </span>
        {onRoad && r.deliveryAt ? (
          <span className="tl-sub" title={stopTime(r.deliveryAt, r.deliveryZone)}>Delivers {dockTime(r.deliveryAt, r.deliveryZone)}</span>
        ) : (
          <span className="tl-sub" title={r.pickupAt ? stopTime(r.pickupAt, r.pickupZone) : undefined}>{r.pickupAt ? dockTime(r.pickupAt, r.pickupZone) : shortDate(r.scheduledDate)}</span>
        )}
      </div>
      <div className="dq-lane">
        <span className="cut">
          {r.origin} → {r.destination} · {miles(r.totalMiles)}
        </span>
        {r.driverName && col !== "declined" && col !== "ready_to_send" ? <span>{r.driverName}</span> : null}
      </div>
      <What r={r} />
      {recall ? (
        <div className="tl-sub">
          <span className="dq-sig warn">Recalled{recall.code ? ` · ${RECALL_LABELS[recall.code]}` : ""}{recall.driverName ? ` · was ${recall.driverName}` : ""}</span>
          <div>{recallDeliveryText(recall.delivery)}</div>
          {recall.note ? <div>“{recall.note}”</div> : null}
        </div>
      ) : null}
      {col === "declined" && r.assignment?.declineNote ? <div className="tl-sub">“{r.assignment.declineNote}”{r.assignment.respondedAt ? ` · ${ageWords(minutesSince(r.assignment.respondedAt, now))} ago` : ""}</div> : null}
      <div className="dq-foot">
        <span className="dq-who">
          <Chip col={col} r={r} now={now} />
          <Signal r={r} alerts={alerts} />
        </span>
        {may ? <RowActions r={r} col={col} label={label} /> : <span className="row-go" aria-hidden="true">›</span>}
      </div>
    </li>
  );
}

/** The next step for the row, done in place. Only for someone who may dispatch; the server refuses everyone else anyway. */
function RowActions({ r, col, label }: { r: BoardRow; col: QueueColumn; label: string }) {
  if (col === "no_driver") return <AssignButton loadId={r.id} loadNumber={label} />;
  if (col === "declined") return <AssignButton loadId={r.id} loadNumber={label} label="Pick another" />;
  if (col === "ready_to_send")
    return (
      <span className="dq-acts">
        <AssignButton loadId={r.id} loadNumber={label} label="Change" />
        <SendButton loadId={r.id} loadNumber={label} />
      </span>
    );
  if (col === "sent")
    return (
      <span className="dq-acts">
        {!r.driverLinked ? <AnswerForDriver loadId={r.id} loadNumber={label} driverName={r.driverName ?? "the driver"} /> : r.assignment?.bridgeError ? <RetryDelivery loadId={r.id} loadNumber={label} /> : null}
        <AssignButton loadId={r.id} loadNumber={label} label="Change driver" />
      </span>
    );
  // Accepted and not yet picked up: the driver can still be changed (a reason is asked) or recalled (a no-show, a breakdown). On the road it is a handoff, from the load.
  if (col === "moving" && r.status === "accepted" && r.driverName)
    return (
      <span className="dq-acts">
        <AssignButton loadId={r.id} loadNumber={label} label="Change driver" />
        <RecallForm action={recallAction} loadId={r.id} driverName={r.driverName} loadNumber={label} accepted />
      </span>
    );
  return <span className="row-go" aria-hidden="true">›</span>;
}

/** A load a driver dropped at a relay point, waiting in the yard for its next driver: handed over from here, with the same form as on the load. */
async function HandoffRow({ h, may }: { h: OpenHandoff; may: boolean }) {
  const level = handoffLevel(h, new Date());
  const options = may ? await receiveOptions(h.load.id) : null;
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
        {options ? (
          <span className="dq-acts">
            {h.state === "dropped" ? <DiscrepancyForm action={discrepancyRelayAction} loadId={h.load.id} handoffId={h.id} location={h.locationName ?? "the handoff"} /> : null}
            <ReceiveForm
              action={receiveRelayAction}
              loadId={h.load.id}
              handoff={{ id: h.id, type: h.type, locationName: h.locationName, tractorOutId: h.tractorOutId, tractorOutName: h.tractorOutName, sealNumber: h.sealNumber }}
              drivers={options.drivers}
              trucks={options.trucks}
              rateConTotal={rateConTotal(num(h.load.quotedRevenue), num(h.load.fuelSurcharge))}
              blockedByDiscrepancy={h.state === "disputed"}
            />
          </span>
        ) : null}
      </div>
    </li>
  );
}

const time = (d: Date | null | undefined) => d?.getTime() ?? Infinity;
/** Soonest first, by the time the row shows: the first stop's window for a load still to be picked up, the last stop's for one on the road. */
const bySoonest = (a: BoardRow, b: BoardRow) => time(a.pickupAt ?? a.scheduledDate) - time(b.pickupAt ?? b.scheduledDate);
const byMoving = (a: BoardRow, b: BoardRow) => time(a.status === "in_progress" ? a.deliveryAt : (a.pickupAt ?? a.scheduledDate)) - time(b.status === "in_progress" ? b.deliveryAt : (b.pickupAt ?? b.scheduledDate));

/** Loads shown in each column at a time; a big fleet has hundreds waiting. "Show more" adds this many (the soonest are first, so what matters is on top). */
const COLUMN_STEP = 30;

export default async function DispatchPage({ searchParams }: { searchParams?: { needs?: string; sent?: string; road?: string } }) {
  const ws = currentWorkspaceId();
  const terminal = await currentTerminal();
  const [rows, { alerts, byLoad }, dispatchAccess, quoteAccess, waiting, stall] = await Promise.all([listBoardRows(ws, "open", terminal), getAlerts(new Date(), ws, "shell", undefined, terminal), checkAccess("dispatch"), checkAccess("quote"), openHandoffs(ws, terminal), linkStall(ws)]);
  const now = Date.now();
  // A viewer, a driver manager or the accounting office reads this page; the buttons that change a driver are only for someone the server would let do it.
  const mayAssign = dispatchAccess.ok;
  const inYard = new Set(waiting.map((h) => h.loadId));
  const placed = rows.map((r) => ({ r, col: queueColumnOf(r, inYard.has(r.id)) }));
  const needsAll = placed.filter((p) => p.col === "no_driver" || p.col === "ready_to_send" || p.col === "declined");
  // A load whose last move was a recall is pinned first: someone was taken off it, and it should not sit quietly among the rest. Then a driver's no, then nobody, then ready to go.
  const recalls = await recalledLoads(
    needsAll.map((p) => p.r.id),
    ws
  );
  const needs = needsAll.sort((x, y) => Number(recalls.has(y.r.id)) - Number(recalls.has(x.r.id)) || (NEEDS_ORDER[x.col!] ?? 9) - (NEEDS_ORDER[y.col!] ?? 9) || bySoonest(x.r, y.r));
  const sent = placed.filter((p) => p.col === "sent").sort((x, y) => bySoonest(x.r, y.r));
  const road = placed.filter((p) => p.col === "moving").sort((x, y) => byMoving(x.r, y.r));
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
  const counts = { declined: needs.filter((p) => p.col === "declined").length, ready: needs.filter((p) => p.col === "ready_to_send").length };

  return (
    <>
      <LiveRefresh pull={mayAssign} />
      <PageHead title="Dispatch queue" sub="What needs a driver, what is waiting on an answer, and what is moving. Soonest first.">
        {quoteAccess.ok ? <Link href="/quote" className="tl-btn ghost">Price an offer</Link> : null}
      </PageHead>

      {stall && mayAssign ? (
        <p className="dq-strip" data-level="block" role="alert">
          <b>The driver link has not run for {ageWords(stall.minutes)}</b>
          <span>Offers wait to reach the drivers&apos; phones and their answers wait to come back. This page looks on the link itself while it is open; the schedule that calls the link is not running.</span>
        </p>
      ) : null}

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
        <Card title={`Needs a driver · ${needs.length}${counts.declined + counts.ready > 0 ? ` (${[counts.declined ? `${counts.declined} declined` : null, counts.ready ? `${counts.ready} ready to send` : null].filter(Boolean).join(", ")})` : ""}`}>
          {needs.length === 0 ? (
            <EmptyState icon="check" title="Nothing waiting">Every load has a driver.</EmptyState>
          ) : (
            <ul className="dq">
              {needs.slice(0, limits.needs).map((p) => (
                <Row key={p.r.id} r={p.r} col={p.col!} alerts={byLoad.get(p.r.id)} may={mayAssign} recall={recalls.get(p.r.id)} now={now} />
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
              {sent.slice(0, limits.sent).map((p) => (
                <Row key={p.r.id} r={p.r} col="sent" alerts={byLoad.get(p.r.id)} may={mayAssign} now={now} />
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
              {road.slice(0, limits.road).map((p) => (
                <Row key={p.r.id} r={p.r} col="moving" alerts={byLoad.get(p.r.id)} may={mayAssign} now={now} />
              ))}
            </ul>
          )}
          <More column="road" total={road.length} />
        </Card>
      </div>
    </>
  );
}
