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
  /**
   * When set, shows a required reason `<select>` (mutually exclusive with the free-text `reason`).
   * The chosen value is passed to `onConfirm` as `reason`; when it equals `detailWhen`, a detail
   * textarea is revealed and its trimmed value is passed as `detail`.
   */
  reasonSelect?: {
    label: string;
    options: readonly { value: string; label: string }[];
    /** Reveal the detail textarea when the selected value equals this (e.g. "OTHER"). */
    detailWhen?: string;
    detailLabel?: string;
    detailPlaceholder?: string;
    /** Require a non-empty detail when the detail textarea is shown. */
    detailRequired?: boolean;
  };
  confirmLabel?: string;
  cancelLabel?: string;
  busyLabel?: string;
  /** Renders the confirm button with the destructive (red) treatment. */
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (reason: string, detail?: string) => void;
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
  reasonSelect,
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
  const [selectValue, setSelectValue] = React.useState("");
  const [detailValue, setDetailValue] = React.useState("");
  const minLength = reason ? reason.minLength ?? 1 : 0;

  const showDetail = !!reasonSelect && !!reasonSelect.detailWhen && selectValue === reasonSelect.detailWhen;
  const detailOk = !showDetail || !reasonSelect?.detailRequired || detailValue.trim().length > 0;
  const reasonOk = reasonSelect
    ? selectValue.length > 0 && detailOk
    : !reason || reasonValue.trim().length >= minLength;

  function submit() {
    if (busy || !reasonOk) return;
    if (reasonSelect) {
      onConfirm(selectValue, showDetail ? detailValue.trim() || undefined : undefined);
    } else {
      onConfirm(reasonValue.trim());
    }
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
          {reasonSelect ? (
            <label
              className="db-field-label"
              style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: message ? 12 : 0 }}
            >
              {reasonSelect.label}
              <select
                className="db-input"
                value={selectValue}
                disabled={busy}
                onChange={(event) => setSelectValue(event.target.value)}
              >
                <option value="" disabled>
                  Select a reason…
                </option>
                {reasonSelect.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              {showDetail ? (
                <textarea
                  className="db-input"
                  rows={2}
                  value={detailValue}
                  placeholder={reasonSelect.detailPlaceholder}
                  disabled={busy}
                  aria-label={reasonSelect.detailLabel ?? "Detail"}
                  onChange={(event) => setDetailValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                />
              ) : null}
            </label>
          ) : null}
          {reason ? (
            <label
              className="db-field-label"
              style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: message ? 12 : 0 }}
            >
              {reason.label}
              <textarea
                className="db-input"
                rows={2}
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
