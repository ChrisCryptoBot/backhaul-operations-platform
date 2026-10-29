import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getLoadDetail } from "@/server/tl/queries";
import { num } from "@/server/tl/convert";
import { assignAction, respondAction, sendAction } from "../../actions";
import { AssignmentChip, Card, PageHead, Stat, StatusChip, VerdictChip } from "@/components/desk/ui";
import { dateTime, miles, PAY_KIND_LABEL, perMile, signedPct, usd } from "@/lib/desk-format";

export default async function LoadDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { note?: string; error?: string } }) {
  const detail = await getLoadDetail(params.id);
  if (!detail) notFound();
  const { load, evaluation, flipped, driverView, drivers } = detail;
  const a = load.assignment;
  const canAssign = (load.status === "draft" || load.status === "accepted") && (!a || a.status === "draft" || a.status === "declined");
  const wayHome = load.isBackhaul ? "A load covers the way home" : "Way home counted empty";

  return (
    <>
      <PageHead title={`Load ${load.loadNumber ?? ""}`} sub={`${load.brokerName ?? "No broker"} · ${load.originAddress} → ${load.destinationAddress}`}>
        <Link href="/loads" className="tl-btn">All loads</Link>
      </PageHead>

      {searchParams?.note ? <p className="tl-note" role="status" style={{ color: "var(--db-pos)" }}>{searchParams.note}</p> : null}
      {searchParams?.error ? <p className="tl-note warn" role="alert">{searchParams.error}</p> : null}

      <div className="tl-grid cols-4" style={{ marginBottom: 14 }}>
        <Stat label="Pay (all-in)" value={usd(evaluation?.effectiveGross ?? num(load.quotedRevenue))} sub={`${load.channel ?? "dispatch"} · ${load.paymentTerms ?? "terms not set"}`} />
        <Stat label="Pay per mile" value={perMile(evaluation && evaluation.totalMiles > 0 ? evaluation.effectiveGross / evaluation.totalMiles : null)} sub={`on ${miles(evaluation?.totalMiles)} · ${wayHome.toLowerCase()}`} />
        <Stat label="Your floor" value={perMile(evaluation?.verdictFloorRpm)} sub={load.vehicle ? `${load.vehicle.name}, ${load.vehicle.type}` : "No truck"} />
        <div className="tl-card tl-stat">
          <div className="v" style={{ fontSize: 17 }}><VerdictChip verdict={evaluation?.finalDecision ?? null} /></div>
          <div className="l" style={{ marginTop: 8 }}>Verdict</div>
          <div className="s"><StatusChip status={load.status} /></div>
        </div>
      </div>

      {evaluation && flipped ? (
        <Card title="Count every mile" className="tl-card">
          <div className="tl-grid cols-2">
            <div>
              <div className="tl-sub">{wayHome}</div>
              <div className="tl-stat"><div className="v">{perMile(evaluation.effectiveGross / evaluation.totalMiles)}</div></div>
              <div className="tl-note">on {miles(evaluation.totalMiles)} · <VerdictChip verdict={evaluation.finalDecision} /></div>
            </div>
            <div>
              <div className="tl-sub">{load.isBackhaul ? "Way home counted empty" : "If a load covers the way home"}</div>
              <div className="tl-stat"><div className="v">{perMile(flipped.effectiveGross / flipped.totalMiles)}</div></div>
              <div className="tl-note">on {miles(flipped.totalMiles)} · <VerdictChip verdict={flipped.finalDecision} /></div>
            </div>
          </div>
          <p className="tl-note" style={{ marginTop: 10 }}>
            Same offer, different miles. One number, and it says which miles it is per.
            {evaluation.marketVariancePct != null ? ` Against the market rate on this load: ${signedPct(evaluation.marketVariancePct)}.` : ""}
          </p>
        </Card>
      ) : null}

      <div className="tl-grid cols-2" style={{ marginTop: 14 }}>
        <Card title="Stops">
          <table className="tl-table">
            <tbody>
              {load.stops.map((s) => (
                <tr key={s.id}>
                  <td style={{ width: 28 }}>{s.stopSequence}</td>
                  <td>
                    <b style={{ textTransform: "capitalize" }}>{s.stopRole ?? s.stopType}</b> · {s.facilityName ?? s.addressString}
                    <div className="tl-sub">{s.addressString}</div>
                    {s.stopNotes ? <div className="tl-sub">{s.stopNotes}</div> : null}
                  </td>
                  <td className="num">
                    <div>{dateTime(s.timeWindowEarliest)}</div>
                    <div className="tl-sub">{Array.isArray(s.referenceNumbers) ? (s.referenceNumbers as string[]).join(", ") : ""}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <dl className="tl-kv" style={{ marginTop: 12 }}>
            <dt>Miles (empty to pickup · loaded · empty home)</dt>
            <dd>{num(load.pickupDeadheadMiles)} · {num(load.loadedMiles)} · {load.isBackhaul ? 0 : num(load.returnDeadheadMiles)}</dd>
            <dt>PO</dt>
            <dd>{load.poNumber ?? "—"}</dd>
          </dl>
        </Card>

        <Card title="Driver">
          {a ? (
            <dl className="tl-kv" style={{ marginBottom: 12 }}>
              <dt>Driver</dt>
              <dd>{drivers.find((d) => d.id === a.driverId)?.name ?? a.driver.name}</dd>
              <dt>Pay</dt>
              <dd>{PAY_KIND_LABEL[a.payKind] ?? a.payKind} · {a.payKind === "flat" ? usd(num(a.payRate)) : a.payKind === "cpm" ? `$${num(a.payRate).toFixed(2)}/mi` : `$${num(a.payRate).toFixed(2)}/hr`}</dd>
              <dt>Estimate (display only)</dt>
              <dd>{usd(a.payEstimate == null ? null : num(a.payEstimate), 2)}</dd>
              <dt>Status</dt>
              <dd><AssignmentChip status={a.status} /></dd>
            </dl>
          ) : (
            <p className="tl-note">No driver yet.</p>
          )}

          {canAssign ? (
            <form action={assignAction} className="tl-form-row" style={{ marginBottom: 10 }}>
              <input type="hidden" name="loadId" value={load.id} />
              <label className="tl-field">
                Driver
                <select name="driverId" defaultValue={a?.driverId} required>
                  {drivers.map((d) => (
                    <option key={d.id} value={d.id} disabled={!!d.blocker}>
                      {d.name}{d.blocker ? ` — ${d.blocker}` : ""}
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
                <input name="rate" type="number" step="0.01" min="0.01" defaultValue={a ? num(a.payRate) : 0.65} required />
              </label>
              <button type="submit" className="tl-btn">{a ? "Change driver or pay" : "Assign driver"}</button>
            </form>
          ) : null}

          {a?.status === "draft" ? (
            <form action={sendAction}>
              <input type="hidden" name="loadId" value={load.id} />
              <button type="submit" className="tl-btn primary">Send to driver</button>
            </form>
          ) : null}
          {a?.status === "dispatched" ? (
            <form action={respondAction} className="tl-form-row">
              <input type="hidden" name="loadId" value={load.id} />
              <span className="tl-note" style={{ flexBasis: "100%" }}>Waiting on the driver. In the real app the phone answers; here you can play the driver:</span>
              <button name="response" value="accepted" type="submit" className="tl-btn primary">Driver accepts</button>
              <button name="response" value="declined" type="submit" className="tl-btn">Driver declines</button>
            </form>
          ) : null}
        </Card>
      </div>

      {driverView ? (
        <Card title="What the driver sees" className="tl-card">
          <p className="tl-note" style={{ marginBottom: 10 }}>
            Only where to go, when, the numbers the dock will ask for, and how they are paid. No rate, no gross, no cost, no rate confirmation.
          </p>
          <pre style={{ margin: 0, padding: 12, background: "var(--db-bg)", borderRadius: 8, overflowX: "auto", fontSize: 12, color: "var(--db-fg-mid)" }}>{JSON.stringify(driverView, null, 2)}</pre>
        </Card>
      ) : null}
    </>
  );
}
