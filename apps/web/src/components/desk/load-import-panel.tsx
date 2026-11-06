"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { commitLoadImportAction, previewLoadImportAction, removeLoadImportAction } from "@/app/(desk)/actions";
import { problemsCsv } from "@/lib/import-csv";
import { FIELD_OF, LOAD_FIELDS, loadImportTemplate, type LoadFieldKey } from "@/lib/load-import";
import type { LoadImportBatch, LoadImportPreview, LoadImportResult } from "@/server/tl/load-import";
import { usd } from "@/lib/desk-format";
import { useToast } from "./kit/toast";

/**
 * Loading finished loads from a spreadsheet or a TMS export, in four steps on one page: choose the file, confirm which column is which (the desk guesses from the headers; any match can be changed), check what would
 * be imported and what would not, then import. The desk checks the file again when it imports, so what is written is what the server found. An import can be taken away again from the list below.
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

type Ok = Extract<LoadImportPreview, { ok: true }>;
type Map = Record<LoadFieldKey, number | null>;

export function LoadImportPanel({ recent }: { recent: LoadImportBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = React.useState<Ok | null>(null);
  const [map, setMap] = React.useState<Map | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"reading" | "importing" | null>(null);
  const [done, setDone] = React.useState<Extract<LoadImportResult, { ok: true }> | null>(null);
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

  // Check the file against a match (null: the desk's own guess). The latest answer wins when a person changes several columns quickly.
  const check = React.useCallback(async (text: string, m: Map | null) => {
    const mine = ++seq.current;
    setBusy("reading");
    try {
      const out = await previewLoadImportAction(text, m);
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

  const setColumn = (key: LoadFieldKey, at: number | null) => {
    if (!file || !map) return;
    // A file column feeds one field: choosing it here takes it from the field that had it.
    const next: Map = { ...map, [key]: at };
    if (at != null) for (const f of LOAD_FIELDS) if (f.key !== key && next[f.key] === at) next[f.key] = null;
    setMap(next);
    void check(file.text, next);
  };

  const importNow = async () => {
    if (!file || !map) return;
    setBusy("importing");
    try {
      const out = await commitLoadImportAction(file.text, map, file.name);
      if (out.ok) {
        setDone(out);
        toast({ text: `${n(out.created)} ${out.created === 1 ? "load" : "loads"} imported.`, tone: "ok" });
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
          A CSV (save it from your spreadsheet or export it from your TMS), one row per finished load, with a header row. The desk matches the columns by their names; you confirm the match in the next step.
        </p>
        <div className="tl-form-row">
          <button type="button" className="tl-btn" onClick={() => save("loads-template.csv", loadImportTemplate())}>
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
              Each of the desk&apos;s fields reads one column of your file. Required fields are marked; leave the others on &quot;not in the file&quot; when you do not have them.
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
                {LOAD_FIELDS.map((f) => {
                  const at = map[f.key];
                  return (
                    <tr key={f.key}>
                      <td>
                        <b>{f.label}</b>
                        {f.required ? <span className="dim"> required</span> : null}
                        {FIELD_OF[f.key].hint ? <span className="sub">{FIELD_OF[f.key].hint}</span> : null}
                      </td>
                      <td>
                        <label className="db-sr-only" htmlFor={`lm-${f.key}`}>{`Column for ${f.label}`}</label>
                        <select id={`lm-${f.key}`} value={at == null ? "" : String(at)} onChange={(e) => setColumn(f.key, e.target.value === "" ? null : Number(e.target.value))} aria-invalid={f.required && at == null ? true : undefined}>
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
                  <b>{n(preview.total)}</b> {preview.total === 1 ? "row" : "rows"} read · <b>{n(preview.ready)}</b> will be imported · <b>{n(preview.duplicates)}</b> already on the desk or twice in the file ·{" "}
                  <b className={preview.problemCount > 0 ? "neg" : undefined}>{n(preview.problemCount)}</b> left out for a problem
                </p>
                {preview.ready > 0 ? (
                  <>
                    <p className="tl-sub">
                      {usd(preview.summary.revenue)} of revenue over {n(preview.summary.miles)} loaded miles, delivered {preview.summary.first} to {preview.summary.last}. {n(preview.summary.paid)} paid, {n(preview.summary.invoiced - preview.summary.paid)} invoiced, {n(preview.summary.notBilled)} with no billing in the file
                      {preview.summary.notBilled > 0 ? " (recent ones will show as ready to invoice)" : ""}.
                      {preview.summary.truckNames > 0 ? ` ${n(preview.summary.truckNames)} truck ${preview.summary.truckNames === 1 ? "name is" : "names are"} not on the desk: those loads are imported with no truck.` : ""}
                    </p>
                    <div className="dt-wrap" style={{ maxHeight: "none" }}>
                      <table className="dt" aria-label="The first loads, as they will land">
                        <thead>
                          <tr>
                            <th scope="col">Load</th>
                            <th scope="col">Customer</th>
                            <th scope="col">Lane</th>
                            <th scope="col">Delivered</th>
                            <th scope="col" className="num">Miles</th>
                            <th scope="col" className="num">Revenue</th>
                            <th scope="col">Truck</th>
                            <th scope="col">Billing</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample.map((s) => (
                            <tr key={s.line}>
                              <td>{s.loadNumber}</td>
                              <td>{s.customer ?? <span className="dim">—</span>}</td>
                              <td>{s.lane}</td>
                              <td>{s.delivered}</td>
                              <td className="num">{n(s.miles)}</td>
                              <td className="num">{usd(s.revenue)}</td>
                              <td>{s.truck ?? <span className="dim">—</span>}</td>
                              <td>{s.billing}</td>
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
              Each row becomes a <b>finished load</b> marked as imported, with its customer, lane, miles, rate and, when the file has them, its truck, invoice and payment. It has <b>no driver</b> (so it never lands on a driver&apos;s pay statement), <b>no stops</b>,
              and <b>no frozen floor</b>, because today&apos;s cost profile is not what the truck cost on that day: the Leak ledger counts its empty miles and says they are not priced. Nothing is looked up on the map. The whole import can be removed again from the list below.
            </p>
            <div className="tl-form-row">
              <button type="button" className="tl-btn primary" disabled={blocked || preview.ready === 0 || busy != null} aria-busy={busy === "importing" || undefined} onClick={() => void importNow()}>
                {busy === "importing" ? "Importing…" : `Import ${n(preview.ready)} ${preview.ready === 1 ? "load" : "loads"}`}
              </button>
              {preview.problemCount > 0 ? (
                <button type="button" className="tl-btn" onClick={() => save("loads-left-out.csv", problemsCsv(preview.fileHeader, preview.problems))}>
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
            {n(done.created)} {done.created === 1 ? "load" : "loads"} imported{done.duplicates > 0 ? `; ${n(done.duplicates)} already on the desk` : ""}
            {done.skipped > 0 ? `; ${n(done.skipped)} left out` : ""}
            {done.withoutTruck > 0 ? `; ${n(done.withoutTruck)} with a truck name the desk does not have` : ""}. One entry in the audit log records it.
          </p>
          <div className="tl-form-row">
            <Link className="tl-btn primary" href="/loads?view=history">
              Go to the loads
            </Link>
            <Link className="tl-btn" href="/kpi?period=all">
              KPI dashboard
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

/** The imports done on this desk, with a button to take one away. */
function Earlier({ recent }: { recent: LoadImportBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sure, setSure] = React.useState<string | null>(null);
  if (recent.length === 0) return null;
  const remove = async (id: string) => {
    setBusy(id);
    try {
      const out = await removeLoadImportAction(id);
      toast({ text: out.ok ? `${n(out.removed)} imported ${out.removed === 1 ? "load" : "loads"} removed.` : out.error, tone: out.ok ? "ok" : "bad" });
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
            <th scope="col" className="num">On the desk now</th>
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
              <td className="num">{n(b.loads)}</td>
              <td>
                {b.loads === 0 ? (
                  <span className="dim">{b.removed ? "removed" : "none left"}</span>
                ) : sure === b.batchId ? (
                  <>
                    <button type="button" className="tl-btn sm" disabled={busy === b.batchId} onClick={() => void remove(b.batchId)}>
                      {busy === b.batchId ? "Removing…" : `Remove ${n(b.loads)} loads`}
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
      <p className="tl-sub">Removing an import deletes its loads the way any deleted load is deleted: each can still be restored from the Deleted loads list.</p>
    </section>
  );
}
