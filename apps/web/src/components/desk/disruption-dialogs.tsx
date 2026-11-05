"use client";

import { SubmitButton } from "./kit/submit-button";
import React from "react";
import { cancelAction, rescheduleAction, tonuAction } from "@/app/(desk)/actions";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/disruptions";
import { Modal } from "./kit/modal";
import { DateInput } from "./date-input";
import { useDraft } from "./kit/use-draft";
import { useSubmitOutcome } from "./kit/use-submit-outcome";

type Kind = "reschedule" | "cancel" | "tonu";

/** Everything typed into the three dialogs: they are kept together, per load. */
type Fields = { pickup: string; rescheduleReason: string; rescheduleNote: string; tonuFee: string; tonuReason: string; tonuNote: string; cancelReason: string; cancelNote: string };
const BLANK: Omit<Fields, "pickup"> = { rescheduleReason: "", rescheduleNote: "", tonuFee: "", tonuReason: "", tonuNote: "", cancelReason: "", cancelNote: "" };

/**
 * "Change of plans" on a load: move the pickup, cancel it, or record a TONU. Each asks for a reason from a short list, because the
 * reasons are counted on the KPI dashboard. The page behind never changes until the dispatcher confirms.
 * What is typed is kept until the action has worked (the action sends the person back with a note), so a refusal, or leaving the page, does not lose it.
 */
export function DisruptionButtons({
  loadId,
  loadNumber,
  can,
  pickupLocal,
  driverName,
  reconfirm
}: {
  loadId: string;
  loadNumber: string;
  can: { reschedule: boolean; cancel: boolean; tonu: boolean };
  /** The current pickup as "2026-10-30T08:00" on the Dallas clock, to start the date field from. */
  pickupLocal: string | null;
  driverName: string | null;
  /** The driver already has the load, so a new time means they have to confirm again. */
  reconfirm: boolean;
}) {
  const [open, setOpen] = React.useState<Kind | null>(null);
  const [v, setV, draft] = useDraft<Fields>(`disruption:${loadId}`, { pickup: pickupLocal ?? "", ...BLANK });
  const sent = useSubmitOutcome();
  const set = (patch: Partial<Fields>) => setV((cur) => ({ ...cur, ...patch }));
  const close = React.useCallback(() => setOpen(null), []);
  // The action redirects back to the load (with a note, or an error), so the dialog has done its job once the form is sent.
  const closeSoon = React.useCallback(() => {
    window.setTimeout(() => setOpen(null), 300);
  }, []);
  const onSend = () => {
    sent(() => draft.discard());
    closeSoon();
  };

  const reasonField = (list: Array<{ key: string; label: string }>, field: "rescheduleReason" | "tonuReason" | "cancelReason") => (
    <label className="tl-field">
      Reason
      <select name="reason" required value={v[field]} onChange={(e) => set({ [field]: e.target.value })} data-autofocus>
        <option value="" disabled>
          Pick one
        </option>
        {list.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
    </label>
  );
  const noteField = (field: "rescheduleNote" | "tonuNote" | "cancelNote") => (
    <label className="tl-field">
      Note (needed when the reason is Other)
      <textarea name="note" value={v[field]} onChange={(e) => set({ [field]: e.target.value })} placeholder="A few words for the audit log" />
    </label>
  );
  const actions = (submit: string, danger?: boolean) => (
    <div className="dlg-actions">
      <button type="button" className="tl-btn" onClick={close}>
        Back
      </button>
      <SubmitButton className={`tl-btn ${danger ? "danger" : "primary"}`} pending="Saving…">
        {submit}
      </SubmitButton>
    </div>
  );

  return (
    <>
      <div className="dlg-row">
        {can.reschedule ? (
          <button type="button" className="tl-btn sm" onClick={() => setOpen("reschedule")}>
            Reschedule pickup
          </button>
        ) : null}
        {can.tonu ? (
          <button type="button" className="tl-btn sm" onClick={() => setOpen("tonu")}>
            Record a TONU
          </button>
        ) : null}
        {can.cancel ? (
          <button type="button" className="tl-btn sm danger" onClick={() => setOpen("cancel")}>
            Cancel load
          </button>
        ) : null}
      </div>

      <Modal open={open === "reschedule"} onClose={close} eyebrow={loadNumber} title="Move the pickup">
        <form action={rescheduleAction} className="dlg-form" onSubmit={onSend}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">Every stop moves by the same amount, so the time between them stays as it was. Times are Dallas time.</p>
          <label className="tl-field">
            New pickup
            <DateInput type="datetime-local" name="pickup" required value={v.pickup} onChange={(e) => set({ pickup: e.target.value })} />
          </label>
          {reasonField(RESCHEDULE_REASONS, "rescheduleReason")}
          {noteField("rescheduleNote")}
          {reconfirm && driverName ? <p className="tl-note warn">{driverName} already has this load and will be asked to confirm the new time.</p> : null}
          {actions("Move the pickup")}
        </form>
      </Modal>

      <Modal open={open === "tonu"} onClose={close} eyebrow={loadNumber} title="Record a TONU">
        <form action={tonuAction} className="dlg-form" onSubmit={onSend}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">The truck went and there was nothing to haul. The fee counts as revenue and the load closes as a TONU.</p>
          <label className="tl-field">
            TONU fee the customer owes ($)
            <input type="number" name="fee" min="1" step="0.01" required placeholder="150.00" value={v.tonuFee} onChange={(e) => set({ tonuFee: e.target.value })} />
          </label>
          {reasonField(CANCEL_REASONS, "tonuReason")}
          {noteField("tonuNote")}
          {actions("Record the TONU")}
        </form>
      </Modal>

      <Modal open={open === "cancel"} onClose={close} eyebrow={loadNumber} title="Cancel this load?">
        <form action={cancelAction} className="dlg-form" onSubmit={onSend}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">{driverName ? `${driverName} is taken off it. ` : ""}A cancelled load stays in the history with its reason, but it is no longer on the board.</p>
          {reasonField(CANCEL_REASONS, "cancelReason")}
          {noteField("cancelNote")}
          {actions("Cancel the load", true)}
        </form>
      </Modal>
    </>
  );
}
