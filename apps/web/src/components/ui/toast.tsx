"use client";

import React from "react";
import { CheckIcon } from "@/components/icons";

export interface ToastState {
  message: string;
  /** When provided, an "Undo" affordance is shown that calls this handler. */
  onUndo?: () => void;
}

export interface UndoToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms (matches the board's 5s undo window). */
  durationMs?: number;
}

/**
 * Success/undo toast in the design's `.db-toast` style: pinned bottom-center with a success
 * check, the message, and (when `onUndo` is provided) an accent "Undo" pill. Auto-dismisses
 * after `durationMs`.
 */
export function UndoToast({ toast, onDismiss, durationMs = 5000 }: UndoToastProps) {
  React.useEffect(() => {
    if (!toast) return;
    const timerId = window.setTimeout(onDismiss, durationMs);
    return () => window.clearTimeout(timerId);
  }, [toast, durationMs, onDismiss]);

  if (!toast) return null;

  return (
    <div className="db-toast" role="status" aria-live="polite">
      <span className="ok" aria-hidden="true">
        <CheckIcon size={12} />
      </span>
      <span>{toast.message}</span>
      {toast.onUndo ? (
        <button
          type="button"
          className="db-toast-undo"
          onClick={() => {
            toast.onUndo?.();
            onDismiss();
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

/**
 * Small hook that owns toast state + a stable show/clear API, so pages don't re-implement the
 * timer/dismiss wiring. `show({ message, onUndo? })` replaces any current toast.
 */
export function useToast() {
  const [toast, setToast] = React.useState<ToastState | null>(null);
  const show = React.useCallback((next: ToastState) => setToast(next), []);
  const clear = React.useCallback(() => setToast(null), []);
  return { toast, show, clear };
}
