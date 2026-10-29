"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { discardSettlementAction, finalizeSettlementAction, saveSettlementAction, startSettlementAction, voidSettlementAction } from "@/app/(desk)/actions";
import { shortDate, usd } from "@/lib/desk-format";
import { computeStatement, MAX_ADJUSTMENTS, validatePeriod, type AdjustmentInput, type PeriodPreset, type SettlementLoad } from "@/lib/settlement";
import { ConfirmDialog, Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

function Fld({ label, error, hint, children }: { label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="tl-field">
      {label}
      {children}
      {error ? (
        <span className="th-err" role="alert">
          {error}
        </span>
      ) : hint ? (
        <span className="th-hint">{hint}</span>
      ) : null}
    </label>
  );
}

// ── Start a statement ──────────────────────────────────────────────────────────────────────────

/** Pick a driver and a period (or one of the usual ones); the statement opens as a draft with every delivered load in it that is not already paid. */
export function StartStatement({ drivers, presets, initial, label = "Start a statement", primary = true }: { drivers: Array<{ id: string; name: string }>; presets: PeriodPreset[]; initial?: { driverId?: string; start?: string; end?: string }; label?: string; primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [driverId, setDriverId] = React.useState(initial?.driverId ?? drivers[0]?.id ?? "");
  const [start, setStart] = React.useState(initial?.start ?? presets[0]?.start ?? "");
  const [end, setEnd] = React.useState(initial?.end ?? presets[0]?.end ?? "");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function go() {
    const p = validatePeriod(start, end);
    if (!p.ok) {
      setErrors(p.errors);
      return;
    }
    setBusy(true);
    const out = await startSettlementAction({ driverId, start: p.start, end: p.end });
    setBusy(false);
    if (out.ok) {
      setOpen(false);
      router.push(`/settlements/${out.id}`);
    } else {
      setErrors(out.errors ?? {});
      setMessage(out.error ?? null);
    }
  }

  return (
    <>
      <button
        type="button"
        className={`tl-btn ${primary ? "primary" : "sm"}`}
        onClick={() => {
          setErrors({});
          setMessage(null);
          setOpen(true);
        }}>
        {label}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Driver pay"
        title="Start a statement"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || drivers.length === 0} aria-busy={busy || undefined} onClick={() => void go()}>
              {busy ? "Starting…" : "Start the statement"}
            </button>
          </>
        }>
        <div className="dlg-form">
          <p className="tl-note">It lists the loads the driver delivered in the period that are not already paid on another statement. You add hours, deductions and extras before you finalize it.</p>
          <Fld label="Driver" error={errors.driverId}>
            <select value={driverId} onChange={(e) => setDriverId(e.target.value)}>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Fld>
          <div className="dlg-row" role="group" aria-label="Usual periods">
            {presets.map((p) => (
              <button
                key={p.key}
                type="button"
                className="tl-btn sm"
                aria-pressed={start === p.start && end === p.end}
                onClick={() => {
                  setStart(p.start);
                  setEnd(p.end);
                  setErrors({});
                }}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="dlg-two">
            <Fld label="First day" error={errors.start} hint="Dallas calendar, delivered on or after.">
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Fld>
            <Fld label="Last day" error={errors.end} hint="Delivered on or before.">
              <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Fld>
          </div>
        </div>
      </Modal>
    </>
  );
}

// ── The draft ──────────────────────────────────────────────────────────────────────────────────

const BROKER: Record<string, string> = { paid: "Broker paid", invoiced: "Invoice out", not_invoiced: "Not invoiced" };

/** The draft: each load with what it pays, hours for hourly loads, adjustments, and the total as you type, with the same sums the server freezes. */
export function SettlementEditor({ id, number, driverName, loads, initialHours, initialAdjustments }: { id: string; number: string; driverName: string; loads: SettlementLoad[]; initialHours: Record<string, string>; initialAdjustments: AdjustmentInput[] }) {
  const router = useRouter();
  const toast = useToast();
  const [hours, setHours] = React.useState(initialHours);
  const [rows, setRows] = React.useState<AdjustmentInput[]>(initialAdjustments.length > 0 ? initialAdjustments : [{ label: "", amount: "" }]);
  const [tried, setTried] = React.useState(false);
  const [busy, setBusy] = React.useState<null | "save" | "finalize" | "discard">(null);
  const [confirm, setConfirm] = React.useState<null | "finalize" | "discard">(null);
  const [message, setMessage] = React.useState<string | null>(null);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});

  const st = computeStatement({ loads, hours, adjustments: rows });
  const errors = { ...(tried ? st.errors : {}), ...serverErrors };
  const draft = { hours, adjustments: rows };
  const setRow = (i: number, patch: Partial<AdjustmentInput>) => setRows((r) => r.map((x, k) => (k === i ? { ...x, ...patch } : x)));

  async function save(then?: () => void) {
    setTried(true);
    if (Object.keys(st.errors).length > 0) return setMessage("Fix what is marked, then save.");
    setBusy("save");
    const out = await saveSettlementAction(id, draft);
    setBusy(null);
    if (out.ok) {
      setServerErrors({});
      setMessage(null);
      toast({ text: "Draft saved.", tone: "ok" });
      then?.();
      router.refresh();
    } else {
      setServerErrors(out.errors ?? {});
      setMessage(out.error ?? "Fix what is marked, then save.");
    }
  }

  async function finalize() {
    setTried(true);
    setConfirm(null);
    setBusy("finalize");
    const out = await finalizeSettlementAction(id, draft);
    setBusy(null);
    if (out.ok) {
      toast({ text: `${number} finalized for ${usd(st.total, 2)}.`, tone: "ok" });
      router.refresh();
    } else {
      setServerErrors(out.errors ?? {});
      setMessage(out.error ?? "That could not be finalized.");
    }
  }

  async function discard() {
    setConfirm(null);
    setBusy("discard");
    const out = await discardSettlementAction(id);
    setBusy(null);
    if (out.ok) {
      toast({ text: `Draft ${number} discarded.`, tone: "ok" });
      router.push("/settlements");
    } else setMessage(out.error ?? "That could not be discarded.");
  }

  return (
    <>
      <section className="tl-card">
        <h2>{`Loads · ${loads.length}`}</h2>
        {loads.length === 0 ? (
          <p className="tl-note">No delivered loads in this period are left to pay. Anything delivered later goes on the next statement.</p>
        ) : (
          <table className="tl-table">
            <thead>
              <tr>
                <th>Load</th>
                <th>Delivered</th>
                <th>How it is worked out</th>
                <th>Hours</th>
                <th className="num">Pay</th>
              </tr>
            </thead>
            <tbody>
              {st.lines.map((l, i) => {
                const src = loads[i]!;
                const err = errors[`hours.${l.loadId}`];
                return (
                  <tr key={l.loadId}>
                    <td>
                      <Link href={`/loads/${l.loadId}`}>{l.loadNumber ?? "—"}</Link>
                      <div className="tl-sub">{l.lane}</div>
                    </td>
                    <td>
                      {l.deliveredAt ? shortDate(new Date(l.deliveredAt)) : "—"}
                      <div className="tl-sub">{BROKER[l.brokerStatus]}</div>
                    </td>
                    <td>{l.basis}</td>
                    <td style={{ width: 130 }}>
                      {l.payKind === "hourly" ? (
                        <label>
                          <span className="db-sr-only">Hours for {l.loadNumber}</span>
                          <input inputMode="decimal" value={hours[l.loadId] ?? ""} placeholder={src.assignedHours != null ? String(src.assignedHours) : "hours"} onChange={(e) => setHours((h) => ({ ...h, [l.loadId]: e.target.value }))} aria-invalid={err ? true : undefined} style={{ width: 100 }} />
                          {err ? (
                            <span className="th-err" role="alert">
                              {err}
                            </span>
                          ) : null}
                        </label>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="num">{l.amount == null ? <span className="dim">needs hours</span> : usd(l.amount, 2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="tl-card">
        <h2>Adjustments</h2>
        <p className="tl-note" style={{ marginBottom: 10 }}>For anything that is not a load: an advance, a fuel card charge, a reimbursement, a bonus, a share of detention. A deduction is a negative amount, for example -100.</p>
        {rows.map((r, i) => (
          <div key={i} className="dlg-two" style={{ alignItems: "end", marginBottom: 8, gridTemplateColumns: "1fr 160px auto" }}>
            <Fld label={i === 0 ? "What for" : "What for (line " + (i + 1) + ")"} error={errors[`adj${i}.label`]}>
              <input value={r.label} onChange={(e) => setRow(i, { label: e.target.value })} placeholder="Advance" autoComplete="off" />
            </Fld>
            <Fld label="Amount ($)" error={errors[`adj${i}.amount`]}>
              <input value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} inputMode="decimal" placeholder="-100.00" autoComplete="off" />
            </Fld>
            <button type="button" className="tl-btn sm" aria-label={`Remove line ${i + 1}`} onClick={() => setRows((all) => (all.length === 1 ? [{ label: "", amount: "" }] : all.filter((_, k) => k !== i)))}>
              Remove
            </button>
          </div>
        ))}
        {errors.adjustments ? <p className="th-err" role="alert">{errors.adjustments}</p> : null}
        <button type="button" className="tl-btn sm" disabled={rows.length >= MAX_ADJUSTMENTS} onClick={() => setRows((r) => [...r, { label: "", amount: "" }])}>
          Add a line
        </button>
      </section>

      <section className="tl-card">
        <h2>Statement</h2>
        <dl className="rc-facts">
          <div>
            <dt>Pay for loads</dt>
            <dd>{usd(st.loadsTotal, 2)}</dd>
          </div>
          <div>
            <dt>Adjustments</dt>
            <dd>{usd(st.adjustmentsTotal, 2)}</dd>
          </div>
          <div>
            <dt>
              <b>Total to {driverName}</b>
            </dt>
            <dd>
              <b>{usd(st.total, 2)}</b>
            </dd>
          </div>
        </dl>
        {tried || st.blockers.length > 0 ? st.blockers.map((b) => <p key={b} className="tl-note warn" role="status">{b}</p>) : null}
        {st.cautions.map((c) => (
          <p key={c} className="tl-note">{c}</p>
        ))}
        <p className="tl-note">This is gross pay for the loads and adjustments above. Taxes and payroll deductions are not worked out here.</p>
        {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
        <div className="dlg-row" style={{ marginTop: 12 }}>
          <button type="button" className="tl-btn" disabled={busy != null} aria-busy={busy === "save" || undefined} onClick={() => void save()}>
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button type="button" className="tl-btn primary" disabled={busy != null || st.blockers.length > 0} onClick={() => setConfirm("finalize")}>
            Finalize statement
          </button>
          <button type="button" className="tl-btn" disabled={busy != null} onClick={() => setConfirm("discard")} style={{ marginLeft: "auto" }}>
            Discard draft
          </button>
        </div>
      </section>

      <ConfirmDialog open={confirm === "finalize"} onClose={() => setConfirm(null)} onConfirm={() => void finalize()} eyebrow="Finalize" title={`Finalize ${number} for ${usd(st.total, 2)}?`} confirmLabel="Finalize">
        <p className="tl-note">
          {driverName}: {loads.length} {loads.length === 1 ? "load" : "loads"}
          {st.adjustments.length > 0 ? ` and ${st.adjustments.length} ${st.adjustments.length === 1 ? "adjustment" : "adjustments"}` : ""}. The lines and the total are frozen, and these loads cannot go on another statement. If it is wrong later, void it with a reason and start again.
        </p>
      </ConfirmDialog>
      <ConfirmDialog open={confirm === "discard"} onClose={() => setConfirm(null)} onConfirm={() => void discard()} eyebrow="Discard" title={`Discard draft ${number}?`} confirmLabel="Discard draft" destructive>
        <p className="tl-note">The draft and what you typed on it are removed. The loads are not changed.</p>
      </ConfirmDialog>
    </>
  );
}

// ── Void ───────────────────────────────────────────────────────────────────────────────────────

export function VoidStatement({ id, number }: { id: string; number: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function run(reason: string) {
    const out = await voidSettlementAction(id, reason);
    if (out.ok) {
      setOpen(false);
      toast({ text: `${number} voided. Its loads can be paid on another statement.`, tone: "ok" });
      router.refresh();
    } else setMessage(out.error ?? "That could not be voided.");
  }

  return (
    <>
      <button type="button" className="tl-btn danger" onClick={() => { setMessage(null); setOpen(true); }}>
        Void statement
      </button>
      <ConfirmDialog open={open} onClose={() => setOpen(false)} onConfirm={(reason) => void run(reason)} eyebrow="Void" title={`Void ${number}?`} confirmLabel="Void it" destructive askReason>
        <p className="tl-note">It stays on record as void, with your reason. Its loads are released, so they can go on a new statement. Use it for a statement that was wrong or that was never paid.</p>
        {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
      </ConfirmDialog>
    </>
  );
}
