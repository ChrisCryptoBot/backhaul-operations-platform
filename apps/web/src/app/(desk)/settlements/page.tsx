import Link from "next/link";
import React from "react";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { ReadOnlyBanner } from "@/components/desk/kit/read-only";
import { EmptyState } from "@/components/desk/kit/states";
import { Pager } from "@/components/desk/pager";
import { StartStatement } from "@/components/desk/settlement-forms";
import { Card, PageHead, Stat } from "@/components/desk/ui";
import { dayYear, shortDate, usd } from "@/lib/desk-format";
import { asPage } from "@/lib/paging";
import { paidMethodLabel } from "@/lib/pay-method";
import { can, whoCan } from "@/lib/roles";
import { periodPresets } from "@/lib/settlement";
import { checkAccess } from "@/server/tl/access";
import { listSettlements, settlementCounts, STATEMENTS_PAGE, unsettledByDriver } from "@/server/tl/settlement";
import { currentTerminal } from "@/server/tl/terminal";

export const metadata = { title: "Settlements · TrueLane" };

export const dynamic = "force-dynamic";

const UNSETTLED: Column[] = [
  { key: "driver", label: "Driver", sticky: true, width: 200 },
  { key: "loads", label: "Loads", align: "num" },
  { key: "range", label: "Delivered" },
  { key: "amount", label: "Comes to", align: "num" },
  { key: "act", label: "", align: "num" }
];
const STATEMENTS: Column[] = [
  { key: "number", label: "Statement", sticky: true, width: 150 },
  { key: "driver", label: "Driver" },
  { key: "period", label: "Period" },
  { key: "loads", label: "Loads", align: "num" },
  { key: "total", label: "Total", align: "num" },
  { key: "when", label: "When" }
];

/** Drivers owed pay listed at a time. */
const OWED_PAGE = 50;
/** Draft statements listed at a time (each one is worked up from its loads as it is shown). */
const DRAFT_PAGE = 25;

/** Driver pay: what each driver is owed for loads they delivered, as statements you work up, finalize and print. */
export default async function SettlementsPage({ searchParams }: { searchParams?: { page?: string; owed?: string; drafts?: string; voided?: string } }) {
  // A big fleet settles every driver every week, so each list is a page at a time: the drivers owed pay (the total above is for all of them), the drafts being
  // worked up, the finalized statements newest first, and the voided ones.
  // The header's terminal narrows statements too, by the driver's terminal.
  const terminal = await currentTerminal();
  const [counts, unscopedCounts, access] = await Promise.all([
    settlementCounts(undefined, terminal),
    terminal ? settlementCounts(undefined, null) : Promise.resolve(null),
    checkAccess("read")
  ]);
  const me = access.ok ? access.identity : null;
  const canBill = !!me && can(me.role, me.grants, "bill");
  const hiddenByTerminal =
    terminal && unscopedCounts
      ? Math.max(0, unscopedCounts.draft + unscopedCounts.final + unscopedCounts.void - (counts.draft + counts.final + counts.void))
      : 0;

  const page = Math.min(asPage(searchParams?.page), Math.max(1, Math.ceil(counts.final / STATEMENTS_PAGE)));
  const draftPage = Math.min(asPage(searchParams?.drafts), Math.max(1, Math.ceil(counts.draft / DRAFT_PAGE)));
  const voidPage = Math.min(asPage(searchParams?.voided), Math.max(1, Math.ceil(counts.void / STATEMENTS_PAGE)));

  const [unsettled, drafts, final, voided] = await Promise.all([
    unsettledByDriver(undefined, new Date(), terminal),
    listSettlements(undefined, { status: "draft", terminal, skip: (draftPage - 1) * DRAFT_PAGE, take: DRAFT_PAGE }),
    listSettlements(undefined, { status: "final", terminal, skip: (page - 1) * STATEMENTS_PAGE, take: STATEMENTS_PAGE }),
    listSettlements(undefined, { status: "void", terminal, skip: (voidPage - 1) * STATEMENTS_PAGE, take: STATEMENTS_PAGE })
  ]);
  const presets = periodPresets(Date.now());
  const owed = unsettled.reduce((sum, u) => sum + u.amount, 0);
  const owedLoads = unsettled.reduce((sum, u) => sum + u.loads, 0);
  const owedPage = Math.min(asPage(searchParams?.owed), Math.max(1, Math.ceil(unsettled.length / OWED_PAGE)));
  const href = (over: { page?: number; owed?: number; drafts?: number; voided?: number }) => {
    const u = new URLSearchParams();
    const pages = { page, owed: owedPage, drafts: draftPage, voided: voidPage, ...over };
    for (const [k, v] of Object.entries(pages)) if (v > 1) u.set(k, String(v));
    const q = u.toString();
    return q ? `/settlements?${q}` : "/settlements";
  };

  const unsettledRows: Row[] = unsettled.slice((owedPage - 1) * OWED_PAGE, owedPage * OWED_PAGE).map((u) => ({
    id: u.driverId,
    search: u.driverName,
    cells: {
      driver: (
        <Link href={`/drivers/${u.driverId}`}>
          <b>{u.driverName}</b>
        </Link>
      ),
      loads: u.loads,
      range: u.loads === 0 ? <span className="dim">—</span> : u.oldest.getTime() === u.newest.getTime() ? shortDate(u.oldest) : `${shortDate(u.oldest)} to ${shortDate(u.newest)}`,
      amount: (
        <>
          {u.loads === 0 ? <span className="dim">—</span> : usd(u.amount, 2)}
          {u.paidShort > 0 ? <span className="sub tone-neg">{u.paidShort} paid short by the customer</span> : null}
          {u.tonu > 0 ? (
            <span className="sub">
              {u.tonu} TONU {u.tonu === 1 ? "load is" : "loads are"} on no statement: add the driver&apos;s share as an adjustment if one is owed
            </span>
          ) : null}
          {u.hourlyWithoutHours > 0 ? (
            <span className="sub">
              + {u.hourlyWithoutHours} hourly {u.hourlyWithoutHours === 1 ? "load needs" : "loads need"} hours
            </span>
          ) : null}
        </>
      ),
      act:
        !canBill || u.loads === 0 ? null : (
          <StartStatement presets={presets} initial={{ driverId: u.driverId, driverName: u.driverName, start: u.start, end: u.end }} label="Start statement" primary={false} />
        )
    }
  }));
  const statementRow = (s: (typeof drafts)[number], when: string): Row => ({
    id: s.id,
    href: `/settlements/${s.id}`,
    search: [s.number, s.driverName].join(" "),
    cells: {
      number: <Link href={`/settlements/${s.id}`}>{s.number}</Link>,
      driver: s.driverName,
      period: s.periodLabel,
      loads: s.loads,
      total: s.total == null ? "—" : usd(s.total, 2),
      when
    }
  });
  const finalWhen = (s: (typeof final)[number]) =>
    s.paidAt
      ? `Paid ${dayYear(s.paidAt)}${s.paidMethod ? ` · ${paidMethodLabel(s.paidMethod)}` : ""}`
      : s.payrollSentAt
        ? `Sent to payroll ${dayYear(s.payrollSentAt)}`
        : `Finalized ${dayYear(s.finalizedAt)}`;

  return (
    <>
      <PageHead title="Settlements" sub="What each driver is owed for the loads they delivered. Start a statement for a period, add hours and adjustments, finalize it and print it.">
        <a className="tl-btn" href="/export/settlements">
          Export statements CSV
        </a>
        <a className="tl-btn" href="/export/settlement-lines">
          Export lines CSV
        </a>
        {canBill ? <StartStatement presets={presets} /> : null}
      </PageHead>
      {!canBill ? <ReadOnlyBanner who={whoCan("bill")} what="driver statements" /> : null}
      {terminal && hiddenByTerminal > 0 ? (
        <p className="tl-note" role="note" style={{ margin: "0 0 14px" }}>
          {hiddenByTerminal} {hiddenByTerminal === 1 ? "statement" : "statements"} hidden by the <b>{terminal}</b> terminal filter.
        </p>
      ) : null}
      <div className="tl-grid cols-4">
        <Stat
          label="Delivered, not yet settled"
          value={usd(owed, 2)}
          sub={`${owedLoads} ${owedLoads === 1 ? "load" : "loads"}, ${unsettled.length} ${unsettled.length === 1 ? "driver" : "drivers"}`}
          tone={owed > 0 ? "warn" : undefined}
        />
        <Stat label="Drafts" value={String(counts.draft)} sub="not final yet" />
        <Stat label="Finalized" value={String(counts.final)} sub={counts.final > 0 ? usd(counts.finalTotal, 2) : "none yet"} />
        <Stat label="Voided" value={String(counts.void)} />
      </div>

      <Card title={`Delivered and not yet settled · ${unsettled.length}`}>
        <DataTable
          id="settle-open"
          label="Delivered and not yet settled"
          columns={UNSETTLED}
          rows={unsettledRows}
          empty={<EmptyState icon="check" title="Every delivered load is on a finalized statement">A load shows here once it is delivered, until it is paid on one.</EmptyState>}
        />
        <Pager page={owedPage} pageSize={OWED_PAGE} total={unsettled.length} hrefFor={(n) => href({ owed: n })} newer="Previous" older="Next" />
        <p className="tl-note" style={{ marginTop: 8 }}>
          Pay follows each load&apos;s own assignment: per loaded mile, a set amount, hourly, or a percent of the rate confirmation. Hourly loads need their hours on the statement.
        </p>
      </Card>
      <Card title={`Drafts · ${counts.draft}`}>
        <DataTable id="settle-drafts" label="Draft statements" columns={STATEMENTS} rows={drafts.map((s) => statementRow(s, `Started ${dayYear(s.createdAt)}`))} empty={<EmptyState icon="invoices" title="No drafts" />} />
        <Pager page={draftPage} pageSize={DRAFT_PAGE} total={counts.draft} hrefFor={(n) => href({ drafts: n })} newer="Newer" older="Older" />
      </Card>
      <Card title={`Finalized · ${counts.final}`}>
        <DataTable id="settle-final" label="Finalized statements" columns={STATEMENTS} rows={final.map((s) => statementRow(s, finalWhen(s)))} empty={<EmptyState icon="invoices" title="Nothing finalized yet" />} />
        <Pager page={page} pageSize={STATEMENTS_PAGE} total={counts.final} hrefFor={(n) => href({ page: n })} newer="Newer" older="Older" />
      </Card>
      {counts.void > 0 ? (
        <Card title={`Voided · ${counts.void}`}>
          <DataTable id="settle-void" label="Voided statements" columns={STATEMENTS} rows={voided.map((s) => statementRow(s, `Voided ${dayYear(s.voidedAt)}`))} />
          <Pager page={voidPage} pageSize={STATEMENTS_PAGE} total={counts.void} hrefFor={(n) => href({ voided: n })} newer="Newer" older="Older" />
        </Card>
      ) : null}
    </>
  );
}
