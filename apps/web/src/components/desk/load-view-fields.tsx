"use client";

import React from "react";
import { useDraft } from "./kit/use-draft";
import { useClearOnSuccess } from "./kit/use-submit-outcome";

/**
 * Fields the load page draws inside forms of its own (it is a server component, and cannot keep what is typed). Each keeps its text until the form around it has worked.
 */

/** The demo control's "why, if the driver declines" note. */
export function DeclineNote({ loadId }: { loadId: string }) {
  const [note, setNote, draft] = useDraft(`decline-note:${loadId}`, "");
  const anchor = React.useRef<HTMLSpanElement>(null);
  useClearOnSuccess(anchor, draft);
  return (
    <>
      <input name="note" placeholder="Why, if the driver declines" maxLength={200} aria-label="Why the driver declines" value={note} onChange={(e) => setNote(e.target.value)} />
      <span ref={anchor} hidden />
    </>
  );
}
