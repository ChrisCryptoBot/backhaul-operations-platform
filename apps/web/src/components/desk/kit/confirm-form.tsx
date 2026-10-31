"use client";

import React from "react";
import { ConfirmDialog } from "./modal";

/**
 * A button that asks "are you sure?" (optionally for a reason) and only then submits a server action.
 * The reason travels in a field called `reason`, next to the hidden `fields`.
 */
export function ConfirmForm({
  action,
  fields,
  label,
  title,
  eyebrow,
  confirmLabel,
  destructive,
  askReason,
  children
}: {
  action: (formData: FormData) => void | Promise<void>;
  fields: Record<string, string>;
  label: string;
  title: string;
  eyebrow?: string;
  confirmLabel: string;
  destructive?: boolean;
  askReason?: boolean;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const form = React.useRef<HTMLFormElement>(null);
  const reason = React.useRef<HTMLInputElement>(null);
  // While the action runs the button is shut: a second press (or a double click on the confirmation) cannot send the same change twice.
  const [pending, start] = React.useTransition();
  return (
    <>
      <button type="button" className={`tl-btn sm${destructive ? " danger" : ""}`} disabled={pending} aria-busy={pending || undefined} onClick={() => setOpen(true)}>
        {label}
      </button>
      <form ref={form} hidden onSubmit={(e) => e.preventDefault()}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <input ref={reason} type="hidden" name="reason" defaultValue="" />
      </form>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        eyebrow={eyebrow}
        confirmLabel={confirmLabel}
        destructive={destructive}
        askReason={askReason}
        onConfirm={(text) => {
          if (reason.current) reason.current.value = text;
          setOpen(false);
          if (!form.current || pending) return;
          const data = new FormData(form.current);
          start(async () => {
            await action(data);
          });
        }}>
        {children}
      </ConfirmDialog>
    </>
  );
}
