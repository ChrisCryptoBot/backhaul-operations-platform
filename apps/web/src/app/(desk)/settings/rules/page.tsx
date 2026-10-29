import Link from "next/link";
import React from "react";
import { LEVEL_LABEL, RULES } from "@/lib/alerts";
import { alertThresholds } from "@/lib/thresholds";
import { getThresholds } from "@/server/tl/thresholds";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";

const TONE = { block: "bad", warn: "warn", info: "info" } as const;

const COLUMNS: Column[] = [
  { key: "level", label: "Level", sticky: true, width: 110 },
  { key: "rule", label: "Rule" },
  { key: "applies", label: "Applies to" },
  { key: "when", label: "When it fires" }
];

export default async function RulesPage() {
  const t = alertThresholds(await getThresholds());
  const rows: Row[] = RULES.map((r) => ({
    id: r.code,
    cells: {
      level: <span className={`tl-chip ${TONE[r.level]}`}>{LEVEL_LABEL[r.level]}</span>,
      rule: (
        <>
          <b>{r.title}</b>
          <span className="sub">{r.code}</span>
        </>
      ),
      applies: r.appliesTo,
      when: r.trigger(t)
    }
  }));

  return (
    <>
      <PageHead title="Alert rules" sub="How the alerts are decided. Block means fix it before the load goes out, warn means look soon, info is for your information.">
        <Link href="/alerts" className="tl-btn">See the alerts</Link>
        <Link href="/settings" className="tl-btn">Change the timings</Link>
      </PageHead>
      <DataTable id="rules-table" label="Alert rules" columns={COLUMNS} rows={rows} />
      <p className="tl-note" style={{ marginTop: 12, maxWidth: "72ch" }}>
        The timings come from Settings: {t.pickupHours} hours before a pickup, {t.sentNoAnswerHours} hours waiting for an answer, {t.clearanceDays} days before a card lapses.
        Assigning a driver who is already on another load at the same time is refused unless you give a reason, and the reason goes in the audit log.
      </p>
    </>
  );
}
