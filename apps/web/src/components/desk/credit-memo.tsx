"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { creditMemoAction, voidCreditMemoAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * Credit memos on the invoice sheet (docs/MONEY_PLAN.md, rule F). A credit memo is its own record: it names the invoice it credits, lowers what is owed on it (and so the aging and
 * the load's amount received) and leaves the invoice itself at its full amount. The amount defaults to, and cannot go above, what is still owed.
 */
export const CREDIT_REASONS = [
  { key: "customer_discount", label: "Customer discount" },
  { key: "freight_claim", label: "Freight claim" },
  { key: "billing_dispute", label: "Billing dispute" },
  { key: "other", label: "Other" }
] as const;
type ReasonKey = (typeof CREDIT_REASONS)[number]["key"];

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

/** Whole cents from what was typed, or null when it is not dollars and cents. Parsed by hand so a figure never passes through floating point on its way to a comparison. */
function centsOf(text: string): number | null {
  const t = text.trim().replace(/,/g, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10) * 100 + Number.parseInt((m[2] ?? "").padEnd(2, "0") || "0", 10);
}

export function CreditMemoDialog({ loadId, invoiceNumber, owingCents }: { loadId: string; invoiceNumber: string | null; owingCents: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<{ amount: string; reason: ReasonKey; notes: string; label: string }>(`credit:${loadId}`, { amount: (owingCents / 100).toFixed(2), reason: "customer_discount", notes: "", label: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const cents = centsOf(f.amount);
  const over = cents != null && cents > owingCents;
  const reasonLabel = CREDIT_REASONS.find((r) => r.key === f.reason)?.label ?? "Credit";
  const problem = cents == null || cents <= 0 ? "Type the amount to credit, above zero." : over ? `Only ${usd(owingCents / 100, 2)} is still owed.` : f.notes.trim().length < 3 ? "Say what the credit is for (at least a few words)." : null;

  async function issue() {
    setMessage(null);
    if (problem) return setMessage(problem);
    setBusy(true);
    const got = await tried(() => creditMemoAction(loadId, f.amount, `${reasonLabel}: ${f.notes.trim()}`, f.label.trim() || reasonLabel));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    const out = got.value;
    if (out.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: `${out.number} issued for ${usd((cents ?? 0) / 100, 2)}${out.closed ? ". The invoice is closed." : "."}`, tone: "ok" });
      router.refresh();
    } else setMessage(out.error ?? "That credit could not be made.");
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn"
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        Credit memo
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={invoiceNumber ?? "Invoice"}
        title="Credit the customer"
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy || !!problem} title={problem ?? undefined} onClick={() => void issue()}>
              Issue the credit memo
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && !problem) void issue();
          }}>
          <p className="tl-note dlg-lead">
            A credit memo lowers what is owed on {invoiceNumber ?? "this invoice"} without changing the invoice. {usd(owingCents / 100, 2)} is owed now, so the credit can be at most that.
          </p>
          <DraftNote draft={kept} what="this credit" />
          <div className="dlg-two">
            <Fld label="Amount to credit ($)">
              <input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoComplete="off" />
            </Fld>
            <Fld label="Reason">
              <select value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value as ReasonKey })}>
                {CREDIT_REASONS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Fld>
          </div>
          <Fld label="What it is for" hint="Required. It goes in the audit trail and on the credit memo.">
            <input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={160} autoComplete="off" />
          </Fld>
          <Fld label="Line label" hint={`Optional. The line on the credit memo; blank says "${reasonLabel}".`}>
            <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} maxLength={80} autoComplete="off" />
          </Fld>
        </form>
      </Modal>
    </>
  );
}

/** One credit memo's Void button: taking a credit back is an admin's (it lets the customer owe the money again), with a reason. */
export function VoidCreditButton({ memoId, number, amount }: { memoId: string; number: string; amount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [f, setF, kept] = useDraft<{ reason: string }>(`credit-void:${memoId}`, { reason: "" });
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  async function go() {
    setMessage(null);
    if (f.reason.trim().length < 3) return setMessage("Say why the credit is taken back.");
    setBusy(true);
    const got = await tried(() => voidCreditMemoAction(memoId, f.reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (got.value.ok) {
      kept.saved();
      setOpen(false);
      toast({ text: `${number} taken back. ${usd(amount, 2)} is owed again.`, tone: "ok" });
      router.refresh();
    } else setMessage(got.value.error ?? "That credit could not be taken back.");
  }
  return (
    <>
      <button type="button" className="tl-btn ghost sm" onClick={() => { setMessage(null); setOpen(true); }}>
        Void
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={number}
        title={`Take back ${number}?`}
        footer={
          <>
            {message ? <span className="tl-note warn dlg-foot-msg" role="alert">{message}</span> : null}
            <button type="button" className="tl-btn" onClick={() => setOpen(false)}>
              Back
            </button>
            <button type="button" className="tl-btn primary" disabled={busy} onClick={() => void go()}>
              Take it back
            </button>
          </>
        }>
        <form
          className="dlg-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void go();
          }}>
          <p className="tl-note dlg-lead">The customer owes the {usd(amount, 2)} again, and the invoice opens again if the credit had closed it.</p>
          <DraftNote draft={kept} what="this reason" />
          <Fld label="Why">
            <input value={f.reason} onChange={(e) => setF({ reason: e.target.value })} maxLength={200} autoComplete="off" />
          </Fld>
        </form>
      </Modal>
    </>
  );
}
