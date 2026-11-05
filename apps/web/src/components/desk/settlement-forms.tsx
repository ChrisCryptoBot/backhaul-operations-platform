"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import React from "react";
import { discardSettlementAction, finalizeSettlementAction, markSettlementPaidAction, saveSettlementAction, startSettlementAction, voidSettlementAction } from "@/app/(desk)/actions";
import type { Company } from "@/lib/company";
import { shortDate, usd } from "@/lib/desk-format";
import { paidMethodLabel } from "@/lib/pay-method";
import { computeStatement, MAX_ADJUSTMENTS, validatePeriod, type AdjustmentInput, type PeriodPreset, type SettlementLoad } from "@/lib/settlement";

import { DateInput } from "./date-input";
import { DocHead } from "./doc-head";
import { DriverPicker } from "./driver-picker";
import { ConfirmDialog, Modal } from "./kit/modal";
import { ReadOnlyGate } from "./kit/read-only";
import { useToast } from "./kit/toast";
import { tried as attempt } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";
import { activeTz } from "@/lib/tz";
import { clockName } from "@/lib/tz";

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
export function StartStatement({ presets, initial, label = "Start a statement", primary = true }: { presets: PeriodPreset[]; initial?: { driverId?: string; driverName?: string; start?: string; end?: string }; label?: string; primary?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // The driver and the period are kept until the statement is started.
  const [{ driverId, start, end }, setStatement, draft] = useDraft(`statement-start:${initial?.driverId ?? "any"}`, { driverId: initial?.driverId ?? "", start: initial?.start ?? presets[0]?.start ?? "", end: initial?.end ?? presets[0]?.end ?? "" });
  const setDriverId = (v: string) => setStatement((s) => ({ ...s, driverId: v }));
  const setStart = (v: string) => setStatement((s) => ({ ...s, start: v }));
  const setEnd = (v: string) => setStatement((s) => ({ ...s, end: v }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function go() {
    if (busy) return;
    setErrors({});
    setMessage(null);
    const p = validatePeriod(start, end);
    if (!p.ok) {
      setErrors(p.errors);
      return;
    }
    if (driverId === "" || driverId === "?") {
      setErrors({ driverId: "Pick a driver from the list." });
      return;
    }
    setBusy(true);
    try {
      const got = await attempt(() => startSettlementAction({ driverId, start: p.start, end: p.end }));
      if (!got.ok) {
        setMessage(got.message);
        return;
      }
      const out = got.value;
      if (out.ok) {
        draft.saved();
        setOpen(false);
        router.push(`/settlements/${out.id}`);
      } else {
        setErrors(out.errors ?? {});
        setMessage(out.error ?? null);
      }
    } finally {
      setBusy(false);
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
        onClose={() => !busy && setOpen(false)}
        eyebrow="Driver pay"
        title="Start a statement"
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="start-settlement-form" className="tl-btn primary" disabled={busy} aria-busy={busy || undefined}>
              {busy ? "Starting…" : "Start the statement"}
            </button>
          </>
        }>
        <form
          id="start-settlement-form"
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}>
          <p className="tl-note">It lists the loads the driver delivered in the period that are not already paid on another statement. You add hours, deductions and extras before you finalize it.</p>
          <Fld label="Driver" error={errors.driverId}>
            <DriverPicker
              id={driverId}
              name={initial?.driverName ?? ""}
              includeInactive
              invalid={driverId === "?"}
              onPick={(id) => {
                setDriverId(id);
                setErrors({});
              }}
            />
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
            <Fld label="First day" error={errors.start} hint={`On your ${clockName()} calendar, delivered on or after.`}>
              <DateInput type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            </Fld>
            <Fld label="Last day" error={errors.end} hint="Delivered on or before.">
              <DateInput type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            </Fld>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── The draft ──────────────────────────────────────────────────────────────────────────────────

const BROKER: Record<string, string> = { paid: "Customer paid", paid_short: "Customer paid short", invoiced: "Invoice out", not_invoiced: "Not invoiced" };

/** The draft: each load with what it pays, hours for hourly loads, adjustments, and the total as you type, with the same sums the server freezes. */
export function SettlementEditor({
  id,
  number,
  driverName,
  company,
  periodLabel,
  loads,
  initialHours,
  initialAdjustments,
  canEdit = true,
  who = "Accounting or Admin"
}: {
  id: string;
  number: string;
  driverName: string;
  company: Company;
  periodLabel: string;
  loads: SettlementLoad[];
  initialHours: Record<string, string>;
  initialAdjustments: AdjustmentInput[];
  canEdit?: boolean;
  who?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  // The hours and adjustments typed are kept until the draft is saved, finalized or started over.
  const [form, setForm, kept] = useDraft<{ hours: typeof initialHours; rows: AdjustmentInput[] }>(`settlement:${id}`, { hours: initialHours, rows: initialAdjustments.length > 0 ? initialAdjustments : [{ label: "", amount: "" }] });
  const { hours, rows } = form;
  const setHours = (u: React.SetStateAction<typeof initialHours>) => setForm((f) => ({ ...f, hours: typeof u === "function" ? u(f.hours) : u }));
  const setRows = (u: React.SetStateAction<AdjustmentInput[]>) => setForm((f) => ({ ...f, rows: typeof u === "function" ? u(f.rows) : u }));
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
    if (busy != null) return;
    setTried(true);
    if (Object.keys(st.errors).length > 0) return setMessage("Fix what is marked, then save.");
    setBusy("save");
    try {
      const got = await attempt(() => saveSettlementAction(id, draft));
      if (!got.ok) return setMessage(got.message);
      const out = got.value;
      if (out.ok) {
        setServerErrors({});
        setMessage(null);
        kept.saved();
        toast({ text: "Draft saved.", tone: "ok" });
        then?.();
        router.refresh();
      } else {
        setServerErrors(out.errors ?? {});
        setMessage(out.error ?? "Fix what is marked, then save.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function finalize() {
    if (busy != null) return;
    setTried(true);
    setConfirm(null);
    setBusy("finalize");
    try {
      const got = await attempt(() => finalizeSettlementAction(id, draft, st.total));
      if (!got.ok) return setMessage(got.message);
      const out = got.value;
      if (out.ok) {
        kept.saved();
        toast({ text: `${number} finalized for ${usd(st.total, 2)}.`, tone: "ok" });
        router.refresh();
      } else {
        setServerErrors(out.errors ?? {});
        setMessage(out.error ?? "That could not be finalized.");
      }
    } finally {
      setBusy(null);
    }
  }

  async function discard() {
    if (busy != null) return;
    setConfirm(null);
    setBusy("discard");
    try {
      const got = await attempt(() => discardSettlementAction(id));
      if (!got.ok) return setMessage(got.message);
      const out = got.value;
      if (out.ok) {
        toast({ text: `Draft ${number} discarded.`, tone: "ok" });
        router.push("/settlements");
      } else setMessage(out.error ?? "That could not be discarded.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="no-print">
        <ReadOnlyGate allowed={canEdit} who={who} what="this draft statement" banner>
          {canEdit ? <DraftNote draft={kept} what="this statement" /> : null}
          <section className="tl-card">
            <h2>{`Loads · ${loads.length}`}</h2>
            {loads.length === 0 ? (
              <p className="tl-note">No delivered loads in this period are left to pay. Anything delivered later goes on the next statement.</p>
            ) : (
              <table className="tl-table" aria-label="Statement lines">
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
                          <div className={`tl-sub${l.brokerStatus === "paid_short" ? " tone-neg" : ""}`}>{BROKER[l.brokerStatus]}</div>
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
            {canEdit ? (
              <div className="dlg-row" style={{ marginTop: 12 }}>
                <button type="button" className="tl-btn" disabled={busy != null} aria-busy={busy === "save" || undefined} onClick={() => void save()}>
                  {busy === "save" ? "Saving…" : "Save draft"}
                </button>
                <button type="button" className="tl-btn primary" disabled={busy != null || st.blockers.length > 0} aria-busy={busy === "finalize" || undefined} onClick={() => setConfirm("finalize")}>
                  {busy === "finalize" ? "Finalizing…" : "Finalize statement"}
                </button>
                <button type="button" className="tl-btn" disabled={busy != null} aria-busy={busy === "discard" || undefined} onClick={() => setConfirm("discard")} style={{ marginLeft: "auto" }}>
                  {busy === "discard" ? "Discarding…" : "Discard draft"}
                </button>
              </div>
            ) : null}
          </section>
        </ReadOnlyGate>

        <ConfirmDialog open={confirm === "finalize"} onClose={() => busy == null && setConfirm(null)} onConfirm={() => void finalize()} eyebrow="Finalize" title={`Finalize ${number} for ${usd(st.total, 2)}?`} confirmLabel="Finalize">
          <p className="tl-note">
            {driverName}: {loads.length} {loads.length === 1 ? "load" : "loads"}
            {st.adjustments.length > 0 ? ` and ${st.adjustments.length} ${st.adjustments.length === 1 ? "adjustment" : "adjustments"}` : ""}. The lines and the total are frozen, and these loads cannot go on another statement. If it is wrong later, an admin can void it with a reason before it is paid.
          </p>
        </ConfirmDialog>
        <ConfirmDialog open={confirm === "discard"} onClose={() => busy == null && setConfirm(null)} onConfirm={() => void discard()} eyebrow="Discard" title={`Discard draft ${number}?`} confirmLabel="Discard draft" destructive>
          <p className="tl-note">The draft and what you typed on it are removed. The loads are not changed.</p>
        </ConfirmDialog>
      </div>

      <article className="rp print-only">
        <DocHead kicker="Pay statement" number={number} company={company} heroLabel="Gross pay" hero={usd(st.total, 2)} sub={`${driverName} · ${periodLabel}`} stamp={{ text: "Draft", tone: "plain" }} />
        <table style={{ marginTop: 14 }} aria-label="Draft statement details">
          <tbody>
            <tr>
              <th>Paid to</th>
              <td><b>{driverName}</b></td>
              <th>Period</th>
              <td>{periodLabel}</td>
              <th>Status</th>
              <td>Draft (not yet finalized)</td>
            </tr>
          </tbody>
        </table>
        <h2>Loads</h2>
        {st.lines.length === 0 ? (
          <p>No loads on this statement.</p>
        ) : (
          <table aria-label="Draft loads paid">
            <thead>
              <tr>
                <th>Load</th>
                <th>Delivered</th>
                <th>How it was worked out</th>
                <th className="num">Pay</th>
              </tr>
            </thead>
            <tbody>
              {st.lines.map((l) => (
                <tr key={l.loadId}>
                  <td>
                    {l.loadNumber ?? "—"}
                    <div className="rp-meta">{l.lane}</div>
                  </td>
                  <td>{l.deliveredAt ? shortDate(l.deliveredAt) : "—"}</td>
                  <td>{l.basis}</td>
                  <td className="num">{l.amount == null ? "needs hours" : usd(l.amount, 2)}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3}><b>Pay for loads</b></td>
                <td className="num"><b>{usd(st.loadsTotal, 2)}</b></td>
              </tr>
            </tbody>
          </table>
        )}
        {st.adjustments.length > 0 ? (
          <>
            <h2>Adjustments</h2>
            <table aria-label="Draft adjustments">
              <tbody>
                {st.adjustments.map((a, i) => (
                  <tr key={i}>
                    <td>{a.label}</td>
                    <td className={`num ${a.amount < 0 ? "rp-bad" : ""}`}>{usd(a.amount, 2)}</td>
                  </tr>
                ))}
                <tr>
                  <td><b>Adjustments</b></td>
                  <td className="num"><b>{usd(st.adjustmentsTotal, 2)}</b></td>
                </tr>
              </tbody>
            </table>
          </>
        ) : null}
        <h2>Total</h2>
        <table aria-label="Draft total">
          <tbody>
            <tr>
              <td><b>Total to {driverName}</b></td>
              <td className="num"><b>{usd(st.total, 2)}</b></td>
            </tr>
          </tbody>
        </table>
        <p className="rp-foot">Draft gross pay for the loads and adjustments above. Not yet finalized.</p>
      </article>
    </>
  );
}

// ── Mark paid (outside payroll) ────────────────────────────────────────────────────────────────

const PAID_METHODS = [
  { key: "check", label: "Check" },
  { key: "transfer", label: "Bank transfer / ACH / Zelle" },
  { key: "cash", label: "Cash" },
  { key: "other", label: "Other" }
] as const;

export function MarkSettlementPaid({ id, number, driverName, total }: { id: string; number: string; driverName: string; total: number }) {
  const router = useRouter();
  const toast = useToast();
  const today = () => new Date().toLocaleDateString("en-CA", { timeZone: activeTz() });
  const [open, setOpen] = React.useState(false);
  // Kept until the payout is recorded.
  const [{ paidOn, method }, setPayout, draft] = useDraft(`settlement-paid:${id}`, { paidOn: today(), method: "check" });
  const setPaidOn = (v: string) => setPayout((p) => ({ ...p, paidOn: v }));
  const setMethod = (v: string) => setPayout((p) => ({ ...p, method: v }));
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function submit() {
    if (busy) return;
    setErrors({});
    setMessage(null);
    setBusy(true);
    try {
      const got = await attempt(() => markSettlementPaidAction(id, paidOn, method));
      if (!got.ok) {
        setMessage(got.message);
        return;
      }
      const out = got.value;
      if (out.ok) {
        draft.saved();
        setOpen(false);
        toast({ text: `${number} marked paid by ${paidMethodLabel(method).toLowerCase()}.`, tone: "ok" });
        router.refresh();
      } else {
        setErrors(out.errors ?? {});
        setMessage(out.error ?? "That could not be recorded.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn"
        onClick={() => {
          setErrors({});
          setMessage(null);
          setOpen(true);
        }}>
        Mark paid
      </button>
      <Modal
        open={open}
        onClose={() => !busy && setOpen(false)}
        eyebrow={number}
        title={`Mark ${number} paid?`}
        footer={
          <>
            {message ? <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>{message}</span> : null}
            <button type="button" className="tl-btn" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button type="submit" form="mark-settlement-paid-form" className="tl-btn primary" disabled={busy} aria-busy={busy || undefined}>
              {busy ? "Saving…" : "Record payout"}
            </button>
          </>
        }>
        <form
          id="mark-settlement-paid-form"
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}>
          <p className="tl-note">
            Record that {driverName} was paid <b>{usd(total, 2)}</b> directly (check, transfer or cash) rather than through payroll. Once marked paid, this statement cannot be sent to payroll or voided.
          </p>
          <div className="dlg-two">
            <Fld label="Paid on" error={errors.paidOn}>
              <DateInput type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </Fld>
            <Fld label="Payment method" error={errors.method}>
              <select value={method} onChange={(e) => setMethod(e.target.value)}>
                {PAID_METHODS.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Fld>
          </div>
        </form>
      </Modal>
    </>
  );
}

// ── Void ───────────────────────────────────────────────────────────────────────────────────────

export function VoidStatement({ id, number }: { id: string; number: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function run(reason: string) {
    if (busy) return;
    setMessage(null);
    setBusy(true);
    try {
      const got = await attempt(() => voidSettlementAction(id, reason));
      if (!got.ok) {
        setMessage(got.message);
        return;
      }
      const out = got.value;
      if (out.ok) {
        setOpen(false);
        toast({ text: `${number} voided. Its loads can be paid on another statement.`, tone: "ok" });
        router.refresh();
      } else {
        setMessage(out.error ?? "That could not be voided.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn danger"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        {busy ? "Voiding…" : "Void statement"}
      </button>
      <ConfirmDialog open={open} onClose={() => !busy && setOpen(false)} onConfirm={(reason) => void run(reason)} eyebrow="Void" title={`Void ${number}?`} confirmLabel={busy ? "Voiding…" : "Void it"} destructive askReason>
        <p className="tl-note">It stays on record as void, with your reason. Its loads are released, so they can go on a new statement. Use it for a statement that was wrong and has not been paid.</p>
        {message ? <p className="tl-note warn" role="alert">{message}</p> : null}
      </ConfirmDialog>
    </>
  );
}
