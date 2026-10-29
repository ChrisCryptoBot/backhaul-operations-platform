"use client";

import React from "react";
import { cancelAction, rescheduleAction, tonuAction } from "@/app/(desk)/actions";
import { CANCEL_REASONS, RESCHEDULE_REASONS } from "@/lib/disruptions";
import { Modal } from "./kit/modal";

type Kind = "reschedule" | "cancel" | "tonu";

/**
 * "Change of plans" on a load: move the pickup, cancel it, or record a TONU. Each asks for a reason from a short list, because the
 * reasons are counted on the KPI dashboard. The page behind never changes until the dispatcher confirms.
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
  const close = React.useCallback(() => setOpen(null), []);
  // The action redirects back to the load (with a note, or an error), so the dialog has done its job once the form is sent.
  const closeSoon = React.useCallback(() => {
    window.setTimeout(() => setOpen(null), 300);
  }, []);

  const reasonField = (list: Array<{ key: string; label: string }>) => (
    <label className="tl-field">
      Reason
      <select name="reason" required defaultValue="" data-autofocus>
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
  const noteField = (
    <label className="tl-field">
      Note (needed when the reason is Other)
      <textarea name="note" placeholder="A few words for the audit log" />
    </label>
  );
  const actions = (submit: string, danger?: boolean) => (
    <div className="dlg-actions">
      <button type="button" className="tl-btn" onClick={close}>
        Back
      </button>
      <button type="submit" className={`tl-btn ${danger ? "danger" : "primary"}`}>
        {submit}
      </button>
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
        <form action={rescheduleAction} className="dlg-form" onSubmit={closeSoon}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">Every stop moves by the same amount, so the time between them stays as it was. Times are Dallas time.</p>
          <label className="tl-field">
            New pickup
            <input type="datetime-local" name="pickup" required defaultValue={pickupLocal ?? ""} />
          </label>
          {reasonField(RESCHEDULE_REASONS)}
          {noteField}
          {reconfirm && driverName ? <p className="tl-note warn">{driverName} already has this load and will be asked to confirm the new time.</p> : null}
          {actions("Move the pickup")}
        </form>
      </Modal>

      <Modal open={open === "tonu"} onClose={close} eyebrow={loadNumber} title="Record a TONU">
        <form action={tonuAction} className="dlg-form" onSubmit={closeSoon}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">The truck went and there was nothing to haul. The fee counts as revenue and the load closes as a TONU.</p>
          <label className="tl-field">
            TONU fee the broker owes ($)
            <input type="number" name="fee" min="1" step="0.01" required placeholder="150.00" />
          </label>
          {reasonField(CANCEL_REASONS)}
          {noteField}
          {actions("Record the TONU")}
        </form>
      </Modal>

      <Modal open={open === "cancel"} onClose={close} eyebrow={loadNumber} title="Cancel this load?">
        <form action={cancelAction} className="dlg-form" onSubmit={closeSoon}>
          <input type="hidden" name="loadId" value={loadId} />
          <p className="tl-note">{driverName ? `${driverName} is taken off it. ` : ""}A cancelled load stays in the history with its reason, but it is no longer on the board.</p>
          {reasonField(CANCEL_REASONS)}
          {noteField}
          {actions("Cancel the load", true)}
        </form>
      </Modal>
    </>
  );
}
