import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import React from "react";
import { getCustomerDetail } from "@/server/tl/customers";
import { listAudit } from "@/server/tl/audit";
import { Card, PageHead, Stat } from "@/components/desk/ui";
import { CustomerForm } from "@/components/desk/customer-form";
import { ACTION_LABEL } from "@/lib/audit-diff";
import { BLANK_CUSTOMER, kindLabel, toCustomerValues } from "@/lib/customer";
import { dateTime, perMile, shortDate, signedPct, usd } from "@/lib/desk-format";

export const dynamic = "force-dynamic";

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

/**
 * One customer: its record (kind, MC, billing contact, usual terms, notes), how it has treated the desk (what it pays, how fast against its
 * terms, what it has paid short, what is still out) and its latest loads. `new` is a blank record, or one started from a name that is on loads
 * and has no record yet (`?name=`).
 */
export default async function CustomerPage({ params, searchParams }: { params: { id: string }; searchParams?: { name?: string } }) {
  const isNew = params.id === "new";
  const name = (searchParams?.name ?? "").trim();
  const d = isNew ? (name ? await getCustomerDetail({ name }) : null) : await getCustomerDetail({ id: params.id });
  if (!isNew && !d) notFound();
  // A name that already has a record (a link from a lane or a load) opens that record, not a second blank form.
  if (isNew && d?.record) redirect(`/customers/${d.record.id}`);

  const record = d?.record ?? null;
  const history = record ? (await listAudit({ group: "customers", q: record.name, pageSize: 8 })).rows : [];
  const s = d?.scorecard;
  const k = d?.kpi ?? null;
  const stored = record ? toCustomerValues(record) : { ...BLANK_CUSTOMER, name };

  return (
    <>
      <PageHead title={record?.name ?? (name || "Add a customer")} sub={record ? `${kindLabel(record.kind)}${record.mcNumber ? ` · MC ${record.mcNumber}` : ""} · ${d!.loadCount} ${d!.loadCount === 1 ? "load" : "loads"}` : d ? `No details on file yet · ${d.loadCount} ${d.loadCount === 1 ? "load" : "loads"} carry this name` : "A broker, shipper or direct customer."}>
        <Link href="/customers" className="tl-btn">All customers</Link>
        {d ? <Link href={`/loads?q=${encodeURIComponent(d.name)}`} className="tl-btn">Their loads</Link> : null}
      </PageHead>

      {d && s && d.loadCount > 0 ? (
        <div className="tl-grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="Finished loads" value={String(k?.loads ?? 0)} sub={k && k.loads > 0 ? `${usd(k.gross)} gross · ${perMile(k.rpm)}${k.marketVariancePct != null ? ` · ${signedPct(k.marketVariancePct)} on market` : ""}` : "none delivered yet"} />
          <Stat
            label="Pays in"
            value={k?.avgDaysToPay != null ? `${k.avgDaysToPay.toFixed(1)} days` : "—"}
            sub={s.paid > 0 ? `${pct(s.paidOnTimeRate)} of ${s.paid} paid inside its terms (Net ${d.termsUsed})` : `Terms: Net ${d.termsUsed}. Nothing paid yet.`}
          />
          <Stat label="Still out" value={usd(s.outstanding.total, 2)} sub={s.outstanding.count === 0 ? "nothing outstanding" : `${s.outstanding.count} ${s.outstanding.count === 1 ? "invoice" : "invoices"}${s.outstanding.overdue > 0 ? ` · ${s.outstanding.overdue} overdue, oldest ${s.outstanding.oldestDaysOverdue} days` : ""}`} tone={s.outstanding.overdue > 0 ? "bad" : undefined} />
          <Stat label="Paid short" value={String(s.shortPaid.loads)} sub={s.shortPaid.loads > 0 ? `${usd(s.shortPaid.dollars, 2)} below the invoices` : "none paid below the invoice"} tone={s.shortPaid.loads > 0 ? "warn" : undefined} />
        </div>
      ) : null}

      <Card title={record ? "Record" : "Details"} className="tl-card">
        <CustomerForm id={record?.id ?? null} stored={stored} loads={d?.loadCount ?? 0} />
      </Card>

      {d && d.recent.length > 0 ? (
        <Card title={`Latest loads${d.loadCount > d.recent.length ? ` · ${d.recent.length} of ${d.loadCount}` : ""}`} className="tl-card">
          <table className="tl-table">
            <thead>
              <tr>
                <th>Load</th>
                <th>Lane</th>
                <th>Pickup</th>
                <th className="num">Amount</th>
                <th>Billing</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((l) => (
                <tr key={l.id}>
                  <td><Link href={`/loads/${l.id}`}>{l.loadNumber}</Link></td>
                  <td>{l.lane}</td>
                  <td>{shortDate(l.scheduledDate)}</td>
                  <td className="num">{usd(l.amount, 2)}</td>
                  <td>{l.paymentStatus === "paid" ? "Paid" : l.paymentStatus === "invoiced" ? "Invoiced" : l.status === "completed" ? "Not invoiced" : <span className="dim">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {k ? <p className="tl-note" style={{ marginTop: 10 }}>{k.avgWaitMinutes != null ? `Drivers wait ${k.avgWaitMinutes.toFixed(0)} minutes at a stop on average. ` : ""}{k.lost > 0 ? `${k.lost} ${k.lost === 1 ? "load" : "loads"} fell through (cancelled or a TONU).` : ""}</p> : null}
        </Card>
      ) : null}

      {record ? (
        <Card title="Changes" className="tl-card">
          {history.length === 0 ? (
            <p className="tl-note">Nothing has been changed on this record yet.</p>
          ) : (
            <ul className="feed">
              {history.map((e) => (
                <li key={e.id}>
                  <div><b>{ACTION_LABEL[e.action] ?? e.action}</b> · {e.summary}</div>
                  <div className="t">{dateTime(e.createdAt)} · {e.actor}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}
    </>
  );
}
