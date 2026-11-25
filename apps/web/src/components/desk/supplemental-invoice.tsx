"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { issueSupplementalAction, voidSupplementalAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { SUPPLEMENTAL_KINDS, SUPPLEMENTAL_KIND_LABEL, validateSupplementalLines, type SupplementalKind } from "@/lib/invoicing";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

type LineDraft = { kind: SupplementalKind; label: string; amount: string };
type SupplementalDraft = { rows: LineDraft[]; reason: string };

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

/** Issue a supplemental invoice (`<parent>-S1`, `-S2`, ...) after an invoice has already gone out (detention approved late, layover, lumper, rate correction, or other). */
export function SupplementalDialog({
  invoiceId,
  invoiceNumber,
  loadId,
  unbilledDetention,
  factored,
  size = "default"
}: {
  invoiceId: string;
  invoiceNumber: string | null;
  loadId: string;
  unbilledDetention: number;
  factored: boolean;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const initialRows: LineDraft[] =
    unbilledDetention > 0
      ? [{ kind: "detention", label: "", amount: unbilledDetention.toFixed(2) }]
      : [{ kind: "detention", label: "", amount: "" }];
  const [f, setF, kept] = useDraft<SupplementalDraft>(`supplemental:${invoiceId}`, { rows: initialRows, reason: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const check = validateSupplementalLines(f.rows.map((r) => ({ ...r, loadId })));

  function updateRow(index: number, patch: Partial<LineDraft>) {
    setF((prev) => ({
      ...prev,
      rows: prev.rows.map((row, idx) => (idx === index ? { ...row, ...patch } : row))
    }));
  }

  function addRow() {
    setF((prev) => ({
      ...prev,
      rows: [...prev.rows, { kind: "other", label: "", amount: "" }]
    }));
  }

  function removeRow(index: number) {
    setF((prev) => ({
      ...prev,
      rows: prev.rows.length <= 1 ? prev.rows : prev.rows.filter((_, idx) => idx !== index)
    }));
  }

  async function issue() {
    setMessage(null);
    if (!check.ok) return setMessage(check.error);
    setBusy(true);
    const got = await tried(() => issueSupplementalAction(invoiceId, check.lines, f.reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      setOpen(false);
      kept.discard();
      toast({ text: `${out.number} issued for ${usd(out.total, 2)}.`, tone: "ok" });
      router.refresh();
    } else setMessage(out.error);
  }

  return (
    <>
      <button
        type="button"
        className={`tl-btn${size === "sm" ? " sm" : ""}`}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        Bill more
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={invoiceNumber ?? "Invoice"}
        title="Bill additional charges"
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || !check.ok} title={!check.ok ? check.error : undefined} onClick={() => void issue()}>
              {busy ? "Issuing…" : "Issue supplemental"}
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && check.ok) void issue();
          }}>
          <p className="tl-note dlg-lead">
            Creates a separate supplemental invoice against {invoiceNumber ?? "this invoice"} without changing what was originally billed.
          </p>
          {factored ? (
            <p className="tl-note warn" role="note">
              This invoice went to a factoring company — send this one to the factor yourself.
            </p>
          ) : null}
          <DraftNote draft={kept} what="this supplemental invoice" />
          {f.rows.map((row, idx) => (
            <div key={idx} className="dlg-two" style={{ alignItems: "end" }}>
              <Fld label="Charge type">
                <select value={row.kind} onChange={(e) => updateRow(idx, { kind: e.target.value as SupplementalKind })}>
                  {SUPPLEMENTAL_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {SUPPLEMENTAL_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Fld>
              <Fld label="Amount ($)">
                <input inputMode="decimal" value={row.amount} placeholder="0.00" onChange={(e) => updateRow(idx, { amount: e.target.value })} autoComplete="off" />
              </Fld>
              <Fld label={row.kind === "other" ? "Description (required)" : "Description (optional)"} hint={`Blank uses "${SUPPLEMENTAL_KIND_LABEL[row.kind]}".`}>
                <input value={row.label} placeholder={SUPPLEMENTAL_KIND_LABEL[row.kind]} onChange={(e) => updateRow(idx, { label: e.target.value })} maxLength={80} autoComplete="off" />
              </Fld>
              {f.rows.length > 1 ? (
                <button type="button" className="tl-btn sm" onClick={() => removeRow(idx)}>
                  Remove
                </button>
              ) : <div />}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
            <button type="button" className="tl-btn sm" onClick={addRow}>
              Add charge
            </button>
            <span>
              Total: <b>{check.ok ? usd(check.total, 2) : "—"}</b>
            </span>
          </div>
          <Fld label="Note (optional)" hint="Saved in the audit trail.">
            <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={200} autoComplete="off" />
          </Fld>
        </form>
      </Modal>
    </>
  );
}

/** Admin-only Void button for an open, unpaid supplemental invoice (requires a reason). */
export function VoidSupplementalButton({ invoiceId, number, amount }: { invoiceId: string; number: string; amount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<{ reason: string }>(`supp-void:${invoiceId}`, { reason: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  async function go() {
    setMessage(null);
    if (f.reason.trim().length < 3) return setMessage("Say why the supplemental invoice is being voided.");
    setBusy(true);
    const got = await tried(() => voidSupplementalAction(invoiceId, f.reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (got.value.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: `${number} (${usd(amount, 2)}) voided.`, tone: "ok" });
      router.refresh();
    } else setMessage(got.value.error ?? "That supplemental invoice could not be voided.");
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn sm"
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        Void
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={number}
        title={`Void ${number}?`}
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || f.reason.trim().length < 3} onClick={() => void go()}>
              Void supplemental
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && f.reason.trim().length >= 3) void go();
          }}>
          <p className="tl-note dlg-lead">
            The supplemental invoice stays numbered as void, and its {usd(amount, 2)} comes off the customer balance.
          </p>
          <DraftNote draft={kept} what="this void reason" />
          <Fld label="Why it is voided" hint="Required (at least 3 characters).">
            <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={200} autoComplete="off" />
          </Fld>
        </form>
      </Modal>
    </>
  );
}
