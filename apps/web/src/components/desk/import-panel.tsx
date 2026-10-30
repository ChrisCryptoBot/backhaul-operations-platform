"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { commitImportAction, locateHomeBasesAction, previewImportAction } from "@/app/(desk)/actions";
import { importTemplate, problemsCsv, type ImportKind } from "@/lib/import-csv";
import type { ImportPreview, ImportResult } from "@/server/tl/import";
import { useToast } from "./kit/toast";

/**
 * Loading a fleet from a spreadsheet: choose a CSV, see what would be imported and what would not (every problem row, with its line number and the reason),
 * then import the rows that pass. The desk checks the file again when it imports, so what is written is what the server found, not what this screen was told.
 */
const PROBLEM_PAGE = 25;
const NOUN = { trucks: { one: "truck", many: "trucks", list: "/fleet", listLabel: "Trucks" }, drivers: { one: "driver", many: "drivers", list: "/drivers", listLabel: "Drivers" } } as const;

function save(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const n = (v: number) => v.toLocaleString("en-US");

export function ImportPanel({ kind, toLocate = 0 }: { kind: ImportKind; toLocate?: number }) {
  const router = useRouter();
  const toast = useToast();
  const words = NOUN[kind];
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = React.useState<Extract<ImportPreview, { ok: true }> | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"reading" | "importing" | null>(null);
  const [done, setDone] = React.useState<Extract<ImportResult, { ok: true }> | null>(null);
  const [page, setPage] = React.useState(1);
  const input = React.useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setError("");
    setDone(null);
    setPage(1);
    if (input.current) input.current.value = "";
  };

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setDone(null);
    setPreview(null);
    setPage(1);
    setBusy("reading");
    try {
      const text = await f.text();
      setFile({ name: f.name, text });
      const out = await previewImportAction(kind, text);
      if (out.ok) setPreview(out);
      else setError(out.error);
    } catch {
      setError("The desk could not read that file.");
    } finally {
      setBusy(null);
    }
  };

  const importNow = async () => {
    if (!file) return;
    setBusy("importing");
    try {
      const out = await commitImportAction(kind, file.text, file.name);
      if (out.ok) {
        setDone(out);
        toast({ text: `${n(out.created)} ${out.created === 1 ? words.one : words.many} imported.`, tone: "ok" });
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

  return (
    <>
      <section className="tl-card">
        <h2>1. Choose the file</h2>
        <p className="tl-sub" style={{ marginTop: 0 }}>
          A CSV (save it from your spreadsheet), one row per {words.one}, with a header row. Columns are matched by name, in any order; the template shows the names and what goes in each.
        </p>
        <div className="tl-form-row">
          <button type="button" className="tl-btn" onClick={() => save(`${kind}-template.csv`, importTemplate(kind))}>
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

      {preview && !done ? (
        <section className="tl-card" aria-live="polite">
          <h2>2. Check it</h2>
          <p style={{ margin: "0 0 var(--db-3)" }}>
            <b>{n(preview.total)}</b> {preview.total === 1 ? "row" : "rows"} read · <b>{n(preview.ready)}</b> will be imported ·{" "}
            <b className={preview.problemCount > 0 ? "neg" : undefined}>{n(preview.problemCount)}</b> left out
          </p>
          <p className="tl-sub">
            Read: {preview.matched.map((m) => m.field).join(", ")}.{preview.unknown.length > 0 ? ` Not used: ${preview.unknown.join(", ")}.` : ""}
          </p>
          {preview.problemCount > 0 ? (
            <>
              <div className="dt-wrap" style={{ maxHeight: "none" }}>
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
          <div className="tl-form-row" style={{ marginTop: "var(--db-4)" }}>
            <button type="button" className="tl-btn primary" disabled={preview.ready === 0 || busy === "importing"} aria-busy={busy === "importing" || undefined} onClick={() => void importNow()}>
              {busy === "importing" ? "Importing…" : `Import ${n(preview.ready)} ${preview.ready === 1 ? words.one : words.many}`}
            </button>
            {preview.problemCount > 0 ? (
              <button type="button" className="tl-btn" onClick={() => save(`${kind}-left-out.csv`, problemsCsv(preview.fileHeader, preview.problems))}>
                Download the rows left out
              </button>
            ) : null}
            <button type="button" className="tl-btn" onClick={reset}>
              Start over
            </button>
          </div>
          {preview.problemCount > 0 ? <p className="tl-sub">Rows left out are not imported. Fix them in the file (the download has the reason in front of each) and load it again; rows already imported are refused as copies.</p> : null}
        </section>
      ) : null}

      {done ? (
        <section className="tl-card" role="status">
          <h2>Done</h2>
          <p style={{ marginTop: 0 }}>
            {n(done.created)} {done.created === 1 ? words.one : words.many} imported{done.skipped > 0 ? `; ${n(done.skipped)} left out` : ""}. One entry in the audit log records it.
          </p>
          {kind === "trucks" ? <p className="tl-sub">A truck gets its cost profile on its own page, and is priced against the floor once it has one.</p> : null}
          <div className="tl-form-row">
            <Link className="tl-btn primary" href={words.list}>
              Go to {words.listLabel}
            </Link>
            <button type="button" className="tl-btn" onClick={reset}>
              Import another file
            </button>
          </div>
        </section>
      ) : null}

      {kind === "trucks" ? <LocateHomeBases pending={toLocate} /> : null}
    </>
  );
}

/** Home bases are found on the map afterwards, 25 trucks a request and five at a time, so a big import never waits on the map. */
function LocateHomeBases({ pending }: { pending: number }) {
  const router = useRouter();
  const [running, setRunning] = React.useState(false);
  const [progress, setProgress] = React.useState<{ tried: number; located: number; remaining: number } | null>(null);
  const stop = React.useRef(false);

  const run = async () => {
    stop.current = false;
    setRunning(true);
    let after: string | null = null;
    let tried = 0;
    let located = 0;
    try {
      for (;;) {
        const r = await locateHomeBasesAction(after);
        tried += r.tried;
        located += r.located;
        setProgress({ tried, located, remaining: r.remaining });
        if (!r.next || stop.current) break;
        after = r.next;
      }
    } finally {
      setRunning(false);
      router.refresh();
    }
  };

  const left = progress ? progress.remaining : pending;
  if (pending === 0 && !progress) return null;
  return (
    <section className="tl-card">
      <h2>Home bases</h2>
      <p className="tl-sub" style={{ marginTop: 0 }}>
        {n(left)} {left === 1 ? "truck has" : "trucks have"} a home base address that is not on the map yet. Finding them lets a quote measure each truck&apos;s empty miles from its own base.
        {progress ? ` Tried ${n(progress.tried)}, found ${n(progress.located)}.` : ""}
      </p>
      <div className="tl-form-row">
        <button type="button" className="tl-btn" disabled={running || left === 0} aria-busy={running || undefined} onClick={() => void run()}>
          {running ? "Finding…" : "Find home bases on the map"}
        </button>
        {running ? (
          <button type="button" className="tl-btn" onClick={() => (stop.current = true)}>
            Stop after this batch
          </button>
        ) : null}
      </div>
      {progress && !running && progress.tried > 0 && progress.located === 0 ? <p className="tl-note warn">None of those could be found. Check the map key is set, or the addresses.</p> : null}
    </section>
  );
}
