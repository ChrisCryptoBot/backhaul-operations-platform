import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { EmptyState } from "@/components/desk/kit/states";
import { Pager } from "@/components/desk/pager";
import { PayrollSend } from "@/components/desk/partner-actions";
import { PageHead, Stat } from "@/components/desk/ui";
import { dayYear, usd } from "@/lib/desk-format";
import { asPage } from "@/lib/paging";
import { can, whoCan } from "@/lib/roles";
import { periodText } from "@/lib/settlement";
import { listPayroll, PAYROLL_PAGE, WORKER_TYPES } from "@/server/partners/payroll";
import { checkAccess } from "@/server/tl/access";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Payroll · TrueLane" };

export const dynamic = "force-dynamic";

const PICK_COLUMN: Column = { key: "pick", label: "", width: 44 };
const BASE_COLUMNS: Column[] = [
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
  const terminal = await currentTerminal();
  const [data, access] = await Promise.all([
    listPayroll({ page: asPage(searchParams?.page), filter: show, terminal }),
    checkAccess("read")
  ]);
  const me = access.ok ? access.identity : null;
  const canPayout = !!me && can(me.role, me.grants, "payout");
  const columns = canPayout ? [PICK_COLUMN, ...BASE_COLUMNS] : BASE_COLUMNS;

  const href = (p: { show?: string; page?: number }) => {
    const u = new URLSearchParams();
    const s = p.show ?? show;
    if (s !== "ready") u.set("show", s);
    if (p.page && p.page > 1) u.set("page", String(p.page));
    const q = u.toString();
    return q ? `/payroll?${q}` : "/payroll";
  };

  // Dates on a statement are calendar days, kept as midnight UTC: read as that, not shifted back a day into the evening before.
  const rows: Row[] = data.rows.map((r) => ({
    id: r.id,
    search: [r.number, r.driverName].join(" "),
    cells: {
      ...(canPayout ? { pick: r.notReady ? null : <input type="checkbox" data-payroll value={r.id} aria-label={`Send ${r.number}`} /> } : {}),
      statement: <Link href={`/settlements/${r.id}`}>{r.number}</Link>,
      driver: <Link href={`/drivers/${r.driverId}`}>{r.driverName}</Link>,
      period: periodText(r.periodStart.toISOString().slice(0, 10), r.periodEnd.toISOString().slice(0, 10)),
      total: usd(r.total, 2),
      worker: r.workerType ? `${WORKER_TYPES.find((w) => w.key === r.workerType)?.label ?? r.workerType}${r.employeeId ? ` · ${r.employeeId}` : ""}` : <span className="dim">Not set</span>,
      state: r.paidAt && r.paidMethod === "payroll" ? (
        <span className="t-st" data-tone="ok" title="The payroll company's run cleared">
          Paid by payroll {dayYear(r.paidAt)}
          {r.reference ? ` · ${r.reference}` : ""}
        </span>
      ) : r.sentAt ? (
        <span className="t-st" data-tone="warn" title="Sent to the payroll company; its run has not cleared yet">
          With payroll, sent {dayYear(r.sentAt)}
          {r.reference ? ` · ${r.reference}` : ""}
        </span>
      ) : r.notReady ? (
        <span className="tl-chip warn">{r.notReady}</span>
      ) : (
        <span className="tl-chip info">Ready</span>
      )
    }
  }));

  return (
    <>
      <PageHead title="Payroll" sub="Finalized driver statements, and whether each driver is set up with the payroll company. A statement goes once; gross pay only, with no taxes or deductions worked out here.">
        <a className="tl-btn" href="/export/settlements?status=final">
          Export CSV
        </a>
      </PageHead>
      {terminal && data.hiddenByTerminal > 0 ? (
        <p className="tl-note" role="note" style={{ margin: "0 0 14px" }}>
          {data.hiddenByTerminal} finalized {data.hiddenByTerminal === 1 ? "statement" : "statements"} hidden by the <b>{terminal}</b> terminal filter.
        </p>
      ) : null}
      <div className="tl-grid cols-4">
        <Stat label="Ready to send" value={String(data.ready)} sub="set up with payroll, not sent" />
        <Stat
          label="Waiting on something"
          value={String(data.unsent - data.ready)}
          sub="driver not set up, paid by hand, or nothing owed"
          tone={data.unsent - data.ready > 0 ? "warn" : undefined}
        />
        <Stat label="Sent" value={String(data.sent)} />
      </div>
      <div className="tl-form-row" style={{ margin: "14px 0" }}>
        <Link href={href({ show: "ready", page: 1 })} className="tl-btn sm" aria-current={show === "ready" ? "true" : undefined}>
          Not sent
        </Link>
        <Link href={href({ show: "sent", page: 1 })} className="tl-btn sm" aria-current={show === "sent" ? "true" : undefined}>
          Sent
        </Link>
        <Link href={href({ show: "all", page: 1 })} className="tl-btn sm" aria-current={show === "all" ? "true" : undefined}>
          All
        </Link>
      </div>
      <PayrollSend readyIds={data.readyIds} reason={data.state.reason} canAct={canPayout} who={whoCan("payout")} />
      <div style={{ marginTop: 12 }}>
        <DataTable
          id="payroll-table"
          label="Statements for payroll"
          columns={columns}
          rows={rows}
          empty={<EmptyState icon="wallet" title="No finalized statements here">Finalize a driver statement on Settlements and it appears here.</EmptyState>}
        />
      </div>
      <Pager page={data.page} pageSize={PAYROLL_PAGE} total={data.total} hrefFor={(n) => href({ page: n })} newer="Previous" older="Next" />
    </>
  );
}
