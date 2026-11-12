import Link from "next/link";
import React from "react";
import { FactorStatusImport } from "@/components/desk/factor-status-import";
import { Card, PageHead, Stat } from "@/components/desk/ui";
import { EmptyState } from "@/components/desk/kit/states";
import { dayYear, usd } from "@/lib/desk-format";
import { can } from "@/lib/roles";
import { factoringLabel } from "@/server/partners/factoring";
import { factoringReconciliation, RECON_CAP } from "@/server/partners/factoring-reconciliation";
import { checkAccess } from "@/server/tl/access";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Factoring · TrueLane" };
export const dynamic = "force-dynamic";

/**
 * Factoring reconciliation (docs/MONEY_PLAN.md, Wave 2): every invoice that has been with a factor, what the factor advanced, charged, holds and released, what it charged back, and what the
 * customer paid, read from the invoice records; the totals above the table are the sum of its rows. The factor's status file goes in below the table.
 */
export default async function FactoringPage() {
  const terminal = await currentTerminal();
  const access = await checkAccess("read");
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const { rows, totals, cut } = await factoringReconciliation(undefined, terminal);
  const money = (n: number | null) => (n == null ? <span className="dim">—</span> : usd(n, 2));

  return (
    <>
      <PageHead title="Factoring" sub="Every invoice that has been with a factor: what was advanced, the fees, the reserve held and released, chargebacks, and what customers paid.">
        <Link href="/invoices" className="tl-btn">
          All invoices
        </Link>
      </PageHead>
      <div className="tl-grid cols-4">
        <Stat label="With the factor" value={usd(totals.withFactor.total)} sub={`${totals.withFactor.count} ${totals.withFactor.count === 1 ? "invoice" : "invoices"} sent, not yet funded`} />
        <Stat label="Advanced" value={usd(totals.funded.advances)} sub={`${totals.funded.count} funded · ${usd(totals.funded.fees, 2)} in fees`} />
        <Stat label="Reserve held" value={usd(totals.reserveHeld)} sub={`${usd(totals.reserveReleased, 2)} released so far`} />
        <Stat label="Charged back" value={usd(totals.chargebacks.amount)} tone={totals.chargebacks.count > 0 ? "bad" : undefined} sub={`${totals.chargebacks.count} ${totals.chargebacks.count === 1 ? "invoice" : "invoices"}`} />
      </div>
      <p className="tl-note">
        Net from the factor so far: <b>{usd(totals.netFromFactor, 2)}</b> (advances plus released reserve, less chargebacks). Customers have paid {usd(totals.paidByCustomers, 2)} on these invoices.
        {cut ? ` The ${RECON_CAP.toLocaleString("en-US")} most recent are shown, and the totals are theirs.` : ""}
      </p>

      <Card title={`Invoices with a factor · ${totals.count}`}>
        {rows.length === 0 ? (
          <EmptyState icon="invoices" title="No invoice has been with a factor yet">An invoice shows here once it is sent to a factor, by API or in a batch.</EmptyState>
        ) : (
          <table className="tl-table" aria-label="Factoring reconciliation">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>With the factor</th>
                <th className="num">Invoice</th>
                <th className="num">Advanced</th>
                <th className="num">Fee</th>
                <th className="num">Reserve</th>
                <th className="num">Released</th>
                <th className="num">Charged back</th>
                <th className="num">Customer paid</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.invoiceId}>
                  <td>
                    {r.loadId ? <Link href={`/invoices/${r.loadId}`}>{r.number}</Link> : r.number}
                    <span className="sub">{r.customer ?? "No customer"}</span>
                  </td>
                  <td>
                    <span className={`tl-chip ${r.factoring === "rejected" ? "bad" : r.factoring === "funded" || r.factoring === "paid" ? "ok" : "info"}`}>{r.chargeback != null ? "Charged back" : factoringLabel(r.factoring)}</span>
                    <span className="sub">
                      {r.reference ? `Ref ${r.reference}` : ""}
                      {r.updatedAt ? `${r.reference ? " · " : ""}${dayYear(r.updatedAt)}` : ""}
                    </span>
                  </td>
                  <td className="num">{usd(r.total, 2)}</td>
                  <td className="num">{money(r.advance)}</td>
                  <td className="num">{money(r.fee)}</td>
                  <td className="num">{money(r.reserve)}</td>
                  <td className="num">{money(r.reserveReleased)}</td>
                  <td className="num">{r.chargeback != null ? <span className="tone-neg">{usd(r.chargeback, 2)}</span> : money(null)}</td>
                  <td className="num">{usd(r.paidByCustomer, 2)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={2}>
                  <b>Total</b>
                </td>
                <td className="num" />
                <td className="num">
                  <b>{usd(totals.funded.advances, 2)}</b>
                </td>
                <td className="num">
                  <b>{usd(totals.funded.fees, 2)}</b>
                </td>
                <td className="num">
                  <b>{usd(totals.reserveHeld, 2)}</b>
                  <span className="sub">still held</span>
                </td>
                <td className="num">
                  <b>{usd(totals.reserveReleased, 2)}</b>
                </td>
                <td className="num">
                  <b>{usd(totals.chargebacks.amount, 2)}</b>
                </td>
                <td className="num">
                  <b>{usd(totals.paidByCustomers, 2)}</b>
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Card>

      <Card title="The factor's status file">
        <FactorStatusImport canAct={canBill} />
      </Card>
    </>
  );
}
