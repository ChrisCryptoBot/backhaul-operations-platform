import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getLoadDetail } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { listLoadAudit } from "@/server/tl/audit";
import { num } from "@/server/tl/convert";
import { detentionOfLoad } from "@/server/tl/detention";
import { getThresholds } from "@/server/tl/thresholds";
import { settlementOfLoad } from "@/server/tl/settlement";
import { AssignFields } from "./assign-fields";
import { assignAction, respondAction, sendAction, unassignAction, undoPaidAction } from "@/app/(desk)/actions";
import { InvoiceDialog, LoadEditDialog, PaidDialog, TripEntry } from "./load-actions";
import { defaultInvoiceNumber, invoiceReadiness } from "@/lib/invoicing";
import { toEditValues } from "@/lib/load-edit";
import { DeleteLoadButton } from "./delete-load";
import { deriveTimeline } from "@/lib/desk-timeline";
import { CAN_CANCEL, CAN_RESCHEDULE, CAN_TONU, reasonLabel } from "@/lib/disruptions";
import { toCentralLocal } from "@/lib/zoned";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { AssignmentChip, PageHead, StatusChip, VerdictChip } from "./ui";
import { AlertList } from "./alert-bits";
import { DrawerFrame } from "./drawer-frame";
import { ConfirmForm } from "./kit/confirm-form";
import { DisruptionButtons } from "./disruption-dialogs";
import { Icon } from "./kit/icons";
import { dateTime, miles, PAY_KIND_LABEL, payLabel, perMile, signedPct, usd } from "@/lib/desk-format";
import { rateConTotal } from "@/lib/pay";

const TONE: Record<string, "ok" | "warn" | "bad"> = { accept: "ok", caution: "warn", reject: "bad" };

/**
 * One load, in full: what it pays against the truck's own cost, where it is in its life, who has it, what the driver
 * sees, and what has been done to it. Rendered in the side drawer over the board, and as a page when opened directly.
 */
export async function LoadView({ id, variant }: { id: string; variant: "drawer" | "page" }) {
  const detail = await getLoadDetail(id);
  if (!detail) notFound();
  const [{ byLoad }, feed, settled] = await Promise.all([getAlerts(), listLoadAudit(id), settlementOfLoad(id)]);
  const { load, evaluation, flipped, driverView, drivers, trucks } = detail;
  const a = load.assignment;
  const alerts = byLoad.get(id) ?? [];

  const canAssign = (load.status === "draft" || load.status === "accepted") && (!a || a.status === "draft" || a.status === "declined");
  const canUnassign = !!a && ["draft", "accepted"].includes(load.status) && ["draft", "dispatched", "accepted", "declined"].includes(a.status);
  const wayHome = load.isBackhaul ? "A load covers the way home" : "Way home counted empty";
  const otherWayHome = load.isBackhaul ? "Way home counted empty" : "A load covers the way home";

  const totalMiles = evaluation?.totalMiles ?? 0;
  const allIn = evaluation && totalMiles > 0 ? evaluation.effectiveGross / totalMiles : null;
  const loadedMiles = num(load.loadedMiles);
  const perLoaded = evaluation && loadedMiles > 0 ? evaluation.effectiveGross / loadedMiles : null;
  const tone = evaluation ? TONE[evaluation.finalDecision] ?? "" : "";
  const arrived = load.stops.map((s) => s.arrivedAt).filter((d): d is Date => d != null).sort((x, y) => x.getTime() - y.getTime())[0] ?? null;

  const thresholds = await getThresholds();
  const dt = detentionOfLoad(load, thresholds.detentionGraceMinutes);
  const fellThrough = load.status === "cancelled" || load.status === "tonu";
  const firstPickup = load.stops.map((s) => s.timeWindowEarliest).find((d): d is Date => d != null) ?? null;
  // A load on the road, invoiced or on a statement is real; everything else can be taken off the desk if it was a slip.
  const deleteBlocked = load.status === "in_progress" ? "A load on the road cannot be deleted." : load.paymentStatus ? "An invoiced load cannot be deleted." : settled ? "A load on a driver statement cannot be deleted." : null;
  const can = { cancel: CAN_CANCEL.includes(load.status), tonu: CAN_TONU.includes(load.status), reschedule: CAN_RESCHEDULE.includes(load.status) && firstPickup != null };

  // Editing, trip entry and billing. A load that has started keeps its stops where they are; the rest can still be corrected.
  const scheduleLocked = !["draft", "accepted"].includes(load.status);
  const stored = (v: Parameters<typeof num>[0]) => {
    const n = num(v);
    return n > 0 ? String(n) : "";
  };
  const tripStops = load.stops.map((s) => ({
    id: s.id,
    sequence: s.stopSequence,
    role: s.stopRole ?? s.stopType,
    place: s.facilityName ?? s.addressString,
    arrivedLocal: s.arrivedAt ? toCentralLocal(s.arrivedAt.getTime()) : "",
    waitMinutes: s.waitMinutes != null ? String(s.waitMinutes) : "",
    seal: s.sealNumber ?? ""
  }));
  const tripVisible = !!a && ["accepted", "in_progress", "completed"].includes(load.status);
  const readiness = invoiceReadiness({ ...load, quotedRevenue: num(load.quotedRevenue) });
  const invoiceContext = { rate: num(load.quotedRevenue), surcharge: num(load.fuelSurcharge), detention: dt.billable, defaultTerms: load.payTermsDays ?? thresholds.defaultPayTermsDays };
  const billed = num(load.invoicedAmount ?? load.quotedRevenue);
  const invoiceLines = Array.isArray(load.invoiceLines) ? (load.invoiceLines as Array<{ label: string; amount: number }>) : null;
  const dueAt = load.invoicedAt ? new Date(load.invoicedAt.getTime() + (load.payTermsDays ?? 0) * 86_400_000) : null;
  const paidAmount = load.paidAmount != null ? num(load.paidAmount) : null;
  const needs = [load.requiresLiftgate ? "liftgate" : null, load.requiresRamp ? "ramp" : null, load.requiresPalletJack ? "pallet jack" : null].filter((x): x is string => x != null);
  const size = [load.lengthFt, load.widthFt].every((x) => x == null) && load.loadHeightIn == null ? null : [load.lengthFt != null ? `${num(load.lengthFt)} ft long` : null, load.widthFt != null ? `${num(load.widthFt)} ft wide` : null, load.loadHeightIn != null ? `${num(load.loadHeightIn)} in high` : null].filter(Boolean).join(", ");

  const steps = deriveTimeline({
    status: load.status,
    createdAt: load.createdAt,
    completedAt: load.completedAt,
    invoicedAt: load.invoicedAt,
    paidAt: load.paidAt,
    paymentStatus: load.paymentStatus,
    firstArrivedAt: arrived,
    assignment: a ? { status: a.status, createdAt: a.createdAt, dispatchedAt: a.dispatchedAt, respondedAt: a.respondedAt } : null
  });

  const bar = (value: number | null, floor: number | null, max: number, verdict: string | undefined) => (
    <div className="mb-track">
      {value != null ? <div className={`mb-fill ${TONE[verdict ?? ""] ?? ""}`} style={{ width: `${Math.min(100, (value / max) * 100)}%` }} /> : null}
      {floor != null ? <div className="mb-floor" style={{ left: `${Math.min(100, (floor / max) * 100)}%` }} title={`Floor ${perMile(floor)}`} /> : null}
    </div>
  );
  const flippedAllIn = flipped && flipped.totalMiles > 0 ? flipped.effectiveGross / flipped.totalMiles : null;
  const barMax = Math.max(allIn ?? 0, flippedAllIn ?? 0, evaluation?.verdictFloorRpm ?? 0, flipped?.verdictFloorRpm ?? 0, 0.01) * 1.15;

  const body = (
    <>
      {alerts.length > 0 ? (
        <section className="sec">
          <h3>Needs attention · {alerts.length}</h3>
          <AlertList alerts={alerts} />
        </section>
      ) : null}

      {fellThrough ? (
        <section className="sec">
          <h3>{load.status === "tonu" ? "TONU" : "Cancelled"}</h3>
          <div className="sec-box">
            <b>{reasonLabel(load.cancelReason)}</b>
            {load.cancelledAt ? <span className="tl-sub"> · {dateTime(load.cancelledAt)}</span> : null}
            {load.status === "tonu" ? <div className="tl-note" style={{ marginTop: 4 }}>Fee earned: {usd(num(load.tonuRevenue), 2)}.</div> : <div className="tl-note" style={{ marginTop: 4 }}>This load is no longer on the board.</div>}
          </div>
        </section>
      ) : null}

      <section className="sec">
        <h3>What it pays</h3>
        <div className="trio">
          <div>
            <div className="v">{perMile(perLoaded)}</div>
            <div className="l">Per loaded mile</div>
            <div className="s">on {miles(loadedMiles)}</div>
          </div>
          <div>
            <div className={`v ${tone}`}>{perMile(allIn)}</div>
            <div className="l">Per mile, every mile</div>
            <div className="s">on {miles(totalMiles)} · {wayHome.toLowerCase()}</div>
          </div>
          <div>
            <div className="v">{perMile(evaluation?.verdictFloorRpm)}</div>
            <div className="l">Your floor</div>
            <div className="s">{load.vehicle ? `${load.vehicle.name}, ${load.vehicle.type?.replace("_", " ")}` : "No truck"}</div>
          </div>
        </div>
        {detail.labourNote ? <p className="tl-note" style={{ marginTop: 10 }}>{detail.labourNote}</p> : null}
      </section>

      {fellThrough ? null : (
      <section className="sec">
        <h3>Where it is</h3>
        <div className="sec-box">
          <ol className="tlv" aria-label="Progress">
            {steps.map((s) => (
              <li key={s.key} data-state={s.state} aria-current={s.state === "current" ? "step" : undefined}>
                <span className="dot">{s.state === "done" ? <Icon name="check" size={11} /> : null}</span>
                <div>
                  <div className="lbl">{s.label}</div>
                  {s.note ? <div className="note">{s.note}</div> : null}
                </div>
                <span className="at">{s.at ? dateTime(s.at) : s.state === "current" ? "Next" : ""}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>
      )}

      {evaluation && flipped ? (
        <section className="sec">
          <h3>Count every mile</h3>
          <div className="sec-box">
            <div className="mb">
              <div className="mb-row">
                <span>{wayHome}</span>
                {bar(allIn, evaluation.verdictFloorRpm, barMax, evaluation.finalDecision)}
                <b>{perMile(allIn)}</b>
              </div>
              <div className="mb-row">
                <span>{otherWayHome}</span>
                {bar(flippedAllIn, flipped.verdictFloorRpm, barMax, flipped.finalDecision)}
                <b>{perMile(flippedAllIn)}</b>
              </div>
              <div className="mb-key">
                <i /> your floor on that many miles
              </div>
            </div>
            <p className="tl-note" style={{ marginTop: 10 }}>
              Same offer, different miles: {miles(evaluation.totalMiles)} against {miles(flipped.totalMiles)}. One number, and it says which miles it is per.
              {evaluation.marketVariancePct != null ? ` Against the market rate on this load: ${signedPct(evaluation.marketVariancePct)}.` : ""}
            </p>
          </div>
        </section>
      ) : null}

      <section className="sec">
        <h3>Driver</h3>
        <div className="sec-box">
          {a ? (
            <dl className="tl-kv" style={{ marginBottom: 12 }}>
              <dt>Driver</dt>
              <dd>{a.driver.name}</dd>
              <dt>Pay</dt>
              <dd>{PAY_KIND_LABEL[a.payKind] ?? a.payKind} · {payLabel(a.payKind, num(a.payRate))}</dd>
              <dt>Estimate (display only)</dt>
              <dd>{usd(a.payEstimate == null ? null : num(a.payEstimate), 2)}</dd>
              <dt>Status</dt>
              <dd><AssignmentChip status={a.status} /></dd>
              {settled ? (
                <>
                  <dt>Paid to the driver</dt>
                  <dd>
                    On statement <Link href={`/settlements/${settled.id}`}>{settled.number}</Link>
                  </dd>
                </>
              ) : null}
            </dl>
          ) : (
            <p className="tl-note" style={{ marginBottom: 12 }}>No driver yet.</p>
          )}

          {canAssign ? (
            <form action={assignAction} className="tl-form-row" style={{ marginBottom: canUnassign ? 10 : 0 }}>
              <input type="hidden" name="loadId" value={load.id} />
              <AssignFields drivers={drivers} initial={{ driverId: a?.driverId ?? null, payKind: a?.payKind ?? null, rate: a ? num(a.payRate) : null }} rateConTotal={rateConTotal(num(load.quotedRevenue), num(load.fuelSurcharge))} />
              {drivers.some((d) => d.busy) ? (
                <label className="tl-field" style={{ flexBasis: "100%" }}>
                  Reason, only for a driver who is already on another load at the same time
                  <input name="overrideReason" type="text" placeholder="For example: team run" />
                </label>
              ) : null}
              <button type="submit" className="tl-btn sm">{a ? "Change driver or pay" : "Assign driver"}</button>
            </form>
          ) : null}

          {canUnassign && a ? (
            <ConfirmForm
              action={unassignAction}
              fields={{ loadId: load.id }}
              label="Remove driver"
              title={`Take ${a.driver.name} off ${load.loadNumber ?? "this load"}?`}
              eyebrow="Unassign"
              confirmLabel="Remove driver"
              destructive
              askReason={a.status === "dispatched" || a.status === "accepted"}>
              <p className="tl-note">
                {a.status === "dispatched" || a.status === "accepted"
                  ? "The load was already sent. The driver will not have it any more, and the reason is kept in the audit trail."
                  : "The load goes back to the board without a driver."}
              </p>
            </ConfirmForm>
          ) : null}
        </div>
      </section>

      <section className="sec">
        <h3>Delete</h3>
        <div className="sec-box">
          <DeleteLoadButton loadId={load.id} loadNumber={load.loadNumber ?? "This load"} driverName={a?.driver.name ?? null} blocked={deleteBlocked} />
        </div>
      </section>

      {can.cancel || can.tonu || can.reschedule ? (
        <section className="sec">
          <h3>Change of plans</h3>
          <div className="sec-box">
            <DisruptionButtons
              loadId={load.id}
              loadNumber={load.loadNumber ?? "This load"}
              can={can}
              pickupLocal={firstPickup ? toCentralLocal(firstPickup.getTime()) : null}
              driverName={a?.driver.name ?? null}
              reconfirm={!!a && (a.status === "dispatched" || a.status === "accepted")}
            />
          </div>
        </section>
      ) : null}

      {tripVisible ? (
        <section className="sec">
          <h3>Trip</h3>
          <div className="sec-box">
            <TripEntry
              loadId={load.id}
              status={load.status}
              assignmentStatus={a?.status ?? null}
              driverName={a?.driver.name ?? null}
              stops={tripStops}
              expenses={{ fuel: stored(load.expenseFuelActual), tolls: stored(load.expenseTolls), misc: stored(load.expenseMisc) }}
              delivered={load.completedAt ? toCentralLocal(load.completedAt.getTime()) : ""}
              pod={{ note: load.podNote ?? "", without: load.closedWithoutPod === true }}
            />
          </div>
        </section>
      ) : null}

      <section className="sec">
        <h3>Stops</h3>
        <div className="sec-box">
          {fellThrough ? null : (
            <div style={{ marginBottom: 10 }}>
              <LoadEditDialog loadId={load.id} loadNumber={load.loadNumber ?? "This load"} initial={toEditValues(load)} scheduleLocked={scheduleLocked} driverName={a && ["dispatched", "accepted"].includes(a.status) ? a.driver.name : null} trucks={trucks} dealLocked={load.paymentStatus ? "This load has been invoiced, so its truck, rate and miles are what was billed and stay as they are." : settled ? "This load is on a driver statement, so its truck, rate and miles are what the driver was paid on and stay as they are." : null} />
            </div>
          )}
          <table className="tl-table">
            <tbody>
              {load.stops.map((s) => (
                <tr key={s.id}>
                  <td style={{ width: 24 }}>{s.stopSequence}</td>
                  <td>
                    <b style={{ textTransform: "capitalize" }}>{s.stopRole ?? s.stopType}</b> · {s.facilityName ?? s.addressString}
                    <div className="tl-sub">{s.addressString}</div>
                    {s.stopNotes ? <div className="tl-sub">{s.stopNotes}</div> : null}
                  </td>
                  <td className="num">
                    <div>{dateTime(s.timeWindowEarliest)}</div>
                    <div className="tl-sub">{Array.isArray(s.referenceNumbers) && (s.referenceNumbers as string[]).length > 0 ? (s.referenceNumbers as string[]).join(", ") : "no reference number"}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="tl-kv" style={{ marginTop: 10 }}>
            <dt>Miles (empty to pickup · loaded · empty home)</dt>
            <dd>{num(load.pickupDeadheadMiles)} · {loadedMiles} · {load.isBackhaul ? 0 : num(load.returnDeadheadMiles)}</dd>
            <dt>PO</dt>
            <dd>{load.poNumber ?? "—"}</dd>
            <dt>Terms</dt>
            <dd>{load.channel ?? "dispatch"} · {load.payTermsDays != null ? `Net ${load.payTermsDays}` : load.paymentTerms ?? "terms not set"}</dd>
            <dt>Broker</dt>
            <dd>
              {load.brokerName ?? "—"}
              {load.brokerMcNumber ? ` · MC ${load.brokerMcNumber}` : ""}
              {load.brokerPhone || load.brokerEmail ? <div className="tl-sub">{[load.brokerPhone, load.brokerEmail].filter(Boolean).join(" · ")}</div> : null}
            </dd>
            <dt>Freight</dt>
            <dd>
              {load.trailerType ? load.trailerType.replace(/_/g, " ") : "Trailer not stated"}
              {load.weightLbs != null ? ` · ${load.weightLbs.toLocaleString("en-US")} lb` : ""}
              {load.hazmatClass ? ` · hazmat ${load.hazmatClass}` : ""}
              {size ? <div className="tl-sub">{size}</div> : null}
              {needs.length > 0 ? <div className="tl-sub">Needs a {needs.join(", ")}</div> : null}
            </dd>
            {load.notes ? (
              <>
                <dt>Notes</dt>
                <dd>{load.notes}</dd>
              </>
            ) : null}
          </dl>
        </div>
      </section>

      {load.paymentStatus && load.invoicedAt ? (
        <section className="sec">
          <h3>Invoice</h3>
          <div className="sec-box">
            <dl className="tl-kv" style={{ marginBottom: 10 }}>
              <dt>Number</dt>
              <dd>{load.invoiceNumber ?? "—"} · Net {load.payTermsDays ?? 0}</dd>
              <dt>Sent</dt>
              <dd>{dateTime(load.invoicedAt)}</dd>
              <dt>Due</dt>
              <dd>{dueAt ? dateTime(dueAt) : "—"}</dd>
              <dt>Status</dt>
              <dd>
                {load.paymentStatus === "paid"
                  ? `Paid ${load.paidAt ? dateTime(load.paidAt) : ""} · ${usd(paidAmount, 2)}${paidAmount != null && paidAmount < billed ? `, ${usd(billed - paidAmount, 2)} short` : paidAmount != null && paidAmount > billed ? `, ${usd(paidAmount - billed, 2)} over` : ""}`
                  : "Out and waiting"}
              </dd>
            </dl>
            <table className="tl-table">
              <tbody>
                {(invoiceLines ?? [{ label: "Line haul and fuel surcharge", amount: billed }]).map((l) => (
                  <tr key={l.label}>
                    <td>{l.label}</td>
                    <td className="num">{usd(l.amount, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td><b>Total due</b></td>
                  <td className="num"><b>{usd(billed, 2)}</b></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {load.stops.some((s) => s.waitMinutes != null) && (dt.totalWaitMinutes > 0 || dt.noRate) ? (
        <section className="sec">
          <h3>Waiting at the docks</h3>
          <div className="sec-box">
            {dt.stops.length > 0 ? (
              <table className="tl-table">
                <thead>
                  <tr>
                    <th>Stop</th>
                    <th className="num">Waited</th>
                    <th className="num">Free</th>
                    <th className="num">Billable</th>
                  </tr>
                </thead>
                <tbody>
                  {dt.stops.map((st) => (
                    <tr key={st.stopSequence}>
                      <td style={{ textTransform: "capitalize" }}>{st.stopType}</td>
                      <td className="num">{st.waitMinutes} min</td>
                      <td className="num">{dt.graceMinutes} min</td>
                      <td className="num">{st.billableAmount > 0 ? usd(st.billableAmount, 2) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
            <p className="tl-note" style={{ marginTop: dt.stops.length > 0 ? 10 : 0 }}>
              {dt.noRate
                ? "This truck has no detention rate on its cost profile, so nothing can be billed. Add one on its page under Trucks."
                : dt.billable > 0
                  ? `${usd(dt.billable, 2)} is billable at ${usd(dt.rate)} an hour past ${dt.graceMinutes} minutes free at each stop.${dt.billedExtra > 0 ? ` ${usd(dt.billedExtra, 2)} is already on the invoice.` : load.paymentStatus ? " The invoice does not include it." : load.status === "completed" ? " It is added to the invoice when you create it." : ""}`
                  : "Every wait was inside the free time."}
            </p>
          </div>
        </section>
      ) : null}

      {driverView ? (
        <section className="sec">
          <h3>What the driver sees</h3>
          <div className="sec-box">
            <p className="tl-note" style={{ marginBottom: 8 }}>Only where to go, when, the numbers the dock will ask for, and how they are paid. No rate, no gross, no cost, no rate confirmation.</p>
            <details>
              <summary className="tl-sub" style={{ cursor: "pointer" }}>Show the payload</summary>
              <pre style={{ margin: "8px 0 0", padding: 12, background: "var(--db-bg)", borderRadius: 8, overflowX: "auto", fontSize: 12, color: "var(--db-fg-mid)" }}>{JSON.stringify(driverView, null, 2)}</pre>
            </details>
          </div>
        </section>
      ) : null}

      <section className="sec">
        <h3>Activity · {feed.length}</h3>
        <div className="sec-box">
          {feed.length === 0 ? (
            <p className="tl-note">Nothing recorded on this load yet.</p>
          ) : (
            <ul className="feed">
              {feed.map((e) => (
                <li key={e.id}>
                  <div>
                    <b>{ACTION_LABEL[e.action] ?? e.action}</b> · {e.summary}
                  </div>
                  {e.reason ? <div className="r">“{e.reason}”</div> : null}
                  <div className="t">{dateTime(e.createdAt)} · {e.actor}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );

  const footer = (
    <>
      {a?.status === "draft" ? (
        <form action={sendAction}>
          <input type="hidden" name="loadId" value={load.id} />
          <button type="submit" className="tl-btn primary">Send to driver</button>
        </form>
      ) : null}
      {a?.status === "dispatched" ? (
        <details className="demo-controls">
          <summary>Demo controls</summary>
          <form action={respondAction}>
            <input type="hidden" name="loadId" value={load.id} />
            <span className="tl-sub">Waiting on {a.driver.name}. The driver&apos;s phone is not connected in this demo, so answer for them:</span>
            <button name="response" value="accepted" type="submit" className="tl-btn primary sm">Driver accepts</button>
            <button name="response" value="declined" type="submit" className="tl-btn sm">Driver declines</button>
          </form>
        </details>
      ) : null}
      {load.status === "completed" && !load.paymentStatus ? (
        <InvoiceDialog loadId={load.id} loadNumber={load.loadNumber ?? "This load"} defaults={{ number: defaultInvoiceNumber(load.loadNumber, load.id) }} context={invoiceContext} blockers={readiness.blockers} cautions={readiness.cautions} />
      ) : null}
      {load.paymentStatus ? (
        <Link href={`/invoices/${load.id}`} className="tl-btn">
          View invoice
        </Link>
      ) : null}
      {load.paymentStatus === "invoiced" ? <PaidDialog loadId={load.id} invoiceNumber={load.invoiceNumber} billed={billed} /> : null}
      {load.paymentStatus === "paid" ? (
        <ConfirmForm
          action={undoPaidAction}
          fields={{ loadId: load.id }}
          label="Undo payment"
          title={`Take back the payment on ${load.invoiceNumber ?? "this invoice"}?`}
          eyebrow="Payment"
          confirmLabel="Take it back"
          destructive
          askReason>
          <p className="tl-note">For a payment entered against the wrong invoice, or one that bounced. The invoice goes back to out and waiting, and the reason is kept in the audit trail.</p>
        </ConfirmForm>
      ) : null}
    </>
  );

  const chips = (
    <>
      <StatusChip status={load.status} />
      {fellThrough ? null : <VerdictChip verdict={evaluation?.finalDecision ?? null} />}
      {a ? <AssignmentChip status={a.status} /> : null}
    </>
  );
  const sub = `${load.brokerName ?? "No broker"} · ${usd(evaluation?.effectiveGross ?? num(load.quotedRevenue))} all-in · ${load.originAddress} → ${load.destinationAddress}`;

  if (variant === "drawer") {
    return (
      <DrawerFrame title={`Load ${load.loadNumber ?? ""}`} sub={sub} chips={chips} footer={footer} fullHref={`/loads/${load.id}`}>
        {body}
      </DrawerFrame>
    );
  }

  return (
    <>
      <PageHead title={`Load ${load.loadNumber ?? ""}`} sub={sub}>
        <Link href="/loads" className="tl-btn">All loads</Link>
      </PageHead>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>{chips}</div>
      <div className="dr-body" style={{ padding: 0, maxWidth: 760, overflow: "visible" }}>
        {body}
        <div className="dr-foot" style={{ border: "1px solid var(--db-border)", borderRadius: "var(--db-r-lg)" }}>{footer}</div>
      </div>
    </>
  );
}
