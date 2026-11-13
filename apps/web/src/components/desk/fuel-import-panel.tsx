"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { commitFuelImportAction, previewFuelImportAction, removeFuelImportAction } from "@/app/(desk)/actions";
import { gallons, usd } from "@/lib/desk-format";
import { FUEL_FIELDS, FUEL_FIELD_OF, fuelImportTemplate, type FuelFieldKey } from "@/lib/fuel-csv";
import { PRODUCT_LABEL, STATUS_LABEL, type FuelProduct, type FuelStatus } from "@/lib/fuel-normalize";
import { problemsCsv } from "@/lib/import-csv";
import type { FuelBatch, FuelImportPreview, FuelImportResult } from "@/server/partners/fuel-import";
import { useToast } from "./kit/toast";

/**
 * Loading fuel purchases from a CSV (Wave 5 step 2): choose the file, confirm which column is which, check every row, import. Each purchase is read like a card company's (state, product,
 * status), kept once, and tied to its truck and load. The desk checks the file again when it imports. A whole file can be taken away from the list below, unless a purchase from it is on a
 * driver statement.
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

type Ok = Extract<FuelImportPreview, { ok: true }>;
type Map = Record<FuelFieldKey, number | null>;

export function FuelImportPanel({ recent }: { recent: FuelBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [file, setFile] = React.useState<{ name: string; text: string } | null>(null);
  const [preview, setPreview] = React.useState<Ok | null>(null);
  const [map, setMap] = React.useState<Map | null>(null);
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState<"reading" | "importing" | null>(null);
  const [done, setDone] = React.useState<Extract<FuelImportResult, { ok: true }> | null>(null);
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
      const out = await previewFuelImportAction(text, m);
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

  const setColumn = (key: FuelFieldKey, at: number | null) => {
    if (!file || !map) return;
    const next: Map = { ...map, [key]: at };
    if (at != null) for (const f of FUEL_FIELDS) if (f.key !== key && next[f.key] === at) next[f.key] = null;
    setMap(next);
    void check(file.text, next);
  };

  const importNow = async () => {
    if (!file || !map) return;
    setBusy("importing");
    try {
      const out = await commitFuelImportAction(file.text, map, file.name);
      if (out.ok) {
        setDone(out);
        toast({ text: `${n(out.created)} fuel ${out.created === 1 ? "purchase" : "purchases"} imported.`, tone: "ok" });
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
  const split = preview
    ? (Object.entries(preview.summary.gallons) as Array<[FuelProduct, number]>)
        .filter(([, g]) => g > 0)
        .map(([p, g]) => `${gallons(g)} gal ${p === "def" ? PRODUCT_LABEL[p] : PRODUCT_LABEL[p].toLowerCase()}`)
        .join(" · ")
    : "";
  const w = preview?.warnings;

  return (
    <div className="fimp">
      <section className="tl-card">
        <h2>1. Choose the file</h2>
        <p className="tl-sub fimp-lead">
          A CSV of fuel purchases with a header row: a card company&apos;s transaction export, or your own fuel log. One row per purchase, with at least the date and what was charged; the truck (or the card account), where it was bought, the product and the gallons make it count for fuel tax.
        </p>
        <div className="tl-form-row">
          <button type="button" className="tl-btn" onClick={() => save("fuel-purchases-template.csv", fuelImportTemplate())}>
            Download the template
          </button>
          <label className="tl-btn primary fimp-file">
            {file ? "Choose another file" : "Choose a CSV file"}
            <input ref={input} type="file" accept=".csv,text/csv" onChange={(e) => void choose(e.target.files?.[0])} />
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
            <p className="tl-sub fimp-lead">
              Each field reads one column of your file. Leave the optional ones on &quot;not in the file&quot; when the file does not have them.
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
                {FUEL_FIELDS.map((f) => {
                  const at = map[f.key];
                  return (
                    <tr key={f.key}>
                      <td>
                        <b>{f.label}</b>
                        {f.required ? <span className="dim"> required</span> : null}
                        {FUEL_FIELD_OF[f.key].hint ? <span className="sub">{FUEL_FIELD_OF[f.key].hint}</span> : null}
                      </td>
                      <td>
                        <label className="db-sr-only" htmlFor={`fm-${f.key}`}>{`Column for ${f.label}`}</label>
                        <select id={`fm-${f.key}`} value={at == null ? "" : String(at)} onChange={(e) => setColumn(f.key, e.target.value === "" ? null : Number(e.target.value))} aria-invalid={f.required && at == null ? true : undefined}>
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
                <p className="fimp-count">
                  <b>{n(preview.total)}</b> {preview.total === 1 ? "row" : "rows"} read · <b>{n(preview.ready)}</b> will be imported · <b>{n(preview.duplicates)}</b> already on the desk or twice in the file ·{" "}
                  <b className={preview.problemCount > 0 ? "neg" : undefined}>{n(preview.problemCount)}</b> left out for a problem
                </p>
                {preview.ready > 0 ? (
                  <>
                    <p className="tl-sub">
                      {n(preview.summary.purchases)} settled {preview.summary.purchases === 1 ? "purchase" : "purchases"}, {usd(preview.summary.charged, 2)} charged{split ? ` (${split})` : ""}, in {n(preview.summary.states)} {preview.summary.states === 1 ? "state" : "states"}, {preview.summary.first} to {preview.summary.last}.
                      {preview.summary.notCounted > 0 ? ` ${n(preview.summary.notCounted)} pending, declined or reversed: kept, not counted.` : ""}
                    </p>
                    {w && (w.noTruck > 0 || w.noState > 0 || w.noProduct > 0) ? (
                      <p className="tl-note warn">
                        Kept, but worth a look:{" "}
                        {[w.noTruck > 0 ? `${n(w.noTruck)} not tied to a truck` : null, w.noState > 0 ? `${n(w.noState)} with no state read` : null, w.noProduct > 0 ? `${n(w.noProduct)} with no product` : null].filter(Boolean).join(" · ")}. Fuel tax cannot credit a purchase with no state, and one with no truck is on no driver&apos;s statement.
                      </p>
                    ) : null}
                    <div className="dt-wrap fimp-wrap">
                      <table className="dt" aria-label="The first rows, as they will land">
                        <thead>
                          <tr>
                            <th scope="col">Date</th>
                            <th scope="col">Truck</th>
                            <th scope="col">Where</th>
                            <th scope="col">State</th>
                            <th scope="col">Product</th>
                            <th scope="col">Status</th>
                            <th scope="col" className="num">Gallons</th>
                            <th scope="col" className="num">Charged</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.sample.map((s) => (
                            <tr key={s.line}>
                              <td>{s.on}</td>
                              <td>{s.truck ?? <span className="t-st" data-tone="warn">no truck</span>}</td>
                              <td>{s.where ?? <span className="dim">—</span>}</td>
                              <td>{s.state ?? <span className="t-st" data-tone="warn">not said</span>}</td>
                              <td>{PRODUCT_LABEL[s.product]}</td>
                              <td>{STATUS_LABEL[s.status as FuelStatus]}</td>
                              <td className="num">{gallons(s.gallons)}</td>
                              <td className="num">{usd(s.amount, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                ) : null}
                {preview.problemCount > 0 ? (
                  <>
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
                          {shown.map((p) => (
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
            <p className="tl-sub fimp-lead">
              Each row becomes a fuel purchase on the Fuel screen, read exactly like one from a card company and tied to its truck and the load it was bought on. Only settled purchases count in the
              totals, on driver statements and for fuel tax. A purchase already on the desk is not added again. The whole import can be removed again from the list below.
            </p>
            <div className="tl-form-row">
              <button type="button" className="tl-btn primary" disabled={blocked || preview.ready === 0 || busy != null} aria-busy={busy === "importing" || undefined} onClick={() => void importNow()}>
                {busy === "importing" ? "Importing…" : `Import ${n(preview.ready)} ${preview.ready === 1 ? "purchase" : "purchases"}`}
              </button>
              {preview.problemCount > 0 ? (
                <button type="button" className="tl-btn" onClick={() => save("fuel-left-out.csv", problemsCsv(preview.fileHeader, preview.problems))}>
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
          <p className="fimp-lead">
            {n(done.created)} fuel {done.created === 1 ? "purchase" : "purchases"} imported{done.duplicates > 0 ? `; ${n(done.duplicates)} already on the desk` : ""}
            {done.updated > 0 ? `; ${n(done.updated)} moved on (status)` : ""}
            {done.skipped > 0 ? `; ${n(done.skipped)} left out` : ""}. One entry in the audit log records it.
          </p>
          <div className="tl-form-row">
            <Link className="tl-btn primary" href="/fuel?days=90">
              See it on Fuel
            </Link>
            <button type="button" className="tl-btn" onClick={reset}>
              Import another file
            </button>
          </div>
        </section>
      ) : null}

      <Earlier recent={recent} />
    </div>
  );
}

function Earlier({ recent }: { recent: FuelBatch[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [sure, setSure] = React.useState<string | null>(null);
  if (recent.length === 0) return null;
  const remove = async (id: string) => {
    setBusy(id);
    try {
      const out = await removeFuelImportAction(id);
      toast({ text: out.ok ? `${n(out.removed)} fuel ${out.removed === 1 ? "purchase" : "purchases"} removed.` : out.error, tone: out.ok ? "ok" : "bad" });
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
            <th scope="col" className="num">Purchases now</th>
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
                ) : b.deducted > 0 ? (
                  <span className="t-st" data-tone="warn">
                    {n(b.deducted)} on a driver statement
                  </span>
                ) : sure === b.batchId ? (
                  <>
                    <button type="button" className="tl-btn sm" disabled={busy === b.batchId} onClick={() => void remove(b.batchId)}>
                      {busy === b.batchId ? "Removing…" : `Remove ${n(b.rows)} purchases`}
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
      <p className="tl-sub">Removing an import deletes its purchases from the desk. It is refused while one of them is deducted on a driver statement: void that statement first.</p>
    </section>
  );
}
