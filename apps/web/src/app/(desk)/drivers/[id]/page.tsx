import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { getDriverDetail } from "@/server/tl/driver-detail";
import { listAudit } from "@/server/tl/audit";
import { AssignmentChip, Card, PageHead, Stat } from "@/components/desk/ui";
import { DriverRowActions, type DriverRow } from "@/components/desk/fleet-forms";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { dateTime, miles, payLabel, shortDate, usd } from "@/lib/desk-format";
import { ymdOf } from "@/lib/fleet-forms";
import { numOrNull } from "@/server/tl/convert";

export const dynamic = "force-dynamic";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const late = (m: number | null) => (m == null ? null : m >= 120 ? `${Math.round(m / 60)} h late at worst` : `${m} min late at worst`);

/** One driver: whether they can take a load, what they are on now, and how they have done on the loads they delivered. */
export default async function DriverPage({ params }: { params: { id: string } }) {
  const d = await getDriverDetail(params.id);
  if (!d) notFound();
  const history = await listAudit({ group: "fleet", q: d.driver.name, pageSize: 8 });
  const p = d.driver;
  const s = d.scorecard;
  const row: DriverRow = {
    id: p.id,
    name: p.name,
    phone: p.phone,
    email: p.email,
    cdlClass: p.cdlClass,
    cdlExpiry: ymdOf(p.cdlExpiry),
    medicalCardExpiry: ymdOf(p.medicalCardExpiry),
    truckId: p.assignedVehicleId,
    truckName: p.assignedVehicle?.name ?? null,
    payKind: p.defaultPayKind ?? "",
    payRate: p.defaultPayRate == null ? "" : String(numOrNull(p.defaultPayRate)),
    terminal: p.terminal ?? "",
    carrierMc: p.carrierMcNumber ?? "",
    carrierDot: p.carrierDotNumber ?? "",
    payrollWorkerType: p.payrollWorkerType ?? "",
    payrollEmployeeId: p.payrollEmployeeId ?? "",
    active: p.active,
    onLoads: d.open.length,
    onLoadNumbers: d.open.map((o) => o.loadNumber ?? "a load")
  };

  return (
    <>
      <PageHead title={p.name} sub={`${p.active ? "Active" : "Out of service"}${p.assignedVehicle ? ` · drives ${p.assignedVehicle.name}` : ""} · ${d.open.length} open ${d.open.length === 1 ? "load" : "loads"}`}>
        <Link href="/drivers" className="tl-btn">All drivers</Link>
        <Link href={`/messages?driver=${p.id}`} className="tl-btn">Message driver</Link>
        <DriverRowActions driver={row} />
      </PageHead>

      {p.active && d.blocker ? <p className="tl-note warn" role="alert" style={{ marginBottom: 14 }}>{d.blocker}. This driver cannot be assigned a load until it is fixed.</p> : null}

      {s.loads === 0 ? (
        <p className="tl-note" style={{ marginBottom: 14 }}>No delivered loads yet, so there is nothing to score. The figures below fill in as this driver delivers.</p>
      ) : (
        <div className="tl-grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="On time" value={pct(s.onTime.rate)} sub={`${s.onTime.onTime} of ${s.onTime.scored} stops${late(s.worstLateMinutes) ? ` · ${late(s.worstLateMinutes)}` : ""}`} />
          <Stat label="Empty miles" value={pct(s.empty.share)} sub={`${miles(s.empty.miles)} of ${miles(s.empty.total)} driven`} />
          <Stat label="Owed on delivered loads" value={usd(s.pay, 2)} sub={`${s.loads} ${s.loads === 1 ? "load" : "loads"}, estimates at each load's pay`} />
          <Stat label="Short-paid by the customer" value={String(s.shortPaid.loads)} sub={s.shortPaid.loads > 0 ? `${usd(s.shortPaid.dollars, 2)} below the invoices` : "None paid below the invoice"} tone={s.shortPaid.loads > 0 ? "warn" : undefined} />
        </div>
      )}

      <div className="tl-grid cols-2">
        <Card title={`On now · ${d.open.length}`}>
          {d.open.length === 0 ? (
            <p className="tl-note">Not on a load.</p>
          ) : (
            <ul className="dq">
              {d.open.map((o) => (
                <li key={o.loadId} className="dq-row">
                  <div className="dq-top">
                    <Link href={`/loads/${o.loadId}`}>{o.loadNumber}</Link>
                    <span className="tl-sub">{shortDate(o.pickup)}</span>
                  </div>
                  <div className="dq-foot">
                    <span className="tl-sub">{o.lane}</span>
                    <AssignmentChip status={o.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Details">
          <dl className="tl-kv">
            <dt>Phone</dt>
            <dd>{p.phone ?? "—"}</dd>
            <dt>Email</dt>
            <dd>{p.email ?? "—"}</dd>
            <dt>CDL</dt>
            <dd>Class {p.cdlClass ?? "?"} · to {shortDate(p.cdlExpiry)}</dd>
            <dt>Medical card</dt>
            <dd>to {shortDate(p.medicalCardExpiry)}</dd>
            <dt>Usual pay</dt>
            <dd>{payLabel(p.defaultPayKind, numOrNull(p.defaultPayRate))}</dd>
          </dl>
        </Card>
      </div>

      <Card title={`Recent deliveries${s.loads > d.recent.length ? ` · latest ${d.recent.length} of ${s.loads}` : ""}`} className="tl-card">
        {d.recent.length === 0 ? (
          <p className="tl-note">Nothing delivered yet.</p>
        ) : (
          <table className="tl-table" aria-label="Recent loads">
            <thead>
              <tr>
                <th>Load</th>
                <th>Lane</th>
                <th>Delivered</th>
                <th className="num">On time</th>
                <th className="num">Empty</th>
                <th className="num">Pay</th>
                <th className="num">Short-paid</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/loads/${l.id}`}>{l.loadNumber}</Link></td>
                  <td>{l.lane}</td>
                  <td>{shortDate(l.completedAt)}</td>
                  <td className="num">{l.stopsScored === 0 ? <span className="dim">—</span> : `${l.stopsOnTime} of ${l.stopsScored}`}</td>
                  <td className="num">{miles(l.emptyMiles)}</td>
                  <td className="num">{usd(l.pay, 2)}</td>
                  <td className="num">{l.shortBy > 0 ? usd(l.shortBy, 2) : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="tl-note" style={{ marginTop: 10 }}>
          On time follows the phone&apos;s rule: arriving up to an hour before the window opens to half an hour after it closes. A stop with no arrival entered is not scored, except the delivery, which is taken from when the load was delivered. Statements for what the driver is paid are on <Link href="/settlements">Settlements</Link>.
        </p>
      </Card>

      <Card title="Changes" className="tl-card">
        {history.rows.length === 0 ? (
          <p className="tl-note">Nothing has been changed on this driver yet.</p>
        ) : (
          <ul className="feed">
            {history.rows.map((e) => (
              <li key={e.id}>
                <div><b>{ACTION_LABEL[e.action] ?? e.action}</b> · {e.summary}</div>
                <div className="t">{dateTime(e.createdAt)} · {e.actor}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
