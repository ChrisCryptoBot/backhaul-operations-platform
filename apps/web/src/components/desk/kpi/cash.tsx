import React from "react";
import { CASH_LABEL, CASH_SOURCES, type DayStats } from "@/lib/cash";
import { usd } from "@/lib/desk-format";
import type { KpiCash } from "@/server/tl/cash";
import { Card } from "../ui";

/**
 * Cash beside gross (money plan Wave 6 step 4), for the billing office. Gross is the agreed rate on the loads that finished (gap 6, rule 2: never lowered by a fee); cash is the money that moved,
 * the way the journal books it. They sit side by side and are never added together. Days to cash count the invoices that got there; the rest are said to be waiting, never counted as days.
 */
const m = (cents: number) => usd(cents / 100, 2);
const n = (x: number) => x.toLocaleString("en-US");

function daysLine(label: string, s: DayStats, issued: number) {
  if (issued === 0) return `${label}: no invoice was issued in this period.`;
  if (s.reached === 0) return `${label}: none of the ${n(issued)} invoices issued yet (${n(s.waiting)} waiting).`;
  return `${label}: median ${s.median} ${s.median === 1 ? "day" : "days"}, 9 in 10 within ${s.p90} (${n(s.reached)} of ${n(issued)} invoices issued; ${n(s.waiting)} still waiting, not counted as days).`;
}

export function CashCard({ cash, gross }: { cash: KpiCash; gross: number }) {
  const c = cash.current;
  const p = cash.prior;
  const cost = c.cost.feesCents + c.cost.shortCents;
  return (
    <Card title="Cash beside gross">
      <div className="km km-4" data-testid="cash-cells">
        <div className="km-cell">
          <div className="km-label">Gross, finished loads</div>
          <div className="km-value">{usd(gross, 2)}</div>
          <div className="km-sub">The agreed rate; never lowered by a fee</div>
        </div>
        <div className="km-cell">
          <div className="km-label">Cash in</div>
          <div className="km-value">{m(c.cash.net)}</div>
          <div className="km-sub">{p ? `${m(p.cash.net)} in the period before` : "Money received, net of chargebacks"}</div>
        </div>
        <div className="km-cell">
          <div className="km-label">Cost of money</div>
          <div className="km-value">{m(cost)}</div>
          <div className="km-sub">Factor fees and fees taken short</div>
        </div>
        <div className="km-cell">
          <div className="km-label">Still owed now</div>
          <div className="km-value">{m(cash.open.cents)}</div>
          <div className="km-sub">
            {n(cash.open.invoices)} open {cash.open.invoices === 1 ? "invoice" : "invoices"}
            {cash.open.factoredInvoices > 0 ? `; ${m(cash.open.factoredCents)} of it funded by a factor` : ""}
          </div>
        </div>
      </div>
      <table className="tl-table cash-sources" aria-label="Cash in by source">
        <thead>
          <tr>
            <th>Cash in, by where it came from</th>
            <th className="num">This period</th>
            {p ? <th className="num">The period before</th> : null}
          </tr>
        </thead>
        <tbody>
          {CASH_SOURCES.map((s) => (
            <tr key={s}>
              <td>{CASH_LABEL[s]}</td>
              <td className="num">{m(c.cash[s])}</td>
              {p ? <td className="num">{m(p.cash[s])}</td> : null}
            </tr>
          ))}
          <tr>
            <th scope="row">Cash in, net</th>
            <td className="num">
              <b>{m(c.cash.net)}</b>
            </td>
            {p ? <td className="num">{m(p.cash.net)}</td> : null}
          </tr>
          <tr>
            <td>Factoring fees (cost of money, not taken off gross)</td>
            <td className="num">{m(c.cost.feesCents)}</td>
            {p ? <td className="num">{m(p.cost.feesCents)}</td> : null}
          </tr>
          <tr>
            <td>Quick-pay and factor fees taken short</td>
            <td className="num">{m(c.cost.shortCents)}</td>
            {p ? <td className="num">{m(p.cost.shortCents)}</td> : null}
          </tr>
        </tbody>
      </table>
      <p className="tl-sub cash-days" data-testid="cash-days">
        {daysLine("Issued to first cash", c.days.firstCash, c.days.invoices)}
        <br />
        {daysLine("Issued to paid in full", c.days.paidInFull, c.days.invoices)}
      </p>
      <p className="tl-sub">
        Cash is booked the way the journal books it: a customer&apos;s payment while a factor owned the invoice went to the factor and is not counted here; the factor&apos;s advance counts on the day it funded,
        its reserve on the day it released it, and a chargeback takes the advance back. Days are calendar days in the workspace&apos;s zone, from the day the invoice was issued.
        {cash.leftOut > 0 ? ` ${n(cash.leftOut)} ${cash.leftOut === 1 ? "invoice is" : "invoices are"} left out: ${cash.leftOut === 1 ? "its" : "their"} loads are both in and out of this view, or carry no load, and an invoice is not split.` : ""}
        {cash.truncated ? " Only the newest 20,000 invoices were read." : ""}
      </p>
    </Card>
  );
}
