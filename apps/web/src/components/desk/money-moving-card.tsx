"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { setMoneyMovingAction } from "@/app/(desk)/actions";
import { SWITCH_REASON_MIN } from "@/lib/partner-gates";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";
import { DraftNote, useDraft } from "./kit/use-draft";

/**
 * The money-moving switch (docs/MONEY_PLAN.md Gap 14, Wave 7 step 1): whether a call to a real company may send money for this fleet (an invoice sold to a factor, a pay run sent to payroll).
 * Shown to admins. Read-only until the server's operator records counsel's sign-off (MONEY_MOVING_COUNSEL_APPROVED); turning it off is always possible. The simulator never needs it.
 */
export type MoneyMovingView = { counsel: boolean; live: boolean; by: string | null; at: string | null; reason: string | null };

export function MoneyMovingCard({ view, canEdit }: { view: MoneyMovingView; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason, kept] = useDraft<string>("money-moving-reason", "");
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const turningOn = !view.live;
  // Turning it on needs the server's sign-off; turning it off never does.
  const canFlip = canEdit && (view.live || view.counsel);

  async function flip() {
    setMessage(null);
    if (reason.trim().length < SWITCH_REASON_MIN) return setMessage(`Say why, in a few words (at least ${SWITCH_REASON_MIN} characters): it goes in the audit trail.`);
    setBusy(true);
    const got = await tried(() => setMoneyMovingAction(turningOn, reason));
    setBusy(false);
    if (!got.ok) return setMessage(got.message);
    if (!got.value.ok) return setMessage(got.value.error);
    kept.saved();
    setReason("");
    toast({ text: got.value.changed ? (got.value.live ? "Money moving switched on." : "Money moving switched off.") : "Nothing had changed.", tone: "ok" });
    router.refresh();
  }

  return (
    <form
      className="dlg-form mm-card"
      onSubmit={(e) => {
        e.preventDefault();
        if (canFlip && !busy) void flip();
      }}>
      <p className="mm-state">
        <span className={`tl-chip ${view.live && view.counsel ? "warn" : ""}`}>{view.live ? (view.counsel ? "On" : "On, but the server is not signed off") : "Off"}</span>
        <span className={`tl-chip ${view.counsel ? "ok" : ""}`}>{view.counsel ? "Server signed off by counsel" : "Server not signed off"}</span>
      </p>
      <p className="tl-note dlg-lead">
        Whether TrueLane may send money through a real company for this fleet: sell an invoice to the factor, or send a pay run to payroll. It needs counsel&apos;s sign-off on this server (set by whoever
        runs it) <b>and</b> this switch. The simulator on the demo desk never needs it, and reading from a company (a payroll status check) never does.
      </p>
      {view.at ? (
        <p className="tl-sub">
          Last switched {view.live ? "on" : "off"} by {view.by ?? "an admin"}, {view.at}
          {view.reason ? `: ${view.reason}` : ""}
        </p>
      ) : null}
      {canEdit ? (
        canFlip ? (
          <>
            <DraftNote draft={kept} what="this reason" />
            <label className="tl-field">
              Why you are switching it {turningOn ? "on" : "off"}
              <input value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} maxLength={300} autoComplete="off" />
              <span className="th-hint">Said in the audit trail with your name.</span>
            </label>
            <div className="dlg-foot-row">
              {message ? (
                <span className="tl-note warn" role="alert">
                  {message}
                </span>
              ) : null}
              <button type="submit" className={`tl-btn ${turningOn ? "primary" : ""}`} disabled={busy}>
                {busy ? "Saving…" : turningOn ? "Switch on" : "Switch off"}
              </button>
            </div>
          </>
        ) : (
          <p className="tl-sub">It can be switched on once this server is signed off by counsel. Ask whoever runs it.</p>
        )
      ) : (
        <p className="tl-sub">An admin switches this.</p>
      )}
    </form>
  );
}
