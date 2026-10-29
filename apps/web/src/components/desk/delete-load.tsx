"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { deleteLoadAction, restoreLoadAction } from "@/app/(desk)/actions";
import { DELETE_REASONS } from "@/lib/disruptions";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";

/**
 * Delete a load that should never have been entered. It asks why (a short list, counted nowhere as lost), hides the load and its audit stays,
 * and the toast that follows has an Undo that puts it back exactly as it was.
 */
export function DeleteLoadButton({ loadId, loadNumber, driverName, blocked }: { loadId: string; loadNumber: string; driverName: string | null; blocked: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);
  const close = React.useCallback(() => setOpen(false), []);

  async function go() {
    setBusy(true);
    const out = await deleteLoadAction(loadId, reason, note);
    setBusy(false);
    if (!out.ok) {
      setMessage(out.error);
      return;
    }
    setOpen(false);
    toast({
      text: `${loadNumber} deleted.`,
      tone: "ok",
      ms: 20000,
      action: {
        label: "Undo",
        run: () =>
          void restoreLoadAction(loadId).then((back) => {
            toast({ text: back.ok ? `${loadNumber} is back.` : back.error, tone: back.ok ? "ok" : "bad" });
            router.refresh();
          })
      }
    });
    router.push("/loads");
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn sm danger"
        disabled={blocked != null}
        title={blocked ?? undefined}
        onClick={() => {
          setReason("");
          setNote("");
          setMessage(null);
          setOpen(true);
        }}>
        Delete load
      </button>
      <Modal
        open={open}
        onClose={close}
        eyebrow={loadNumber}
        title="Delete this load?"
        footer={
          <>
            {message ? (
              <span className="tl-note warn" role="alert" style={{ marginRight: "auto" }}>
                {message}
              </span>
            ) : null}
            <button type="button" className="tl-btn" onClick={close}>
              Back
            </button>
            <button type="button" className="tl-btn danger" disabled={busy || reason === ""} aria-busy={busy || undefined} onClick={() => void go()}>
              {busy ? "Deleting…" : "Delete the load"}
            </button>
          </>
        }>
        <div className="dlg-form">
          <p className="tl-note">
            For a duplicate or a slip. The load leaves the board, the planner and the numbers; its history stays in the audit log and you can undo this right after.
            {driverName ? ` ${driverName}'s assignment goes with it.` : ""} If the load fell through, cancel it instead so the reason is counted.
          </p>
          <label className="tl-field">
            Reason
            <select value={reason} onChange={(e) => setReason(e.target.value)} data-autofocus>
              <option value="" disabled>
                Pick one
              </option>
              {DELETE_REASONS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
          <label className="tl-field">
            Note (needed when the reason is Other)
            <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="A few words for the audit log" />
          </label>
        </div>
      </Modal>
    </>
  );
}
