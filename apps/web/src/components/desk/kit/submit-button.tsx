"use client";

import React from "react";
import { useFormStatus } from "react-dom";

/**
 * A submit button for a form that runs a server action: while the action is running it is disabled (and says so), so a second click cannot send the same change twice. Without this a
 * double click on Send, Assign or Cancel ran the action twice and showed a red "already sent" over a success. Must sit inside the form it submits.
 */
export function SubmitButton({ children, className, name, value, pending: pendingText }: { children: React.ReactNode; className?: string; name?: string; value?: string; pending?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} name={name} value={value} disabled={pending} aria-busy={pending || undefined}>
      {pending && pendingText ? pendingText : children}
    </button>
  );
}
