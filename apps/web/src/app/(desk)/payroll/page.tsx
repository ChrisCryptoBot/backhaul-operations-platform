import Link from "next/link";
import React from "react";
import { listPayroll, PAYROLL_PAGE, WORKER_TYPES } from "@/server/partners/payroll";
import { Pager } from "@/components/desk/pager";
import { asPage } from "@/lib/paging";
import { PageHead, Stat } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { EmptyState } from "@/components/desk/kit/states";
import { PayrollSend } from "@/components/desk/partner-actions";
import { shortDate, usd } from "@/lib/desk-format";

export const metadata = { title: "Payroll · TrueLane" };

export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "pick", label: "", width: 44 },
  { key: "statement", label: "Statement", sticky: true, width: 150 },
  { key: "driver", label: "Driver" },
  { key: "period", label: "Period" },
  { key: "total", label: "Gross pay", align: "num" },
  { key: "worker", label: "Worker type" },
  { key: "state", label: "Payroll" }
];

type Params = { page?: string; show?: string };

/** Driver pay going to the payroll company: the finalized statements, who is set up there, and one button to send what is ready. Gross pay only. */
export default async function PayrollPage({ searchParams }: { searchParams?: Params }) {
  const show = searchParams?.show === "sent" ? "sent" : searchParams?.show === "all" ? "all" : "ready";
  const data = await listPayroll({ page: asPage(searchParams?.page), filter: show });
  const ready = data.rows.filter((r) => !r.notReady);
  const href = (p: { show?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = p.show ?? show;
    if (s !== "ready") u.set("show", s);
    if (p.page && p.page > 1) u.set("page", String(p.page));
    const q = u.toString();
    return q ? `/payroll?${q}` : "/payroll";
  };
  const rows: Row[] = data.rows.map((r) => ({
    id: r.id,
    search: [r.number, r.driverName].join(" "),
    cells: {
      pick: r.notReady ? null : <input type="checkbox" data-payroll value={r.id} aria-label={`Send ${r.number}`} />,
      statement: <Link href={`/settlements/${r.id}`}>{r.number}</Link>,
      driver: <Link href={`/drivers/${r.driverId}`}>{r.driverName}</Link>,
      period: `${shortDate(r.periodStart)} to ${shortDate(r.periodEnd)}`,
      total: usd(r.total, 2),
      worker: r.workerType ? `${WORKER_TYPES.find((w) => w.key === r.workerType)?.label ?? r.workerType}${r.employeeId ? ` · ${r.employeeId}` : ""}` : <span className="dim">Not set</span>,
      state: r.sentAt ? <span className="tl-chip ok">Sent {shortDate(r.sentAt)}{r.reference ? ` · ${r.reference}` : ""}</span> : r.notReady ? <span className="tl-chip warn">{r.notReady}</span> : <span className="tl-chip info">Ready</span>
    }
  }));

  return (
    <>
      <PageHead title="Payroll" sub="Finalized driver statements, and whether each driver is set up with the payroll company. A statement goes once; gross pay only, with no taxes or deductions worked out here." />
      <div className="tl-grid cols-4">
        <Stat label="Ready to send" value={String(data.unsent)} sub="finalized, not sent" />
        <Stat label="Sent" value={String(data.sent)} />
      </div>
      <div className="tl-form-row" style={{ margin: "14px 0" }}>
        <Link href={href({ show: "ready", page: 1 })} className="tl-btn sm" aria-current={show === "ready" ? "true" : undefined}>Not sent</Link>
        <Link href={href({ show: "sent", page: 1 })} className="tl-btn sm" aria-current={show === "sent" ? "true" : undefined}>Sent</Link>
        <Link href={href({ show: "all", page: 1 })} className="tl-btn sm" aria-current={show === "all" ? "true" : undefined}>All</Link>
      </div>
      <PayrollSend readyIds={ready.map((r) => r.id)} reason={data.state.reason} />
      <div style={{ marginTop: 12 }}>
        <DataTable id="payroll-table" label="Statements for payroll" columns={COLUMNS} rows={rows} empty={<EmptyState icon="wallet" title="No finalized statements here">Finalize a driver statement on Settlements and it appears here.</EmptyState>} />
      </div>
      <Pager page={data.page} pageSize={PAYROLL_PAGE} total={data.total} hrefFor={(n) => href({ page: n })} newer="Previous" older="Next" />
    </>
  );
}
