"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { clearIftaRatesAction, commitIftaRatesAction, loadSampleIftaRatesAction, previewIftaRatesAction } from "@/app/(desk)/actions";
import { IFTA_RATE_FIELDS, iftaRateTemplate, RATE_STATUS_LABEL, type IftaRateFieldKey, type IftaRateStatus } from "@/lib/ifta-rates-csv";
import { problemsCsv } from "@/lib/import-csv";
import type { IftaRateKept, IftaRatePreview } from "@/server/partners/ifta-rates";
import { useToast } from "./kit/toast";

/**
 * Loading a quarter's IFTA tax rates from a file (Wave 5 step 4): choose the file and whether it is provisional or final, confirm which column is which, check every row, then replace the
 * quarter's rates with it. The desk reads the file again when it imports. Sample rates for a demo and clearing a quarter sit underneath.
 */
const n = (v: number) => v.toLocaleString("en-US");

function save(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

type Ok = Extract<IftaRatePreview, { ok: true }>;
type Map = Record<IftaRateFieldKey, number | null>;

export function IftaRatesPanel({ quarter, kept }: { quarter: string; kept: IftaRateKept }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [status, setStatus] = React.useState<IftaRateStatus>("provisional");
  const [preview, setPreview] = React.useState<Ok | null>(null);
  const [map, setMap] = React.useState<Map | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"reading" | "importing" | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const seq = React.useRef(0);

  const reset = () => {
    setFile(null);
    setPreview(null);
    setMap(null);
    setError("");
    if (input.current) input.current.value = "";
  };

  const check = React.useCallback(
    async (text: string, m: Map | null, st: IftaRateStatus) => {
      const mine = ++seq.current;
      setBusy("reading");
      try {
        const out = await previewIftaRatesAction(text, m, quarter, st);
        if (mine !== seq.current) return;
        if (out.ok) {
          setPreview(out);
          setMap(out.map);
          setError("");
        } else {
          setPreview(null);
          setError(out.error);
        }
      } catch {
        if (mine === seq.current) setError("The desk could not read that file.");
      } finally {
        if (mine === seq.current) setBusy(null);
      }
    },
    [quarter]
  );

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setPreview(null);
    setMap(null);
    try {
      const text = await f.text();
      setFile({ name: f.name, text });
      await check(text, null, status);
    } catch {
      setError("The desk could not read that file.");
    }
  };

  const setColumn = (key: IftaRateFieldKey, at: number | null) => {
    if (!file || !map) return;
    const next: Map = { ...map, [key]: at };
    if (at != null) for (const f of IFTA_RATE_FIELDS) if (f.key !== key && next[f.key] === at) next[f.key] = null;
    setMap(next);
    void check(file.text, next, status);
  };

  const changeStatus = (st: IftaRateStatus) => {
    setStatus(st);
    if (file) void check(file.text, map, st);
  };

  const importNow = async () => {
    if (!file || !map) return;
    setBusy("importing");
    try {
      const out = await commitIftaRatesAction(file.text, map, quarter, status, file.name);
      if (out.ok) {
        toast({ text: `${n(out.created)} ${out.created === 1 ? "rate" : "rates"} kept for ${quarter}.`, tone: "ok" });
        reset();
        router.refresh();
      } else setError(out.error);
    } catch {
      setError("The import did not finish. The quarter's rates are unchanged; try again.");
    } finally {
      setBusy(null);
    }
  };

  const blocked = preview ? preview.missing.length > 0 : true;
  const replaces = preview?.replaces ?? kept;

  return (
    <div className="fimp irate">
      <section className="tl-card">
        <h2>Import {quarter}&apos;s rate table</h2>
        <p className="tl-sub fimp-lead">
          A CSV with a header row and one row per jurisdiction: its diesel rate in US dollars a gallon, and its surcharge if it has one. Importing <b>replaces every rate kept for {quarter}</b>, so a
          state the file leaves out has no rate afterwards.
        </p>
        <div className="tl-form-row">
          <button type="button" className="tl-btn" onClick={() => save("ifta-rates-template.csv", iftaRateTemplate())}>
            Download the template
          </button>
          <label className="tl-btn primary fimp-file">
            {file ? "Choose another file" : "Choose a CSV file"}
            <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
          </label>
          <label className="irate-status">
            <span className="tl-sub">These rates are</span>
            <select value={status} onChange={(e) => changeStatus(e.target.value === "final" ? "final" : "provisional")}>
              <option value="provisional">{RATE_STATUS_LABEL.provisional}</option>
              <option value="final">{RATE_STATUS_LABEL.final}</option>
            </select>
          </label>
          {file ? <span className="tl-sub">{file.name}</span> : null}
        </div>
        <p className="tl-sub">A Status column in the file, when it has one, decides row by row; this choice fills the rows it leaves blank.</p>
        {busy === "reading" ? (
          <p className="tl-note" role="status">
            Reading the file…
          </p>
        ) : null}
        {error ? (
          <p className="tl-note warn" role="alert">
            {error}
          </p>
        ) : null}

        {preview && map ? (
          <>
            <h3>Match the columns</h3>
            {preview.missing.length > 0 ? <p className="tl-sub neg">Still needed: {preview.missing.map((m) => m.label).join(", ")}.</p> : null}
            <table className="tl-table" aria-label="Column match">
              <thead>
                <tr>
                  <th scope="col">The desk&apos;s field</th>
                  <th scope="col">Your column</th>
                  <th scope="col">What the first row says</th>
                </tr>
              </thead>
              <tbody>
                {IFTA_RATE_FIELDS.map((f) => {
                  const at = map[f.key];
                  return (
                    <tr key={f.key}>
                      <td>
                        <b>{f.label}</b>
                        {f.required ? <span className="dim"> required</span> : null}
                        {f.hint ? <span className="sub">{f.hint}</span> : null}
                      </td>
                      <td>
                        <label className="db-sr-only" htmlFor={`irm-${f.key}`}>{`Column for ${f.label}`}</label>
                        <select id={`irm-${f.key}`} value={at == null ? "" : String(at)} onChange={(e) => setColumn(f.key, e.target.value === "" ? null : Number(e.target.value))} aria-invalid={f.required && at == null ? true : undefined}>
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

            {blocked ? null : (
              <div aria-live="polite">
                <h3>Check it</h3>
                <p className="fimp-count">
                  <b>{n(preview.total)}</b> {preview.total === 1 ? "row" : "rows"} read · <b>{n(preview.ready)}</b> US {preview.ready === 1 ? "rate" : "rates"} to keep ({n(preview.summary.withSurcharge)} with a surcharge) · <b>{n(preview.canada)}</b> Canadian skipped ·{" "}
                  <b>{n(preview.duplicates)}</b> repeated · <b className={preview.problemCount > 0 ? "neg" : undefined}>{n(preview.problemCount)}</b> left out for a problem
                </p>
                {preview.notInFile.length > 0 && preview.ready > 0 ? (
                  <p className="tl-note warn">
                    Not in the file, so no rate for {quarter} after the import: {preview.notInFile.join(", ")}. A return with miles in one of them cannot be worked out until it has a rate.
                  </p>
                ) : null}
                {preview.problemCount > 0 ? (
                  <div className="dt-wrap fimp-wrap fimp-gap">
                    <table className="dt" aria-label="Rows left out">
                      <thead>
                        <tr>
                          <th scope="col">Line</th>
                          <th scope="col">What is wrong</th>
                          <th scope="col">The row</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.problems.map((p) => (
                          <tr key={p.line}>
                            <td className="num">{p.line}</td>
                            <td className="fimp-why">
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
                ) : null}
                {preview.ready > 0 ? (
                  <div className="dt-wrap fimp-wrap fimp-gap irate-preview">
                    <table className="dt" aria-label="The rates as they will be kept">
                      <thead>
                        <tr>
                          <th scope="col">Jurisdiction</th>
                          <th scope="col" className="num">Rate ($/gal)</th>
                          <th scope="col" className="num">Surcharge ($/gal)</th>
                          <th scope="col">Status</th>
                          <th scope="col" className="num">Line</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rates.map((r) => (
                          <tr key={r.jurisdiction}>
                            <td>
                              <b>{r.jurisdiction}</b> <span className="dim">{r.name}</span>
                            </td>
                            <td className="num">${r.rate}</td>
                            <td className="num">{r.surcharge === "0.0000" ? <span className="dim">—</span> : `$${r.surcharge}`}</td>
                            <td>{RATE_STATUS_LABEL[r.status]}</td>
                            <td className="num dim">{r.surchargeLine != null && r.surchargeLine !== r.line ? `${r.line} + ${r.surchargeLine}` : r.line}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}
              </div>
            )}

            <div className="tl-form-row fimp-gap">
              <button type="button" className="tl-btn primary" disabled={blocked || preview.ready === 0 || busy != null} aria-busy={busy === "importing" || undefined} onClick={() => void importNow()}>
                {busy === "importing" ? "Importing…" : replaces.count > 0 ? `Replace ${quarter}'s ${n(replaces.count)} ${replaces.sample > 0 ? "sample " : ""}rates with ${n(preview.ready)}` : `Keep ${n(preview.ready)} ${preview.ready === 1 ? "rate" : "rates"} for ${quarter}`}
              </button>
              {preview.problemCount > 0 ? (
                <button type="button" className="tl-btn" onClick={() => save("ifta-rates-left-out.csv", problemsCsv(preview.fileHeader, preview.problems))}>
                  Download the rows left out
                </button>
              ) : null}
              <button type="button" className="tl-btn" onClick={reset}>
                Start over
              </button>
            </div>
          </>
        ) : null}
      </section>

      <QuarterTools quarter={quarter} kept={kept} />
    </div>
  );
}

function QuarterTools({ quarter, kept }: { quarter: string; kept: IftaRateKept }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<"sample" | "clear" | null>(null);
  const [sure, setSure] = React.useState(false);
  const real = kept.count - kept.sample;

  const sample = async () => {
    setBusy("sample");
    try {
      const out = await loadSampleIftaRatesAction(quarter);
      toast({ text: out.ok ? `${n(out.created)} sample rates loaded for ${quarter}: not for filing.` : out.error, tone: out.ok ? "ok" : "bad" });
      if (out.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  };
  const clear = async () => {
    setBusy("clear");
    try {
      const out = await clearIftaRatesAction(quarter);
      toast({ text: out.ok ? `${n(out.removed)} ${out.removed === 1 ? "rate" : "rates"} cleared from ${quarter}.` : out.error, tone: out.ok ? "ok" : "bad" });
      setSure(false);
      if (out.ok) router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="tl-card">
      <h2>For a demo, or to start again</h2>
      <div className="tl-form-row">
        {real === 0 ? (
          <button type="button" className="tl-btn" disabled={busy != null} onClick={() => void sample()}>
            {busy === "sample" ? "Loading…" : kept.sample > 0 ? "Load the sample rates again" : "Load sample rates"}
          </button>
        ) : null}
        {kept.count > 0 ? (
          sure ? (
            <>
              <button type="button" className="tl-btn" disabled={busy != null} onClick={() => void clear()}>
                {busy === "clear" ? "Clearing…" : `Clear all ${n(kept.count)} rates`}
              </button>
              <button type="button" className="tl-btn ghost" onClick={() => setSure(false)}>
                Keep them
              </button>
            </>
          ) : (
            <button type="button" className="tl-btn ghost" onClick={() => setSure(true)}>
              Clear {quarter}&apos;s rates
            </button>
          )
        ) : null}
      </div>
      <p className="tl-sub">
        {real === 0
          ? "Sample rates are made up so a demo has something to multiply by: every row says sample, not for filing. They never replace rates from a file; a real rate table replaces them."
          : "Sample rates are offered only for a quarter with no rates from a file. Clearing takes every rate of the quarter away; the audit log keeps what was there."}
      </p>
    </section>
  );
}
