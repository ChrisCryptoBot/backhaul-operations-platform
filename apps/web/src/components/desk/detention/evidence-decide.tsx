"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { confirmStopEvidenceAction, dismissStopEvidenceAction } from "@/app/(desk)/actions";
import { tried } from "../kit/tried";
import { useToast } from "../kit/toast";
import { DraftNote, useDraft } from "../kit/use-draft";

/**
 * A person's decision on what the truck's track showed at one stop. They accept it as it is, or type a different wait with a few words on why (the arrival is the track's; to change that, correct the trip on the
 * load). On a load that has already been invoiced the stop cannot be rewritten, so the evidence can be kept as proof only. Or they say it is not worth claiming, with why. The server decides; this only asks.
 */
export function EvidenceDecide({ evidenceId, proposedWait, invoiced }: { evidenceId: string; proposedWait: number | null; invoiced: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [mode, setMode] = React.useState<"confirm" | "dismiss">("confirm");
  const [values, setValues, draft] = useDraft(`evidence:${evidenceId}`, { wait: proposedWait == null ? "" : String(proposedWait), note: "" });
  const [errors, setErrors] = React.useState<Partial<Record<"waitMinutes" | "note", string>>>({});
  const waitText = values.wait.trim();
  const changed = proposedWait == null || waitText !== String(proposedWait);

  async function go(kind: "confirm" | "proof" | "dismiss") {
    setBusy(true);
    setErrors({});
    const got = await tried(() => (kind === "dismiss" ? dismissStopEvidenceAction(evidenceId, values.note) : confirmStopEvidenceAction(evidenceId, { waitMinutes: waitText, note: values.note, proofOnly: kind === "proof" })));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    if (got.value.ok) {
      draft.saved();
      toast({ text: kind === "dismiss" ? "Dismissed." : kind === "proof" ? "Kept as proof." : "Confirmed.", tone: "ok" });
      router.refresh();
      return;
    }
    setErrors(got.value.errors ?? {});
    toast({ text: got.value.error, tone: "bad", ms: 10000 });
  }

  return (
    <div className="ev-decide no-print">
      <DraftNote draft={draft} what="this decision" />
      <div className="ev-tabs" role="tablist" aria-label="Decision">
        <button type="button" role="tab" aria-selected={mode === "confirm"} className="tl-btn sm" onClick={() => setMode("confirm")}>
          Confirm the wait
        </button>
        <button type="button" role="tab" aria-selected={mode === "dismiss"} className="tl-btn sm" onClick={() => setMode("dismiss")}>
          Not worth claiming
        </button>
      </div>
      {mode === "confirm" ? (
        <div className="ev-form">
          <label className="ev-field">
            <span>Wait to record, in minutes</span>
            <input value={values.wait} inputMode="numeric" autoComplete="off" aria-invalid={errors.waitMinutes ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, wait: e.target.value }))} />
            {errors.waitMinutes ? <span className="th-err" role="alert">{errors.waitMinutes}</span> : null}
          </label>
          <label className="ev-field">
            <span>{changed ? "Why it differs from the track (required)" : "A note (optional)"}</span>
            <textarea value={values.note} rows={2} aria-invalid={errors.note ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, note: e.target.value }))} />
            {errors.note ? <span className="th-err" role="alert">{errors.note}</span> : null}
          </label>
          <div className="ev-actions">
            <button type="button" className="tl-btn primary" disabled={busy || invoiced} onClick={() => void go("confirm")} aria-busy={busy || undefined}>
              {changed ? "Confirm my figure" : "Confirm what the track showed"}
            </button>
            {invoiced ? (
              <button type="button" className="tl-btn" disabled={busy} onClick={() => void go("proof")}>
                Keep as proof only
              </button>
            ) : null}
          </div>
          {invoiced ? <p className="tl-note">This load has been invoiced, so its stops cannot be rewritten here. Keeping the evidence as proof changes nothing on the load; or take the invoice back first.</p> : <p className="tl-note">Confirming records the arrival and the wait on the stop, in the audit log, and adds it to the detention to bill.</p>}
        </div>
      ) : (
        <div className="ev-form">
          <label className="ev-field">
            <span>Why it is not being claimed (required)</span>
            <textarea value={values.note} rows={2} aria-invalid={errors.note ? true : undefined} onChange={(e) => setValues((v) => ({ ...v, note: e.target.value }))} />
            {errors.note ? <span className="th-err" role="alert">{errors.note}</span> : null}
          </label>
          <div className="ev-actions">
            <button type="button" className="tl-btn" disabled={busy} onClick={() => void go("dismiss")} aria-busy={busy || undefined}>
              Dismiss
            </button>
          </div>
          <p className="tl-note">Nothing on the stop changes. The evidence is kept with your reason.</p>
        </div>
      )}
    </div>
  );
}
