import Link from "next/link";
import React from "react";
import { currentTerminal } from "@/server/tl/terminal";
import { COMPLIANCE_FILTERS, listTrailersPage } from "@/server/tl/trailers";
import { Pager } from "@/components/desk/pager";
import { asPage, nextSortParam } from "@/lib/paging";
import { PageHead } from "@/components/desk/ui";
import { DataTable, type Column, type Row, type SortHref } from "@/components/desk/data-table";
import { LiveForm } from "@/components/desk/live-form";
import { AddTrailer, TrailerRowActions } from "@/components/desk/trailer-forms";
import { EmptyState } from "@/components/desk/kit/states";
import { OWNERSHIPS } from "@/lib/trailer-forms";
import { TRAILER_STATUSES, statusLabel } from "@/lib/trailer-clearance";
import { TRAILER_TYPES, trailerLabel } from "@/truelane/constants/trailerData";
import { shortDate } from "@/lib/desk-format";

export const metadata = { title: "Trailers · TrueLane" };

export const dynamic = "force-dynamic";

const COLUMNS: Column[] = [
  { key: "number", sortable: true, label: "Trailer", group: "Trailer", sticky: true, width: 170 },
  { key: "type", sortable: true, label: "Type", group: "Trailer" },
  { key: "plate", label: "Plate", group: "Trailer" },
  { key: "ownership", label: "Ownership", group: "Trailer" },
  { key: "status", sortable: true, label: "Status", group: "Where it is" },
  { key: "terminal", sortable: true, label: "Terminal", group: "Where it is" },
  { key: "hooked", label: "Hooked to", group: "Where it is" },
  { key: "now", label: "On now", group: "Where it is" },
  { key: "registration", sortable: true, label: "Registration", group: "Compliance" },
  { key: "inspection", sortable: true, label: "Inspection", group: "Compliance" },
  { key: "act", label: "", group: "" }
];

type Params = { q?: string; sort?: string; page?: string; type?: string; status?: string; ownership?: string; compliance?: string; archived?: string };

/** The trailer registry, a page at a time: search by number, plate or VIN, and filter by type, state, ownership, compliance and terminal (the header's). */
export default async function TrailersPage({ searchParams }: { searchParams?: Params }) {
  const terminal = await currentTerminal();
  const type = TRAILER_TYPES.some((t) => t.value === searchParams?.type) ? searchParams?.type : undefined;
  const status = TRAILER_STATUSES.some((s) => s.key === searchParams?.status) ? searchParams?.status : undefined;
  const ownership = OWNERSHIPS.some((o) => o.key === searchParams?.ownership) ? searchParams?.ownership : undefined;
  const compliance = (COMPLIANCE_FILTERS as readonly string[]).includes(searchParams?.compliance ?? "") ? searchParams?.compliance : undefined;
  const archived = searchParams?.archived === "1";
  const data = await listTrailersPage({ q: searchParams?.q, sort: searchParams?.sort, page: asPage(searchParams?.page), terminal, type, status, ownership, compliance, archived });
  const now = new Date();
  const sortParam = searchParams?.sort ? { key: data.sort.key as string, dir: data.sort.dir } : null;
  const href = (p: { sort?: string | null; page?: number }) => {
    const u = new URLSearchParams();
    if (data.q) u.set("q", data.q);
    if (type) u.set("type", type);
    if (status) u.set("status", status);
    if (ownership) u.set("ownership", ownership);
    if (compliance) u.set("compliance", compliance);
    if (archived) u.set("archived", "1");
    if (p.sort) u.set("sort", p.sort);
    if (p.page && p.page > 1) u.set("page", String(p.page));
    const s = u.toString();
    return s ? `/trailers?${s}` : "/trailers";
  };
  const sortHref: SortHref = (key) => ({ href: href({ sort: nextSortParam(sortParam, key) }), dir: sortParam?.key === key ? (sortParam.dir === "asc" ? "asc" : "desc") : "none" });
  const expiry = (d: Date | null, lapsed: boolean) => (d ? <span className={lapsed ? "tone-neg" : ""}>{shortDate(d)}{lapsed ? " · lapsed" : ""}</span> : <span className="dim">—</span>);

  const rows: Row[] = data.rows.map((t) => ({
    id: t.id,
    flag: t.blocker && !t.archived ? "bad" : undefined,
    search: [t.number, t.plate].filter(Boolean).join(" "),
    cells: {
      number: (
        <>
          <Link href={`/trailers/${t.id}`}><b>{t.number}</b></Link>
          {t.archived ? <span className="sub"><span className="tl-chip muted">Archived</span></span> : t.compliance !== "ok" ? <span className="sub"><span className={`tl-chip ${t.compliance === "lapsed" ? "bad" : "warn"}`}>{t.compliance === "lapsed" ? "Papers lapsed" : "Papers due soon"}</span></span> : null}
        </>
      ),
      type: t.type ? trailerLabel(t.type) : <span className="dim">—</span>,
      plate: t.plate ? `${t.plate}${t.plateState ? ` · ${t.plateState}` : ""}` : <span className="dim">—</span>,
      ownership: OWNERSHIPS.find((o) => o.key === t.ownership)?.label ?? t.ownership,
      status: t.status === "available" ? statusLabel(t.status) : <span className="tl-chip warn">{statusLabel(t.status)}</span>,
      terminal: t.terminal ?? <span className="dim">—</span>,
      hooked: t.hookedTo ?? <span className="dim">—</span>,
      now:
        t.onLoads.length === 0 ? (
          <span className="dim">—</span>
        ) : (
          t.onLoads.map((l) => (
            <div key={l.id}>
              <Link href={`/loads/${l.id}`}>{l.loadNumber ?? "A load"}</Link>
            </div>
          ))
        ),
      registration: expiry(t.registrationExpiry, t.registrationExpiry != null && t.registrationExpiry.getTime() < now.getTime()),
      inspection: expiry(t.inspectionExpiry, t.inspectionExpiry != null && t.inspectionExpiry.getTime() < now.getTime()),
      act: <TrailerRowActions trailer={{ id: t.id, number: t.number, archived: t.archived, open: t.onLoads.length }} />
    }
  }));
  const filtered = Boolean(data.q || type || status || ownership || compliance || archived);

  return (
    <>
      <PageHead title="Trailers" sub={`${terminal ? `${terminal} terminal. ` : ""}Every trailer: its number, plate and papers, where it is, which tractor pulls it and what it is on. A trailer in the shop, out of service or with a lapsed date is kept off loads.`}>
        <a className="tl-btn" href={`/export/trailers${filtered ? `?${href({}).split("?")[1] ?? ""}` : ""}`}>Export CSV</a>
        <Link href="/trailers/import" className="tl-btn">Import from a file</Link>
        <AddTrailer />
      </PageHead>
      <div className="dt-toolbar" style={{ margin: "12px 0" }}>
        <LiveForm path="/trailers" label="Filter the trailers" className="audit-filters">
          <input type="search" name="q" defaultValue={data.q} placeholder="Search number, plate or VIN…" aria-label="Search the trailers" autoComplete="off" className="audit-q" />
          <select name="type" defaultValue={type ?? ""} aria-label="Type">
            <option value="">Any type</option>
            {TRAILER_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <select name="status" defaultValue={status ?? ""} aria-label="Status">
            <option value="">Any status</option>
            {TRAILER_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
          <select name="ownership" defaultValue={ownership ?? ""} aria-label="Ownership">
            <option value="">Any ownership</option>
            {OWNERSHIPS.map((o) => (
              <option key={o.key} value={o.key}>{o.label}</option>
            ))}
          </select>
          <select name="compliance" defaultValue={compliance ?? ""} aria-label="Papers">
            <option value="">Any papers</option>
            <option value="lapsed">Lapsed</option>
            <option value="soon">Due soon</option>
            <option value="ok">All good</option>
          </select>
          <label className="dlg-check" style={{ whiteSpace: "nowrap" }}>
            <input type="checkbox" name="archived" value="1" defaultChecked={archived} /> Archived
          </label>
          {filtered ? <Link href="/trailers" className="tl-btn ghost sm" replace>Clear</Link> : null}
        </LiveForm>
        <span className="dt-spacer" />
        <span className="dt-count">{data.total.toLocaleString("en-US")} {data.total === 1 ? "trailer" : "trailers"}</span>
      </div>
      <DataTable id="trailers-table" label="Trailers" columns={COLUMNS} rows={rows} sortHref={sortHref} empty={<EmptyState icon="trailers" title={filtered ? "No trailer matches" : "No trailers yet"}>{filtered ? "Try another word or filter, or clear them." : "Add one, or import a spreadsheet of them."}</EmptyState>} />
      <Pager page={data.page} pageSize={data.pageSize} total={data.total} hrefFor={(n) => href({ sort: searchParams?.sort, page: n })} newer="Previous" older="Next" />
    </>
  );
}
