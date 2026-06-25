"use client";

import React from "react";
import type { AuditFilterOptions, AuditHistoryEntry, AuditLogPage } from "@/server/audit-read";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { HistoryIcon, SearchIcon } from "@/components/icons";

interface AuditBrowserProps {
  initialPage: AuditLogPage;
  filterOptions: AuditFilterOptions;
}

interface Filters {
  entityType: string;
  action: string;
  search: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: Filters = { entityType: "", action: "", search: "", from: "", to: "" };

function formatTime(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(parsed);
}

function actionKind(action: string): "create" | "update" | "delete" {
  if (/CREATE$/.test(action)) return "create";
  if (/DELETE$/.test(action)) return "delete";
  return "update";
}

function initials(name: string | null, id: string): string {
  const src = (name ?? "").trim();
  if (src) {
    const parts = src.split(/\s+/);
    const two = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
    return two || src.slice(0, 2).toUpperCase();
  }
  return (id || "?").slice(0, 2).toUpperCase();
}

function jsonLines(value: unknown): string[] {
  if (value === null || value === undefined) return ["—"];
  try {
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return [String(value)];
  }
}

const normLine = (line: string) => line.trim().replace(/,$/, "");

/** Render a JSON blob line-by-line, tinting lines that differ from `other`. */
function DiffPre({ value, other, kind }: { value: unknown; other: unknown; kind: "add" | "del" }) {
  const lines = jsonLines(value);
  const otherSet = new Set(jsonLines(other).map(normLine));
  return (
    <pre className="db-diff-pre">
      {lines.map((line, i) => {
        const norm = normLine(line);
        const changed = norm.length > 0 && norm !== "{" && norm !== "}" && !otherSet.has(norm);
        return (
          <span key={i} className={`db-diff-line${changed ? ` ${kind}` : ""}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </pre>
  );
}

export function AuditBrowser({ initialPage, filterOptions }: AuditBrowserProps) {
  const [entries, setEntries] = React.useState<AuditHistoryEntry[]>(initialPage.entries);
  const [cursor, setCursor] = React.useState<string | null>(initialPage.nextCursor);
  const [applied, setApplied] = React.useState<Filters>(EMPTY_FILTERS);

  const [entityType, setEntityType] = React.useState("");
  const [action, setAction] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");

  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<AuditHistoryEntry | null>(null);

  async function runQuery(filters: Filters, append: boolean) {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.entityType) params.set("entityType", filters.entityType);
      if (filters.action) params.set("action", filters.action);
      if (filters.search.trim()) params.set("search", filters.search.trim());
      if (filters.from) params.set("from", new Date(`${filters.from}T00:00:00`).toISOString());
      if (filters.to) params.set("to", new Date(`${filters.to}T23:59:59.999`).toISOString());
      if (append && cursor) params.set("cursor", cursor);
      params.set("limit", "50");

      const response = await fetch(`/api/audit?${params.toString()}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as AuditLogPage | { error?: string } | null;
      if (!response.ok || !payload || !("entries" in payload)) {
        throw new Error((payload as { error?: string } | null)?.error ?? "Failed to load the audit log.");
      }
      setEntries((previous) => (append ? [...previous, ...payload.entries] : payload.entries));
      setCursor(payload.nextCursor);
      if (!append) setApplied(filters);
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : "Failed to load the audit log.");
    } finally {
      setBusy(false);
    }
  }

  function onApply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void runQuery({ entityType, action, search, from, to }, false);
  }

  function onClear() {
    setEntityType("");
    setAction("");
    setSearch("");
    setFrom("");
    setTo("");
    void runQuery(EMPTY_FILTERS, false);
  }

  const hasFilters = Boolean(applied.entityType || applied.action || applied.search || applied.from || applied.to);

  return (
    <div className="db-ref">
      <div className="db-ref-body">
        <div className="db-ref-head">
          <div>
            <h2 className="db-ref-h">Audit log</h2>
            <div className="db-ref-desc">Every change to loads, reference data, and settings — who changed what, when, and why. Read-only.</div>
          </div>
          <div className="db-ref-actions">
            <span className="db-ro-chip"><HistoryIcon size={13} /> Append-only</span>
          </div>
        </div>

        <form className="db-aud-filters" onSubmit={onApply}>
          <label className="db-field-label">
            Entity type
            <select className="db-input" value={entityType} onChange={(event) => setEntityType(event.target.value)}>
              <option value="">All entities</option>
              {filterOptions.entityTypes.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="db-field-label">
            Action
            <select className="db-input" value={action} onChange={(event) => setAction(event.target.value)}>
              <option value="">All actions</option>
              {filterOptions.actions.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))}
            </select>
          </label>
          <label className="db-field-label">
            From
            <input type="date" className="db-input" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="db-field-label">
            To
            <input type="date" className="db-input" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label className="db-field-label grow">
            Search
            <div className="db-prefix-input">
              <span className="pfx"><SearchIcon size={13} /></span>
              <input className="db-input" value={search} placeholder="entity id, action, or reason" onChange={(event) => setSearch(event.target.value)} />
            </div>
          </label>
          <div className="acts">
            <button type="submit" className="db-btn primary" disabled={busy}>{busy ? "Loading…" : "Apply"}</button>
            <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={onClear}>Clear</button>
          </div>
        </form>

        {error ? <p className="db-upload-error">{error}</p> : null}

        {entries.length === 0 ? (
          <EmptyState
            icon={<SearchIcon size={22} />}
            title={hasFilters ? "No entries match" : "No audit entries"}
            copy={hasFilters ? "No changes match these filters. Try widening the date range or clearing the search." : "No changes have been recorded yet."}
            action={hasFilters ? { label: "Clear filters", onClick: onClear } : undefined}
          />
        ) : (
          <>
            <div className="db-aud-count">
              Showing {entries.length} entr{entries.length === 1 ? "y" : "ies"}{cursor ? " · more available" : ""} · newest first
            </div>
            <div className="db-card-table">
              <table className="db-table">
                <thead>
                  <tr>
                    <th style={{ width: 170 }}>When</th>
                    <th style={{ width: 200 }}>Entity</th>
                    <th style={{ width: 240 }}>Action</th>
                    <th style={{ width: 180 }}>Actor</th>
                    <th>Reason</th>
                    <th className="right" style={{ width: 70 }}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => (
                    <tr key={entry.id} className={`db-row${index % 2 ? " odd" : ""}`}>
                      <td className="mono dim" style={{ whiteSpace: "nowrap" }}>{formatTime(entry.timestamp)}</td>
                      <td>
                        <span className="db-ent">
                          <span className="db-ent-type">{entry.entityType}</span>
                          <span className="db-ent-id">{entry.entityId}</span>
                        </span>
                      </td>
                      <td>
                        <span className="db-act-verb">
                          <span className={`db-act-dot ${actionKind(entry.action)}`} />
                          <span className="db-act-code">{entry.action}</span>
                        </span>
                      </td>
                      <td>
                        <span className="db-actor">
                          <span className="db-actor-av">{initials(entry.actorName, entry.actorId)}</span>
                          {entry.actorName ?? entry.actorId}
                        </span>
                      </td>
                      <td className="dim trunc" style={{ maxWidth: 220 }} title={entry.reason ?? undefined}>
                        {entry.reason ?? <span className="faint">—</span>}
                      </td>
                      <td className="right">
                        <button type="button" className="db-btn db-btn-ghost" onClick={() => setDetail(entry)}>View</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {cursor ? (
              <div className="db-loadmore">
                <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={() => void runQuery(applied, true)}>
                  {busy ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
          </>
        )}
      </div>

      {detail ? (
        <Modal
          eyebrow="Audit detail"
          title={detail.action}
          ariaLabel={`Audit detail for ${detail.action}`}
          width="xwide"
          onClose={() => setDetail(null)}
          footer={
            <button type="button" className="db-btn db-btn-ghost" onClick={() => setDetail(null)}>Close</button>
          }
        >
          <div className="db-diff-meta">
            <div>
              <div className="k">Entity</div>
              <div className="v"><span className="db-ent-type">{detail.entityType}</span> <span className="mono dim">{detail.entityId}</span></div>
            </div>
            <div>
              <div className="k">Actor</div>
              <div className="v"><span className="db-actor"><span className="db-actor-av">{initials(detail.actorName, detail.actorId)}</span>{detail.actorName ?? detail.actorId}</span></div>
            </div>
            <div>
              <div className="k">When</div>
              <div className="v mono">{formatTime(detail.timestamp)}</div>
            </div>
            <div>
              <div className="k">Reason</div>
              <div className="v">{detail.reason ?? "—"}</div>
            </div>
          </div>
          <div className="db-diff-grid">
            <div>
              <div className="db-diff-col-h">Before</div>
              <DiffPre value={detail.beforeValue} other={detail.afterValue} kind="del" />
            </div>
            <div>
              <div className="db-diff-col-h" style={{ color: "var(--db-pos)" }}>After</div>
              <DiffPre value={detail.afterValue} other={detail.beforeValue} kind="add" />
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
