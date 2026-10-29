import Link from "next/link";
import React from "react";
import { ALERT_DEFAULTS, LEVEL_LABEL, RULES } from "@/lib/alerts";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";

const TONE = { block: "bad", warn: "warn", info: "info" } as const;

const COLUMNS: Column[] = [
  { key: "level", label: "Level", sticky: true, width: 110 },
  { key: "rule", label: "Rule" },
  { key: "applies", label: "Applies to" },
  { key: "when", label: "When it fires" }
];

export default function RulesPage() {
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
      when: r.trigger(ALERT_DEFAULTS)
    }
  }));

  return (
    <>
      <PageHead title="Alert rules" sub="How the alerts are decided. Block means fix it before the load goes out, warn means look soon, info is for your information.">
        <Link href="/alerts" className="tl-btn">See the alerts</Link>
      </PageHead>
      <DataTable id="rules-table" label="Alert rules" columns={COLUMNS} rows={rows} />
      <p className="tl-note" style={{ marginTop: 12, maxWidth: 72 + "ch" }}>
        The timings are fixed in this version: {ALERT_DEFAULTS.pickupHours} hours before a pickup, {ALERT_DEFAULTS.sentNoAnswerHours} hours waiting for an answer, {ALERT_DEFAULTS.clearanceDays} days before a card lapses.
        Assigning a driver who is already on another load at the same time is refused unless you give a reason, and the reason goes in the audit log.
      </p>
    </>
  );
}
