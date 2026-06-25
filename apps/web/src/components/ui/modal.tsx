"use client";

import React from "react";
import { CloseIcon } from "@/components/icons";

export interface ModalProps {
  /** Title shown in the modal header. When a plain string, it doubles as the dialog's aria-label. */
  title: React.ReactNode;
  /** Optional small uppercase eyebrow above the title. When set, the header gains a close (X) button. */
  eyebrow?: React.ReactNode;
  /** Called when the user dismisses (Esc, backdrop click, close button, or a Cancel control). */
  onClose: () => void;
  children: React.ReactNode;
  /** Footer actions, rendered in the standard right-aligned button row. */
  footer?: React.ReactNode;
  /** Accessible label when `title` is not a plain string. */
  ariaLabel?: string;
  /** While true, Esc and backdrop clicks are ignored (a submit is in flight). */
  busy?: boolean;
  /** Width override for wider dialogs: a px number, or the named "wide" (640) / "xwide" (760). Defaults to the board's 460px. */
  width?: number | "wide" | "xwide";
}

function resolveWidth(width: ModalProps["width"]): number | undefined {
  if (width === "wide") return 640;
  if (width === "xwide") return 760;
  return width;
}

/**
 * The app's shared modal dialog — the gold-standard chrome the Daily Tracker uses inline.
 * Renders the `.db-modal-overlay` → `.db-modal` → head/body/footer structure from board.css,
 * adds Esc-to-close, backdrop-to-close, and first-focusable autofocus so every dialog behaves
 * identically. No new styles: this is purely a reusable wrapper over existing tokens.
 */
export function Modal({ title, eyebrow, onClose, children, footer, ariaLabel, busy = false, width }: ModalProps) {
  const boxRef = React.useRef<HTMLDivElement | null>(null);
  const resolvedWidth = resolveWidth(width);

  React.useEffect(() => {
    // Focus the first interactive control (matches the board dialogs' autoFocus behavior).
    const box = boxRef.current;
    if (!box) return;
    const focusable = box.querySelector<HTMLElement>(
      'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
    );
    (focusable ?? box).focus();
  }, []);

  return (
    <div
      className="db-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel ?? (typeof title === "string" ? title : undefined)}
      onMouseDown={(event) => {
        // Close only when the press both starts and ends on the backdrop itself.
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="db-modal"
        ref={boxRef}
        tabIndex={-1}
        style={resolvedWidth ? { width: `min(${resolvedWidth}px, 100%)` } : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        {eyebrow ? (
          <div className="db-modal-head has-eyebrow">
            <div>
              <div className="db-modal-eyebrow">{eyebrow}</div>
              <div className="db-modal-title">{title}</div>
            </div>
            <button type="button" className="db-modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <CloseIcon size={16} />
            </button>
          </div>
        ) : (
          <div className="db-modal-head">{title}</div>
        )}
        <div className="db-modal-body">{children}</div>
        {footer ? <div className="db-modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}
