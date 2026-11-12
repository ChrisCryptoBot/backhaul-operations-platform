"use client";

import React from "react";
import { Modal } from "./kit/modal";
import { useDraft } from "./kit/use-draft";
import { RECALL_LABELS, RECALL_NOTE_MAX, RECALL_OFFERED, type RecallCode } from "@/lib/recall-reasons";

/**
 * Recall a load from a driver who was already sent it (docs/RELAY_DESIGN.md). The dispatcher picks one reason from the fixed list and may add a note; both are kept in the audit trail and the
 * holder trail. The action is `unassignAction`, which reads `reasonCode` and `reasonNote`.
 */
export function RecallForm({ action, loadId, driverName, loadNumber, accepted }: { action: (formData: FormData) => void | Promise<void>; loadId: string; driverName: string; loadNumber: string; accepted: boolean }) {
  const [open, setOpen] = React.useState(false);
  // What was picked or typed is kept until the recall is sent or cancelled (docs/DESIGN_BRIEF.md, "Fields are kept").
  const [draftValues, setDraftValues, draft] = useDraft<{ code: RecallCode | ""; note: string; rolling: boolean; miles: string; source: string }>(`recall:${loadId}`, { code: "", note: "", rolling: false, miles: "", source: "" });
  const { code, note, rolling, miles, source } = draftValues;
  const setCode = (c: RecallCode | "") => setDraftValues((v) => ({ ...v, code: c }));
  const setNote = (n: string) => setDraftValues((v) => ({ ...v, note: n }));
  const [pending, start] = React.useTransition();
  const cancel = () => {
    draft.discard();
    setOpen(false);
  };
  const send = () => {
    if (!code || pending) return;
    const data = new FormData();
    data.set("loadId", loadId);
    data.set("reasonCode", code);
    data.set("reasonNote", note.trim());
    // A driver who was already rolling empty to the pickup keeps the miles they drove: a closed positioning leg, with where the figure came from.
    if (accepted && rolling) {
      data.set("rolling", "1");
      data.set("milesDriven", miles.trim());
      data.set("milesSource", source);
    }
    draft.saved();
    setOpen(false);
    start(async () => {
      await action(data);
    });
  };
  return (
    <>
      <button type="button" className="tl-btn sm danger" disabled={pending} aria-busy={pending || undefined} onClick={() => setOpen(true)}>
        Recall from driver
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Recall"
        title={`Take ${driverName} off ${loadNumber}?`}
        footer={
          <>
            <button type="button" className="tl-btn" onClick={cancel}>Cancel</button>
            <button type="button" className="tl-btn danger" disabled={!code || (accepted && rolling && miles.trim() !== "" && !source)} onClick={send}>Recall load</button>
          </>
        }>
        <p className="tl-note">
          {accepted ? "The driver already accepted this load. " : "The load was already sent. "}
          It goes back to Needs a driver, the driver&rsquo;s phone is told, and the reason is kept on the load. If the driver is already loaded and on the road, this is a handoff instead, not a recall.
        </p>
        <fieldset className="tl-field" style={{ marginTop: 12, border: 0, padding: 0 }}>
          <legend>Why</legend>
          {RECALL_OFFERED.map((c, i) => (
            <label key={c} style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
              <input type="radio" name="recall-reason" value={c} checked={code === c} onChange={() => setCode(c)} data-autofocus={i === 0 ? true : undefined} />
              {RECALL_LABELS[c]}
            </label>
          ))}
        </fieldset>
        {accepted ? (
          <fieldset className="tl-field" style={{ marginTop: 12, border: 0, padding: 0 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={rolling} onChange={(e) => setDraftValues((v) => ({ ...v, rolling: e.target.checked }))} />
              The driver was already rolling empty to the pickup
            </label>
            {rolling ? (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
                <label className="tl-field">Miles they drove (if known)
                  <input type="number" step="any" min="0" value={miles} onChange={(e) => setDraftValues((v) => ({ ...v, miles: e.target.value }))} />
                </label>
                <label className="tl-field">Where the miles came from
                  <select value={source} onChange={(e) => setDraftValues((v) => ({ ...v, source: e.target.value }))}>
                    <option value="">Not entered</option>
                    <option value="eld">The ELD</option>
                    <option value="driver">The driver</option>
                    <option value="dispatcher">I worked it out</option>
                  </select>
                </label>
                <p className="tl-note" style={{ flexBasis: "100%" }}>They are paid for these miles at their own per-mile rate. With no miles entered, the leg says so and the pay stays unknown.</p>
              </div>
            ) : null}
          </fieldset>
        ) : null}
        <label className="tl-field" style={{ marginTop: 12 }}>
          Note (optional)
          <textarea value={note} maxLength={RECALL_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder="A few words" />
        </label>
      </Modal>
    </>
  );
}
