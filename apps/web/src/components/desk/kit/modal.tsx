"use client";

import React from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal that closes on Esc or a click outside, keeps Tab inside, and hands focus back to whatever opened it. */
export function Modal({ open, onClose, eyebrow, title, children, footer }: { open: boolean; onClose: () => void; eyebrow?: string; title: string; children?: React.ReactNode; footer?: React.ReactNode }) {
  const panel = React.useRef<HTMLDivElement>(null);
  const opener = React.useRef<HTMLElement | null>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>("[data-autofocus]") ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel.current) return;
      const els = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (els.length === 0) return;
      const a = els[0]!;
      const z = els[els.length - 1]!;
      if (e.shiftKey && document.activeElement === a) {
        e.preventDefault();
        z.focus();
      } else if (!e.shiftKey && document.activeElement === z) {
        e.preventDefault();
        a.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  // Portalled to the body so a table cell or a drawer around the trigger cannot style it (alignment, clipping, stacking).
  return createPortal(
    <div className="k-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="k-modal" ref={panel} role="dialog" aria-modal="true" aria-labelledby={id}>
        <header>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h2 id={id}>{title}</h2>
        </header>
        <div className="body">{children}</div>
        {footer ? <footer>{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

/** Confirm a consequential action. With `askReason`, the person gives a reason that is handed to onConfirm (and recorded by the caller). */
export function ConfirmDialog({ open, onClose, onConfirm, title, eyebrow, confirmLabel = "Confirm", destructive, askReason, children }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => void; title: string; eyebrow?: string; confirmLabel?: string; destructive?: boolean; askReason?: boolean; children?: React.ReactNode }) {
  const [reason, setReason] = React.useState("");
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  const blocked = askReason === true && reason.trim().length < 3;
  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={eyebrow}
      title={title}
      footer={
        <>
          <button type="button" className="tl-btn" onClick={onClose}>Cancel</button>
          <button type="button" className={`tl-btn ${destructive ? "danger" : "primary"}`} disabled={blocked} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </button>
        </>
      }>
      {children}
      {askReason ? (
        <label className="tl-field" style={{ marginTop: 12 }}>
          Reason (recorded in the audit trail)
          <textarea data-autofocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="A few words" />
        </label>
      ) : null}
    </Modal>
  );
}
