"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { commitHistoryImportAction, previewHistoryImportAction, removeHistoryImportAction } from "@/app/(desk)/actions";
import { problemsCsv } from "@/lib/import-csv";
import { WEEK_FIELDS, WEEK_FIELD_OF, weekImportTemplate, type WeekFieldKey } from "@/lib/tracker-import";
import type { HistoryBatch, HistoryImportPreview, HistoryImportResult } from "@/server/tl/tracker-import";
import { usd } from "@/lib/desk-format";
import { useToast } from "./kit/toast";

/**
 * Loading a carrier's weekly tracker (one row per lane per week) as imported history: choose the file, confirm which column is which, check every row, import. The rows are kept apart from loads and shown
 * as "imported history" on the KPI page; they are never turned into loads. The desk checks the file again when it imports. An import can be taken away whole from the list below.
 */
const PROBLEM_PAGE = 25;
const n = (v: number) => v.toLocaleString("en-US");

function save(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type Ok = Extract<HistoryImportPreview, { ok: true }>;
type Map = Record<WeekFieldKey, number | null>;

export function TrackerImportPanel({ recent }: { recent: HistoryBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = React.useState<Ok | null>(null);
  const [map, setMap] = React.useState<Map | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"reading" | "importing" | null>(null);
  const [done, setDone] = React.useState<Extract<HistoryImportResult, { ok: true }> | null>(null);
  const [page, setPage] = React.useState(1);
  const input = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setMap(null);
    setError("");
    setDone(null);
    setPage(1);
    if (input.current) input.current.value = "";
  };

  const check = React.useCallback(async (text: string, m: Map | null) => {
    const mine = ++seq.current;
    setBusy("reading");
    try {
      const out = await previewHistoryImportAction(text, m);
      if (mine !== seq.current) return;
      if (out.ok) {
        setPreview(out);
        setMap(out.map);
        setError("");
        setPage(1);
      } else {
        setPreview(null);
        setError(out.error);
      }
    } catch {
      if (mine === seq.current) setError("The desk could not read that file.");
    } finally {
      if (mine === seq.current) setBusy(null);
    }
  }, []);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setDone(null);
    setPreview(null);
    setMap(null);
    try {
      const text = await f.text();
      setFile({ name: f.name, text });
      await check(text, null);
    } catch {
      setError("The desk could not read that file.");
    }
  };

  const setColumn = (key: WeekFieldKey, at: number | null) => {
    if (!file || !map) return;
    const next: Map = { ...map, [key]: at };
    if (at != null) for (const f of WEEK_FIELDS) if (f.key !== key && next[f.key] === at) next[f.key] = null;
    setMap(next);
    void check(file.text, next);
  };

  const importNow = async () => {
    if (!file || !map) return;
    setBusy("importing");
    try {
      const out = await commitHistoryImportAction(file.text, map, file.name);
      if (out.ok) {
        setDone(out);
        toast({ text: `${n(out.created)} lane-${out.created === 1 ? "week" : "weeks"} imported.`, tone: "ok" });
        router.refresh();
      } else setError(out.error);
    } catch {
      setError("The import did not finish. Nothing was added; try again.");
    } finally {
      setBusy(null);
    }
  };

  const pages = preview ? Math.max(1, Math.ceil(preview.problems.length / PROBLEM_PAGE)) : 1;
  const shown = preview ? preview.problems.slice((page - 1) * PROBLEM_PAGE, page * PROBLEM_PAGE) : [];
  const blocked = preview ? preview.missing.length > 0 : true;

  return (
    <>
      <section className="tl-card">
        <h2>1. Choose the file</h2>
        <p className="tl-sub" style={{ marginTop: 0 }}>
          A CSV saved from your weekly tracker: one row per lane per week, with a header row (the week, the lane, how many loads, the line haul, the loaded miles, and the fuel surcharge and empty miles if you keep them).
        </p>
        <div className="tl-form-row">
          <button type="button" className="tl-btn" onClick={() => save("weekly-tracker-template.csv", weekImportTemplate())}>
            Download the template
          </button>
          <label className="tl-btn primary" style={{ cursor: "pointer" }}>
            {file ? "Choose another file" : "Choose a CSV file"}
            <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} style={{ position: "absolute", width: 1, height: 1, opacity: 0 }} />
          </label>
          {file ? <span className="tl-sub">{file.name}</span> : null}
        </div>
        {busy === "reading" ? <p className="tl-note" role="status">Reading the file…</p> : null}
        {error ? (
          <p className="tl-note warn" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {preview && map && !done ? (
        <>
          <section className="tl-card">
            <h2>2. Match the columns</h2>
            <p className="tl-sub" style={{ marginTop: 0 }}>
              Each field reads one column of your file. Leave the optional ones on &quot;not in the file&quot; when you do not keep them.
              {preview.missing.length > 0 ? <b className="neg"> Still needed: {preview.missing.map((m) => m.label).join(", ")}.</b> : null}
            </p>
            <table className="tl-table" aria-label="Column match">
              <thead>
                <tr>
                  <th scope="col">The desk&apos;s field</th>
                  <th scope="col">Your column</th>
                  <th scope="col">What the first row says</th>
                </tr>
              </thead>
              <tbody>
                {WEEK_FIELDS.map((f) => {
                  const at = map[f.key];
                  return (
                    <tr key={f.key}>
                      <td>
                        <b>{f.label}</b>
                        {f.required ? <span className="dim"> required</span> : null}
                        {WEEK_FIELD_OF[f.key].hint ? <span className="sub">{WEEK_FIELD_OF[f.key].hint}</span> : null}
                      </td>
                      <td>
                        <label className="db-sr-only" htmlFor={`tm-${f.key}`}>{`Column for ${f.label}`}</label>
                        <select id={`tm-${f.key}`} value={at == null ? "" : String(at)} onChange={(e) => setColumn(f.key, e.target.value === "" ? null : Number(e.target.value))} aria-invalid={f.required && at == null ? true : undefined}>
                          <option value="">{f.required ? "Choose a column" : "not in the file"}</option>
                          {preview.fileHeader.map((h, i) => (
                            <option key={i} value={i}>
                              {h.trim() === "" ? `Column ${i + 1}` : h}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="dim">{at == null ? "" : (preview.firstRow[at] ?? "")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="tl-card" aria-live="polite">
            <h2>3. Check it</h2>
            {blocked ? (
              <p className="tl-sub">Match the required columns above and the rows are checked here.</p>
            ) : (
              <>
                <p style={{ margin: "0 0 var(--db-3)" }}>
                  <b>{n(preview.total)}</b> {preview.total === 1 ? "row" : "rows"} read · <b>{n(preview.ready)}</b> will be imported · <b>{n(preview.duplicates)}</b> already imported or twice in the file ·{" "}
                  <b className={preview.problemCount > 0 ? "neg" : undefined}>{n(preview.problemCount)}</b> left out for a problem
                </p>
                {preview.ready > 0 ? (
                  <>
                    <p className="tl-sub">
                      {n(preview.summary.loads)} loads and {usd(preview.summary.revenue)} of revenue over {n(preview.summary.weeks)} {preview.summary.weeks === 1 ? "week" : "weeks"} ({preview.summary.first} to {preview.summary.last}) on {n(preview.summary.lanes)} {preview.summary.lanes === 1 ? "lane" : "lanes"}.
                    </p>
                    <div className="dt-wrap" style={{ maxHeight: "none" }}>
                      <table className="dt" aria-label="The first rows, as they will land">
                        <thead>
                          <tr>
                            <th scope="col">Week of (Monday)</th>
                            <th scope="col">Lane</th>
                            <th scope="col" className="num">Loads</th>
                            <th scope="col" className="num">Revenue</th>
                            <th scope="col" className="num">Loaded miles</th>
                            <th scope="col" className="num">Empty miles</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample.map((s) => (
                            <tr key={s.line}>
                              <td>{s.week}</td>
                              <td>{s.lane}</td>
                              <td className="num">{n(s.loads)}</td>
                              <td className="num">{usd(s.revenue)}</td>
                              <td className="num">{n(s.loadedMiles)}</td>
                              <td className="num">{n(s.emptyMiles)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
                {preview.problemCount > 0 ? (
                  <>
                    <div className="dt-wrap" style={{ maxHeight: "none", marginTop: "var(--db-3)" }}>
                      <table className="dt" aria-label="Rows left out">
                        <thead>
                          <tr>
                            <th scope="col">Line</th>
                            <th scope="col">What is wrong</th>
                            <th scope="col">The row</th>
                          </tr>
                        </thead>
                        <tbody>
                          {shown.map((p) => (
                            <tr key={p.line}>
                              <td className="num">{p.line}</td>
                              <td style={{ whiteSpace: "normal", minWidth: 320 }}>
                                {p.errors.map((e) => (
                                  <div key={e}>{e}</div>
                                ))}
                              </td>
                              <td className="dim">{p.cells.filter((c) => c.trim() !== "").slice(0, 4).join(" · ")}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <nav className="pager" aria-label="Rows left out, pages">
                      {page > 1 ? (
                        <button type="button" className="tl-btn sm" onClick={() => setPage(page - 1)}>
                          Previous
                        </button>
                      ) : null}
                      <span>
                        {(page - 1) * PROBLEM_PAGE + 1}–{Math.min(page * PROBLEM_PAGE, preview.problems.length)} of {n(preview.problems.length)}
                        {preview.problemCount > preview.problems.length ? ` shown (${n(preview.problemCount)} in all)` : ""}
                      </span>
                      {page < pages ? (
                        <button type="button" className="tl-btn sm" onClick={() => setPage(page + 1)}>
                          Next
                        </button>
                      ) : null}
                    </nav>
                  </>
                ) : null}
              </>
            )}
          </section>

          <section className="tl-card">
            <h2>4. Import</h2>
            <p className="tl-sub" style={{ marginTop: 0 }}>
              Each row becomes a lane&apos;s week in <b>imported history</b>. It is <b>not turned into loads</b>, and it is <b>never added to a figure built from loads</b>: it is shown on the KPI page under its own heading so your past weeks can be read
              beside the desk&apos;s own. Weeks are counted Monday to Sunday. The whole import can be removed again from the list below.
            </p>
            <div className="tl-form-row">
              <button type="button" className="tl-btn primary" disabled={blocked || preview.ready === 0 || busy != null} aria-busy={busy === "importing" || undefined} onClick={() => void importNow()}>
                {busy === "importing" ? "Importing…" : `Import ${n(preview.ready)} lane-${preview.ready === 1 ? "week" : "weeks"}`}
              </button>
              {preview.problemCount > 0 ? (
                <button type="button" className="tl-btn" onClick={() => save("weekly-left-out.csv", problemsCsv(preview.fileHeader, preview.problems))}>
                  Download the rows left out
                </button>
              ) : null}
              <button type="button" className="tl-btn" onClick={reset}>
                Start over
              </button>
            </div>
          </section>
        </>
      ) : null}

      {done ? (
        <section className="tl-card" role="status">
          <h2>Done</h2>
          <p style={{ marginTop: 0 }}>
            {n(done.created)} lane-{done.created === 1 ? "week" : "weeks"} imported{done.duplicates > 0 ? `; ${n(done.duplicates)} already imported` : ""}
            {done.skipped > 0 ? `; ${n(done.skipped)} left out` : ""}. One entry in the audit log records it.
          </p>
          <div className="tl-form-row">
            <Link className="tl-btn primary" href="/kpi?period=all">
              See it on the KPI page
            </Link>
            <button type="button" className="tl-btn" onClick={reset}>
              Import another file
            </button>
          </div>
        </section>
      ) : null}

      <Earlier recent={recent} />
    </>
  );
}

function Earlier({ recent }: { recent: HistoryBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sure, setSure] = React.useState<string | null>(null);
  if (recent.length === 0) return null;
  const remove = async (id: string) => {
    setBusy(id);
    try {
      const out = await removeHistoryImportAction(id);
      toast({ text: out.ok ? `${n(out.removed)} lane-${out.removed === 1 ? "week" : "weeks"} removed.` : out.error, tone: out.ok ? "ok" : "bad" });
      setSure(null);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="tl-card">
      <h2>Earlier imports</h2>
      <table className="tl-table" aria-label="Earlier imports">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">What</th>
            <th scope="col" className="num">Rows now</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {recent.map((b) => (
            <tr key={b.batchId}>
              <td>{b.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</td>
              <td>
                {b.summary}
                <span className="sub">by {b.actor}</span>
              </td>
              <td className="num">{n(b.rows)}</td>
              <td>
                {b.rows === 0 ? (
                  <span className="dim">{b.removed ? "removed" : "none left"}</span>
                ) : sure === b.batchId ? (
                  <>
                    <button type="button" className="tl-btn sm" disabled={busy === b.batchId} onClick={() => void remove(b.batchId)}>
                      {busy === b.batchId ? "Removing…" : `Remove ${n(b.rows)} rows`}
                    </button>{" "}
                    <button type="button" className="tl-btn ghost sm" onClick={() => setSure(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="tl-btn ghost sm" onClick={() => setSure(b.batchId)}>
                    Remove this import
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="tl-sub">Removing an import deletes its rows from the imported history. They are copies of your spreadsheet, so the file is still the original.</p>
    </section>
  );
}
