"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { fileIftaReturnAction, reopenIftaReturnAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * Mark a quarter's IFTA return filed (money plan Wave 5 step 8). The button is off while anything blocks the return; provisional or partly final rates need the box ticked, and the server checks
 * all of it again under the lock. `amount` is the live total in words ("$98.05 due"), so the person sees what is being frozen.
 */
export function IftaFileButton({ quarter, blocked, provisional, amount }: { quarter: string; blocked: string | null; provisional: boolean; amount: string }) {
  const router = useRouter();
  const toast = useToast();
  const [confirm, setConfirm] = React.useState(false);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState("");
  const off = pending || blocked != null || (provisional && !confirm);
  const go = () =>
    start(async () => {
      const got = await tried(() => fileIftaReturnAction(quarter, confirm));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      toast({ text: `${quarter} marked filed${got.value.amended ? " (amended)" : ""}: ${amount}.`, tone: "ok" });
      router.refresh();
    });
  return (
    <div className="ifta-file">
      {provisional ? (
        <label className="ifta-confirm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={blocked != null} /> Not every rate is final yet: I am filing on provisional rates.
        </label>
      ) : null}
      <button type="button" className="tl-btn primary" disabled={off} title={blocked ?? undefined} onClick={go}>
        {pending ? "Filing…" : `Mark ${quarter} filed (${amount})`}
      </button>
      {blocked ? <span className="tl-sub">{blocked}</span> : null}
      {error ? (
        <p className="tl-note warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Reopen a filed return for a real correction. The reason is required and kept with the filing; it survives leaving the page until the reopen goes through. */
export function IftaReopenForm({ quarter }: { quarter: string }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason, draft] = useDraft(`ifta-reopen:${quarter}`, "");
  const [open, setOpen] = React.useState(false);
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState("");
  if (!open && !draft.kept)
    return (
      <button type="button" className="tl-btn" onClick={() => setOpen(true)}>
        Reopen for a correction
      </button>
    );
  const go = () =>
    start(async () => {
      const got = await tried(() => reopenIftaReturnAction(quarter, reason));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      draft.saved();
      setError("");
      setOpen(false);
      toast({ text: `${quarter} reopened. File it again once it is corrected.`, tone: "ok" });
      router.refresh();
    });
  return (
    <div className="ifta-reopen">
      <label htmlFor={`ifta-reopen-${quarter}`}>Why does the filed return need a correction?</label>
      <textarea id={`ifta-reopen-${quarter}`} rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A late fuel receipt from the card company" />
      <div className="ifta-actions">
        <button type="button" className="tl-btn primary" disabled={pending || reason.trim().length < 5} onClick={go}>
          {pending ? "Reopening…" : "Reopen the return"}
        </button>
        <button type="button" className="tl-btn" disabled={pending} onClick={() => setOpen(false)}>
          Keep it filed
        </button>
      </div>
      {error ? (
        <p className="tl-note warn" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
