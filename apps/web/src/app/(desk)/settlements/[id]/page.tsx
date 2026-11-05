import Link from "next/link";
import { notFound } from "next/navigation";
import React from "react";
import { DocHead } from "@/components/desk/doc-head";
import { ReadOnlyBanner } from "@/components/desk/kit/read-only";
import { FuelLedger, NetPay } from "@/components/desk/statement-fuel";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { MarkSettlementPaid, SettlementEditor, VoidStatement } from "@/components/desk/settlement-forms";
import { PageHead } from "@/components/desk/ui";
import { dateTime, dayYear, shortDate, usd } from "@/lib/desk-format";
import { paidMethodLabel } from "@/lib/pay-method";
import { can, whoCan } from "@/lib/roles";
import { checkAccess } from "@/server/tl/access";
import { getSettlement } from "@/server/tl/settlement";
import { currentTerminal } from "@/server/tl/terminal";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: { id: string } }) {
  const terminal = await currentTerminal();
  const s = await getSettlement(params.id, undefined, terminal);
  return { title: s?.number ?? "Statement · TrueLane" };
}

/**
 * One statement. A draft is the editor. A finalized or voided one is the statement as it was frozen, on a sheet that prints or saves as a PDF:
 * who it is for, the period, each load and how its pay was worked out, the adjustments and the total.
 */
export default async function StatementPage({ params }: { params: { id: string } }) {
  const terminal = await currentTerminal();
  const [s, access] = await Promise.all([getSettlement(params.id, undefined, terminal), checkAccess("read")]);
  if (!s) notFound();
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const canPayout = !!me && can(me.role, me.grants, "payout");
  const canVoid = !!me && can(me.role, me.grants, "writeoff");
  const st = s.statement;

  if (s.status === "draft") {
    return (
      <>
        <div className="no-print">
          <PageHead title={`Statement ${s.number}`} sub={`${s.driver.name} · ${s.periodLabel} · draft`}>
            <Link href="/settlements" className="tl-btn">
              All statements
            </Link>
            <PrintButton documentTitle={s.number} />
          </PageHead>
        </div>
        <SettlementEditor
          id={s.id}
          number={s.number}
          driverName={s.driver.name}
          company={s.company}
          periodLabel={s.periodLabel}
          loads={s.loads}
          initialHours={s.hours}
          initialAdjustments={s.adjustmentRows}
          fuelOptions={s.fuelOptions}
          initialFuel={s.fuelPicked}
          canEdit={canBill}
          who={whoCan("bill")}
        />
      </>
    );
  }

  const paidOut = !!(s.paidAt || s.payrollSentAt);
  const stamp =
    s.status === "void"
      ? ({ text: "Void", tone: "bad" } as const)
      : s.paidAt
        ? ({ text: s.paidMethod === "payroll" ? `Paid by payroll ${shortDate(s.paidAt)}` : `Paid ${shortDate(s.paidAt)}${s.paidMethod ? ` · ${paidMethodLabel(s.paidMethod)}` : ""}`, tone: "good" } as const)
        : s.payrollSentAt
          ? ({ text: `Sent to payroll ${shortDate(s.payrollSentAt)}`, tone: "good" } as const)
          : s.finalizedAt
            ? ({ text: `Finalized ${shortDate(s.finalizedAt)}`, tone: "good" } as const)
            : undefined;
  const payoutText = s.paidAt
    ? `Paid ${dayYear(s.paidAt)}${s.paidMethod ? ` by ${paidMethodLabel(s.paidMethod).toLowerCase()}` : ""}${s.paidMethod === "payroll" && s.payrollReference ? ` (run ${s.payrollReference})` : ""}`
    : s.payrollSentAt
      ? `Sent to payroll ${dayYear(s.payrollSentAt)}${s.payrollReference ? ` (${s.payrollReference})` : ""}`
      : null;

  return (
    <>
      {s.status === "final" && !canPayout && !canVoid ? (
        <div className="no-print">
          <ReadOnlyBanner who={whoCan("payout")} what="this statement" />
        </div>
      ) : null}
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 16 }}>
        <Link href="/settlements" className="tl-btn">
          All statements
        </Link>
        <Link href={`/drivers/${s.driver.id}`} className="tl-btn">
          Driver
        </Link>
        <PrintButton documentTitle={s.number} />
        {s.status === "final" && !paidOut ? (
          <>
            {canPayout ? <MarkSettlementPaid id={s.id} number={s.number} driverName={s.driver.name} total={st.total} /> : null}
            {canVoid ? <VoidStatement id={s.id} number={s.number} /> : canPayout ? <span className="tl-sub">Only an admin can void a finalized statement.</span> : null}
          </>
        ) : null}
      </div>
      <article className="rp">
        <DocHead
          kicker="Pay statement"
          number={s.number}
          company={s.company}
          heroLabel={st.fuel.length > 0 ? "Net pay" : "Gross pay"}
          hero={usd(st.total, 2)}
          sub={`${s.driver.name} · ${s.periodLabel}`}
          stamp={stamp}
        />
        {s.status === "void" ? (
          <p className="rp-bad" role="status">
            <b>Void</b> · {s.voidedAt ? dateTime(s.voidedAt) : ""}
            {s.voidReason ? `: ${s.voidReason}` : ""}. This statement was taken back; its loads can be paid on another one.
          </p>
        ) : null}

        <table style={{ marginTop: 14 }} aria-label="Statement details">
          <tbody>
            <tr>
              <th>Paid to</th>
              <td>
                <b>{s.driver.name}</b>
              </td>
              <th>Period</th>
              <td>{s.periodLabel}</td>
              <th>Finalized</th>
              <td>{s.finalizedAt ? dayYear(s.finalizedAt) : "—"}</td>
            </tr>
            {payoutText ? (
              <tr>
                <th>Payout</th>
                <td colSpan={5}>{payoutText}</td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <h2>Loads</h2>
        {st.lines.length === 0 ? (
          <p>No loads on this statement.</p>
        ) : (
          <table aria-label="Loads paid">
            <thead>
              <tr>
                <th>Load</th>
                <th>Delivered</th>
                <th>How it was worked out</th>
                <th className="num">Pay</th>
              </tr>
            </thead>
            <tbody>
              {st.lines.map((l) => (
                <tr key={l.loadId}>
                  <td>
                    {l.loadNumber ?? "—"}
                    <div className="rp-meta">{l.lane}</div>
                  </td>
                  <td>{l.deliveredAt ? dayYear(l.deliveredAt) : "—"}</td>
                  <td>{l.basis}</td>
                  <td className="num">{l.amount == null ? "—" : usd(l.amount, 2)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3}>
                  <b>Pay for loads</b>
                </td>
                <td className="num">
                  <b>{usd(st.loadsTotal, 2)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )}

        {st.adjustments.length > 0 ? (
          <>
            <h2>Adjustments</h2>
            <table aria-label="Adjustments">
              <tbody>
                {st.adjustments.map((a, i) => (
                  <tr key={i}>
                    <td>{a.label}</td>
                    <td className={`num ${a.amount < 0 ? "rp-bad" : ""}`}>{usd(a.amount, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td>
                    <b>Adjustments</b>
                  </td>
                  <td className="num">
                    <b>{usd(st.adjustmentsTotal, 2)}</b>
                  </td>
                </tr>
              </tbody>
            </table>
          </>
        ) : null}

        <FuelLedger fuel={st.fuel} total={st.fuelTotal} />

        <NetPay driverName={s.driver.name} loadsTotal={st.loadsTotal} fuelTotal={st.fuelTotal} adjustmentsTotal={st.adjustmentsTotal} total={st.total} hasFuel={st.fuel.length > 0} />
        <p className="rp-foot">
          {st.fuel.length > 0 ? "Net pay: pay for the loads, less the fuel card purchases, plus the adjustments above." : "Gross pay for the loads and adjustments above."} Taxes and payroll deductions are not worked out here.
        </p>
      </article>
    </>
  );
}
