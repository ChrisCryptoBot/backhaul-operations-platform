"use client";

import React from "react";
import { Modal } from "./modal";
import { WarningIcon } from "@/components/icons";

export interface ConfirmDialogProps {
  title: React.ReactNode;
  /** Explanatory copy shown above any reason field. */
  message?: React.ReactNode;
  /**
   * When set, shows a required reason field; its trimmed value is passed to `onConfirm`.
   * Omit for a plain yes/no confirmation.
   */
  reason?: {
    label: string;
    minLength?: number;
    placeholder?: string;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  /** Renders the confirm button with the destructive (red) treatment. */
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

/**
 * Standard confirmation dialog built on {@link Modal}. Replaces every `window.prompt()` /
 * `window.confirm()` call: destructive actions get a red confirm button and an optional required
 * reason textarea (mirroring the board's delete-load dialog), with Enter-to-confirm.
 */
export function ConfirmDialog({
  title,
  message,
  reason,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busyLabel = "Working…",
  destructive = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm
}: ConfirmDialogProps) {
  const [reasonValue, setReasonValue] = React.useState("");
  const minLength = reason ? reason.minLength ?? 1 : 0;
  const reasonOk = !reason || reasonValue.trim().length >= minLength;

  function submit() {
    if (busy || !reasonOk) return;
    onConfirm(reasonValue.trim());
  }

  return (
    <Modal
      title={title}
      busy={busy}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="db-btn db-btn-ghost" disabled={busy} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`db-btn${destructive ? " db-btn-danger" : ""}`}
            disabled={busy || !reasonOk}
            aria-busy={busy}
            onClick={submit}
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </>
      }
    >
      <div className="db-confirm-row">
        {destructive ? (
          <span className="db-confirm-ic" aria-hidden="true">
            <WarningIcon size={18} />
          </span>
        ) : null}
        <div style={{ flex: 1, minWidth: 0 }}>
          {message ? <p className="db-confirm-msg">{message}</p> : null}
          {reason ? (
            <label className="db-field-label" style={{ marginTop: message ? 12 : 0 }}>
              {reason.label}
              <textarea
                className="db-input"
                rows={3}
                value={reasonValue}
                placeholder={reason.placeholder}
                disabled={busy}
                onChange={(event) => setReasonValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
              />
            </label>
          ) : null}
          {error ? (
            <div className="db-error-banner" role="status" aria-live="polite">
              <WarningIcon size={14} />
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
