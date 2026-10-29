import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getLoadDetail } from "@/server/tl/queries";
import { getAlerts } from "@/server/tl/alerts";
import { listLoadAudit } from "@/server/tl/audit";
import { num } from "@/server/tl/convert";
import { assignAction, invoiceAction, markPaidAction, respondAction, sendAction, unassignAction } from "@/app/(desk)/actions";
import { deriveTimeline } from "@/lib/desk-timeline";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { AssignmentChip, PageHead, StatusChip, VerdictChip } from "./ui";
import { AlertList } from "./alert-bits";
import { DrawerFrame } from "./drawer-frame";
import { ConfirmForm } from "./kit/confirm-form";
import { Icon } from "./kit/icons";
import { dateTime, miles, PAY_KIND_LABEL, perMile, signedPct, usd } from "@/lib/desk-format";

const TONE: Record<string, "ok" | "warn" | "bad"> = { accept: "ok", caution: "warn", reject: "bad" };

/**
 * One load, in full: what it pays against the truck's own cost, where it is in its life, who has it, what the driver
 * sees, and what has been done to it. Rendered in the side drawer over the board, and as a page when opened directly.
 */
export async function LoadView({ id, variant }: { id: string; variant: "drawer" | "page" }) {
  const detail = await getLoadDetail(id);
  if (!detail) notFound();
  const [{ byLoad }, feed] = await Promise.all([getAlerts(), listLoadAudit(id)]);
  const { load, evaluation, flipped, driverView, drivers } = detail;
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
      </section>

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
              <dd>{PAY_KIND_LABEL[a.payKind] ?? a.payKind} · {a.payKind === "flat" ? usd(num(a.payRate)) : a.payKind === "cpm" ? `$${num(a.payRate).toFixed(2)}/mi` : `$${num(a.payRate).toFixed(2)}/hr`}</dd>
              <dt>Estimate (display only)</dt>
              <dd>{usd(a.payEstimate == null ? null : num(a.payEstimate), 2)}</dd>
              <dt>Status</dt>
              <dd><AssignmentChip status={a.status} /></dd>
            </dl>
          ) : (
            <p className="tl-note" style={{ marginBottom: 12 }}>No driver yet.</p>
          )}

          {canAssign ? (
            <form action={assignAction} className="tl-form-row" style={{ marginBottom: canUnassign ? 10 : 0 }}>
              <input type="hidden" name="loadId" value={load.id} />
              <label className="tl-field">
                Driver
                <select name="driverId" defaultValue={a?.driverId} required>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id} disabled={!!d.blocker}>
                      {d.name}
                      {d.blocker ? ` — ${d.blocker}` : d.busy ? ` — ${d.busy}` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tl-field">
                Pay
                <select name="payKind" defaultValue={a?.payKind ?? "cpm"}>
                  <option value="cpm">Per mile</option>
                  <option value="flat">Flat</option>
                  <option value="hourly">Hourly</option>
                </select>
              </label>
              <label className="tl-field">
                Rate
                <input name="rate" type="number" step="0.01" min="0.01" defaultValue={a ? num(a.payRate) : 0.65} required style={{ width: 90 }} />
              </label>
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
        <h3>Stops</h3>
        <div className="sec-box">
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
            <dd>{load.channel ?? "dispatch"} · {load.paymentTerms ?? "terms not set"}</dd>
          </dl>
        </div>
      </section>

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
        <form action={respondAction}>
          <input type="hidden" name="loadId" value={load.id} />
          <span className="tl-sub">Waiting on {a.driver.name}. Play the driver:</span>
          <button name="response" value="accepted" type="submit" className="tl-btn primary sm">Driver accepts</button>
          <button name="response" value="declined" type="submit" className="tl-btn sm">Driver declines</button>
        </form>
      ) : null}
      {load.status === "completed" && !load.paymentStatus ? (
        <form action={invoiceAction}>
          <input type="hidden" name="loadId" value={load.id} />
          <button type="submit" className="tl-btn primary">Create invoice</button>
        </form>
      ) : null}
      {load.paymentStatus === "invoiced" ? (
        <form action={markPaidAction}>
          <input type="hidden" name="loadId" value={load.id} />
          <button type="submit" className="tl-btn primary">Mark paid</button>
        </form>
      ) : null}
    </>
  );

  const chips = (
    <>
      <StatusChip status={load.status} />
      <VerdictChip verdict={evaluation?.finalDecision ?? null} />
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
