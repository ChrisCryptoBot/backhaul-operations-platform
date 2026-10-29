import Link from "next/link";
import React from "react";
import { listAudit } from "@/server/tl/audit";
import { ACTION_LABEL, ACTION_TONE, AUDIT_GROUPS, diffSnapshots } from "@/lib/audit-diff";
import { PageHead, Tabs } from "@/components/desk/ui";
import { DataTable, type Column, type Row } from "@/components/desk/data-table";
import { DiffButton } from "@/components/desk/audit-diff-button";
import { EmptyState } from "@/components/desk/kit/states";
import { dateTime } from "@/lib/desk-format";

const COLUMNS: Column[] = [
  { key: "when", label: "When", sticky: true, width: 170 },
  { key: "load", label: "Load" },
  { key: "what", label: "What" },
  { key: "summary", label: "Detail" },
  { key: "reason", label: "Reason" },
  { key: "by", label: "By" },
  { key: "more", label: "", align: "num" }
];

export default async function AuditPage({ searchParams }: { searchParams?: { q?: string; group?: string; page?: string } }) {
  const q = searchParams?.q?.trim() ?? "";
  const group = AUDIT_GROUPS.find((g) => g.key === searchParams?.group)?.key ?? "";
  const page = Math.max(1, Number.parseInt(searchParams?.page ?? "1", 10) || 1);
  const { rows: events, total, all, pageSize } = await listAudit({ q, group, page });

  const href = (over: { group?: string; page?: number }) => {
    const p = new URLSearchParams();
    const g = over.group ?? group;
    if (q) p.set("q", q);
    if (g) p.set("group", g);
    if ((over.page ?? 1) > 1) p.set("page", String(over.page));
    const s = p.toString();
    return s ? `/audit?${s}` : "/audit";
  };

  const rows: Row[] = events.map((e) => ({
    id: e.id,
    cells: {
      when: dateTime(e.createdAt),
      load: e.loadId && e.loadNumber ? <Link href={`/loads/${e.loadId}`}>{e.loadNumber}</Link> : <span className="dim">{e.loadNumber ?? "—"}</span>,
      what: <span className={`tl-chip ${ACTION_TONE[e.action] ?? "muted"}`}>{ACTION_LABEL[e.action] ?? e.action}</span>,
      summary: e.summary,
      reason: e.reason ? <>“{e.reason}”</> : <span className="dim">—</span>,
      by: e.actor,
      more:
        e.before || e.after ? (
          <DiffButton title={ACTION_LABEL[e.action] ?? e.action} eyebrow={`${e.loadNumber ?? "Load"} · ${dateTime(e.createdAt)}`} rows={diffSnapshots(e.before, e.after)} reason={e.reason} />
        ) : null
    }
  }));

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <>
      <PageHead title="Audit log" sub="Every assignment, send, answer, invoice and payment, with who did it and why. Events are only ever added." />
      <div className="dt-toolbar" style={{ marginBottom: 12 }}>
        <form method="get" className="dt-search" style={{ display: "flex", flex: "0 1 360px" }}>
          <input type="search" name="q" defaultValue={q} placeholder="Search load, detail or reason…" aria-label="Search the audit log" autoComplete="off" style={{ flex: 1 }} />
          {group ? <input type="hidden" name="group" value={group} /> : null}
          <button type="submit" className="tl-btn sm">Search</button>
        </form>
        <Tabs active={group || "all"} hrefFor={(k) => href({ group: k === "all" ? "" : k })} items={[{ key: "all", label: "All" }, ...AUDIT_GROUPS.map((g) => ({ key: g.key, label: g.label }))]} />
        <span className="dt-spacer" />
        <span className="dt-count">{total === all ? `${all} events` : `${total} of ${all} events`}</span>
      </div>
      <DataTable id="audit-table" label="Audit log" columns={COLUMNS} rows={rows} empty={<EmptyState icon="history" title={q || group ? "Nothing matches" : "Nothing recorded yet"}>{q || group ? "Try a different word, or clear the filter." : "Assign a driver, send a load or create an invoice and it appears here."}</EmptyState>} />
      {total > pageSize ? (
        <div className="pager">
          {page > 1 ? <Link className="tl-btn sm" href={href({ page: page - 1 })}>Newer</Link> : null}
          <span>{from}–{to} of {total}</span>
          {to < total ? <Link className="tl-btn sm" href={href({ page: page + 1 })}>Older</Link> : null}
        </div>
      ) : null}
    </>
  );
}
