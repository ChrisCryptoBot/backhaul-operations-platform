import Link from "next/link";
import { companyLine } from "@/lib/company";
import { notFound } from "next/navigation";
import React from "react";
import { getSettlement } from "@/server/tl/settlement";
import { PageHead } from "@/components/desk/ui";
import { PrintButton } from "@/components/desk/kpi/print-button";
import { SettlementEditor, VoidStatement } from "@/components/desk/settlement-forms";
import { dateTime, shortDate, usd } from "@/lib/desk-format";

export const dynamic = "force-dynamic";

/**
 * One statement. A draft is the editor. A finalized or voided one is the statement as it was frozen, on a sheet that prints or saves as a PDF:
 * who it is for, the period, each load and how its pay was worked out, the adjustments and the total.
 */
export default async function StatementPage({ params }: { params: { id: string } }) {
  const s = await getSettlement(params.id);
  if (!s) notFound();
  const st = s.statement;

  if (s.status === "draft") {
    return (
      <>
        <PageHead title={`Statement ${s.number}`} sub={`${s.driver.name} · ${s.periodLabel} · draft`}>
          <Link href="/settlements" className="tl-btn">All statements</Link>
        </PageHead>
        <SettlementEditor id={s.id} number={s.number} driverName={s.driver.name} loads={s.loads} initialHours={s.hours} initialAdjustments={s.adjustmentRows} />
      </>
    );
  }

  return (
    <>
      <div className="no-print" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <Link href="/settlements" className="tl-btn">All statements</Link>
        <PrintButton />
        {s.status === "final" ? <VoidStatement id={s.id} number={s.number} /> : null}
      </div>
      <article className="rp">
        <h1>Pay statement {s.number}</h1>
        <p className="rp-meta">
          From <b>{s.company.name}</b>
          {companyLine(s.company) ? ` · ${companyLine(s.company)}` : ""}
        </p>
        {s.company.address ? <p className="rp-meta" style={{ whiteSpace: "pre-line" }}>{s.company.address}</p> : null}
        {s.status === "void" ? (
          <p className="rp-bad" role="status">
            <b>Void</b> · {s.voidedAt ? dateTime(s.voidedAt) : ""}
            {s.voidReason ? `: ${s.voidReason}` : ""}. This statement was taken back; its loads can be paid on another one.
          </p>
        ) : null}

        <table style={{ marginTop: 14 }}>
          <tbody>
            <tr>
              <th>Paid to</th>
              <td>
                <b>{s.driver.name}</b>
              </td>
              <th>Period</th>
              <td>{s.periodLabel}</td>
              <th>Finalized</th>
              <td>{s.finalizedAt ? shortDate(s.finalizedAt) : "—"}</td>
            </tr>
          </tbody>
        </table>

        <h2>Loads</h2>
        {st.lines.length === 0 ? (
          <p>No loads on this statement.</p>
        ) : (
          <table>
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
                  <td>{l.deliveredAt ? shortDate(l.deliveredAt) : "—"}</td>
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
            <table>
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

        <h2>Total</h2>
        <table>
          <tbody>
            <tr>
              <td>
                <b>Total to {s.driver.name}</b>
              </td>
              <td className="num">
                <b>{usd(st.total, 2)}</b>
              </td>
            </tr>
          </tbody>
        </table>
        <p className="rp-foot">Gross pay for the loads and adjustments above. Taxes and payroll deductions are not worked out here.</p>
      </article>
    </>
  );
}
