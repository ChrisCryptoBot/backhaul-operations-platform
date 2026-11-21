import { currentAllowed } from "@/server/tl/scope";
import { currentTerminal } from "@/server/tl/terminal";
import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { DriverRowActions, DriverTaxEdit, type DriverRow } from "@/components/desk/fleet-forms";
import { AssignmentChip, Card, PageHead, Stat } from "@/components/desk/ui";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { dateTime, dayYear, miles, payLabel, shortDate, usd } from "@/lib/desk-format";
import { ymdOf } from "@/lib/fleet-forms";
import { paidMethodLabel } from "@/lib/pay-method";
import { can, whoCan } from "@/lib/roles";
import { checkAccess } from "@/server/tl/access";
import { listAudit } from "@/server/tl/audit";
import { numOrNull } from "@/server/tl/convert";
import { getDriverDetail } from "@/server/tl/driver-detail";
import { listDriverSettlements } from "@/server/tl/settlement";
import { CanGate } from "@/components/desk/kit/can-gate";
import { DriverCodeEdit } from "@/components/desk/driver-code-edit";
import { addressText, profileGaps, tinStatusLabel, tinTypeLabel } from "@/lib/form1099";
import { driverTaxValuesOf } from "@/server/tl/fleet";
import { DriverDeductions } from "@/components/desk/driver-deductions";
import { driverDeductions } from "@/server/tl/deductions";
import { DriverPhoneLink, type PhoneLinkView } from "@/components/desk/driver-phone-link";
import { driverLinkView } from "@/server/bridge/links";
import { suggestedLinkRole } from "@/lib/driver-link";

export const dynamic = "force-dynamic";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const late = (m: number | null) => (m == null ? null : m >= 120 ? `${Math.round(m / 60)} h late at worst` : `${m} min late at worst`);

/** One driver: whether they can take a load, what they are on now, and how they have done on the loads they delivered. */
export default async function DriverPage({ params }: { params: { id: string } }) {
  const [d, statements, access, deductions, link] = await Promise.all([
    getDriverDetail(params.id),
    listDriverSettlements(params.id),
    checkAccess("read"),
    driverDeductions(params.id),
    driverLinkView(params.id)
  ]);
  if (!d) notFound();
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const seeTax = !!me && can(me.role, me.grants, "billing_details");
  const canLink = !!me && can(me.role, me.grants, "roster");
  // Dates cross to the client as text.
  const linkView: PhoneLinkView =
    link.state.kind === "linked"
      ? { kind: "linked", since: link.state.since ? link.state.since.toISOString() : null }
      : link.state.kind === "pending"
        ? { kind: "pending", expiresAt: link.state.expiresAt.toISOString() }
        : { kind: link.state.kind };
  const history = await listAudit({ group: "fleet", q: d.driver.name, pageSize: 8 }, undefined, await currentTerminal(), (await currentAllowed()) == null);
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
    phoneUserId: p.phoneUserId ?? "",
    active: p.active,
    onLoads: d.open.length,
    onLoadNumbers: d.open.map((o) => o.loadNumber ?? "a load")
  };

  const statementStatus = (st: (typeof statements.rows)[number]) => {
    if (st.status === "void") return <span className="tl-chip bad">Void</span>;
    if (st.status === "draft") return <span className="tl-chip info">Draft</span>;
    if (st.paidAt) return <span className="tl-chip ok">Paid {dayYear(st.paidAt)}{st.paidMethod ? ` · ${paidMethodLabel(st.paidMethod)}` : ""}</span>;
    if (st.payrollSentAt) return <span className="tl-chip ok">Sent to payroll {dayYear(st.payrollSentAt)}</span>;
    return <span className="tl-chip ok">Finalized {dayYear(st.finalizedAt)}</span>;
  };

  return (
    <>
      <PageHead title={p.name} sub={`${p.code ? `${p.code} · ` : ""}${p.active ? "Active" : "Out of service"}${p.terminal ? ` · based at ${p.terminal}` : ""}${p.assignedVehicle ? ` · drives ${p.assignedVehicle.name}` : ""} · ${d.open.length} open ${d.open.length === 1 ? "load" : "loads"}`}>
        <Link href="/drivers" className="tl-btn">All drivers</Link>
        <Link href={`/messages?driver=${p.id}`} className="tl-btn">Message driver</Link>
        <Link href={`/schedules?q=${encodeURIComponent(p.code ?? p.name)}`} className="tl-btn">Shifts</Link>
        <CanGate caps={["roster"]}>
          <DriverCodeEdit driverId={p.id} code={p.code} />
        </CanGate>
        <CanGate caps={["dispatch"]}>
          <DriverRowActions driver={row} />
        </CanGate>
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
        <Card title="Their phone">
          <DriverPhoneLink driverId={p.id} driverName={p.name} view={linkView} suggestedRole={link.role ?? suggestedLinkRole(p.payrollWorkerType)} canEdit={canLink} />
        </Card>
      </div>

      {seeTax ? (
        <Card
          title="Tax profile (1099)"
          action={
            <CanGate caps={["payout"]}>
              <DriverTaxEdit driverId={p.id} driverName={p.name} initial={driverTaxValuesOf(p)} />
            </CanGate>
          }
          className="tl-card f1099-gap">
          <dl className="tl-kv">
            <dt>Worker type</dt>
            <dd>{p.payrollWorkerType === "contractor" ? "Contractor (1099)" : p.payrollWorkerType === "employee" ? "Employee (W-2, through payroll)" : "Not set"}</dd>
            <dt>Legal name</dt>
            <dd>{p.legalName ?? <span className="dim">Not set</span>}</dd>
            <dt>TIN</dt>
            <dd>{p.tinLast4 ? `${tinTypeLabel(p.tinType) ?? "TIN"} ending ${p.tinLast4}` : <span className="dim">Not set</span>}</dd>
            <dt>TIN status</dt>
            <dd>{tinStatusLabel(p.tinStatus)}</dd>
            <dt>Mailing address</dt>
            <dd>{addressText(p) ?? <span className="dim">Not set</span>}</dd>
          </dl>
          {p.payrollWorkerType === "contractor" && profileGaps(p).length > 0 ? (
            <p className="tl-note warn f1099-gap">Missing for a 1099: {profileGaps(p).join(", ")}.</p>
          ) : null}
          <p className="tl-note f1099-gap">
            Only the last four digits of an SSN or EIN are kept on the desk; the full number stays with the payroll company. Yearly totals are on <Link href="/payroll/1099">1099 totals</Link>.
          </p>
        </Card>
      ) : null}

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

      {seeTax ? (
      <Card
        title={`Pay statements${statements.total > statements.rows.length ? ` · latest ${statements.rows.length} of ${statements.total}` : statements.total > 0 ? ` · ${statements.total}` : ""}`}
        action={
          <Link className="tl-btn ghost sm" href="/settlements">
            All statements
          </Link>
        }
        className="tl-card">
        {statements.rows.length === 0 ? (
          <p className="tl-note">No pay statements for this driver yet.</p>
        ) : (
          <table className="tl-table" aria-label="Pay statements">
            <thead>
              <tr>
                <th>Statement</th>
                <th>Period</th>
                <th>Status</th>
                <th className="num">Loads</th>
                <th className="num">Gross pay</th>
              </tr>
            </thead>
            <tbody>
              {statements.rows.map((st) => (
                <tr key={st.id}>
                  <td>
                    <Link href={`/settlements/${st.id}`}>{st.number}</Link>
                  </td>
                  <td>{st.periodLabel}</td>
                  <td>{statementStatus(st)}</td>
                  <td className="num">{st.loads}</td>
                  <td className="num">{st.total == null ? "—" : usd(st.total, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!canBill ? (
          <p className="tl-note" style={{ marginTop: 10 }}>
            Read-only: {whoCan("bill")} can create or edit driver statements on <Link href="/settlements">Settlements</Link>.
          </p>
        ) : null}
      </Card>
      ) : null}

      {seeTax ? (
      <DriverDeductions
        driverId={p.id}
        employee={deductions.employee}
        escrowHeldCents={deductions.escrowHeldCents}
        owedCents={deductions.owedCents}
        rules={deductions.rules}
        advances={deductions.advances}
        canRecordAdvance={!!me && can(me.role, me.grants, "payout")}
        today={deductions.today}
        ledger={deductions.ledger.map((e) => ({ ...e, at: e.at.toISOString() }))}
        canEdit={canBill}
      />
      ) : null}

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
