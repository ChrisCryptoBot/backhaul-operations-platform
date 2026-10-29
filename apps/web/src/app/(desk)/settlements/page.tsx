import Link from "next/link";
import React from "react";
import { listDrivers } from "@/server/tl/queries";
import { listSettlements, unsettledByDriver } from "@/server/tl/settlement";
import { PageHead, Stat } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { EmptyState } from "@/components/desk/kit/states";
import { StartStatement } from "@/components/desk/settlement-forms";
import { shortDate, usd } from "@/lib/desk-format";
import { periodPresets } from "@/lib/settlement";

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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: 20 }}>
      <h2 style={{ fontFamily: "var(--db-font-sans)", fontSize: "var(--db-text-xs)", letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--db-fg-dim)", fontWeight: 700, margin: "0 0 10px" }}>{title}</h2>
      {children}
    </section>
  );
}

/** Driver pay: what each driver is owed for loads they delivered, as statements you work up, finalize and print. */
export default async function SettlementsPage() {
  const [unsettled, statements, drivers] = await Promise.all([unsettledByDriver(), listSettlements(), listDrivers()]);
  const presets = periodPresets(Date.now());
  const driverOptions = drivers.map((d) => ({ id: d.id, name: d.name }));
  const drafts = statements.filter((s) => s.status === "draft");
  const final = statements.filter((s) => s.status === "final");
  const voided = statements.filter((s) => s.status === "void");
  const owed = unsettled.reduce((sum, u) => sum + u.amount, 0);
  const owedLoads = unsettled.reduce((sum, u) => sum + u.loads, 0);

  const unsettledRows: Row[] = unsettled.map((u) => ({
    id: u.driverId,
    search: u.driverName,
    cells: {
      driver: <b>{u.driverName}</b>,
      loads: u.loads,
      range: u.oldest.getTime() === u.newest.getTime() ? shortDate(u.oldest) : `${shortDate(u.oldest)} to ${shortDate(u.newest)}`,
      amount: (
        <>
          {usd(u.amount, 2)}
          {u.hourlyWithoutHours > 0 ? <span className="sub">+ {u.hourlyWithoutHours} hourly {u.hourlyWithoutHours === 1 ? "load needs" : "loads need"} hours</span> : null}
        </>
      ),
      act: <StartStatement drivers={driverOptions} presets={presets} initial={{ driverId: u.driverId, start: u.start, end: u.end }} label="Start statement" primary={false} />
    }
  }));
  const statementRow = (s: (typeof statements)[number], when: string): Row => ({
    id: s.id,
    href: `/settlements/${s.id}`,
    search: [s.number, s.driverName].join(" "),
    cells: { number: <Link href={`/settlements/${s.id}`}>{s.number}</Link>, driver: s.driverName, period: s.periodLabel, loads: s.loads, total: s.total == null ? "—" : usd(s.total, 2), when }
  });

  return (
    <>
      <PageHead title="Settlements" sub="What each driver is owed for the loads they delivered. Start a statement for a period, add hours and adjustments, finalize it and print it.">
        <StartStatement drivers={driverOptions} presets={presets} />
      </PageHead>
      <div className="tl-grid cols-4">
        <Stat label="Delivered, not yet settled" value={usd(owed, 2)} sub={`${owedLoads} ${owedLoads === 1 ? "load" : "loads"}, ${unsettled.length} ${unsettled.length === 1 ? "driver" : "drivers"}`} tone={owed > 0 ? "warn" : undefined} />
        <Stat label="Drafts" value={String(drafts.length)} sub="not final yet" />
        <Stat label="Finalized" value={String(final.length)} sub={final.length > 0 ? usd(final.reduce((sum, s) => sum + (s.total ?? 0), 0), 2) : "none yet"} />
        <Stat label="Voided" value={String(voided.length)} />
      </div>

      <Section title={`Delivered and not yet settled · ${unsettled.length}`}>
        <DataTable id="settle-open" label="Delivered and not yet settled" columns={UNSETTLED} rows={unsettledRows} empty={<EmptyState icon="check" title="Every delivered load is on a finalized statement">A load shows here once it is delivered, until it is paid on one.</EmptyState>} />
        <p className="tl-note" style={{ marginTop: 8 }}>Pay follows each load&apos;s own assignment: per loaded mile, a set amount, hourly, or a percent of the rate confirmation. Hourly loads need their hours on the statement.</p>
      </Section>
      <Section title={`Drafts · ${drafts.length}`}>
        <DataTable id="settle-drafts" label="Draft statements" columns={STATEMENTS} rows={drafts.map((s) => statementRow(s, `Started ${shortDate(s.createdAt)}`))} empty={<EmptyState icon="invoices" title="No drafts" />} />
      </Section>
      <Section title={`Finalized · ${final.length}`}>
        <DataTable id="settle-final" label="Finalized statements" columns={STATEMENTS} rows={final.map((s) => statementRow(s, `Finalized ${shortDate(s.finalizedAt)}`))} empty={<EmptyState icon="invoices" title="Nothing finalized yet" />} />
      </Section>
      {voided.length > 0 ? (
        <Section title={`Voided · ${voided.length}`}>
          <DataTable id="settle-void" label="Voided statements" columns={STATEMENTS} rows={voided.map((s) => statementRow(s, `Voided ${shortDate(s.voidedAt)}`))} />
        </Section>
      ) : null}
    </>
  );
}

