"use client";

import { useSearchParams } from "next/navigation";
import React from "react";
import type { DraftControls } from "./use-draft";

/**
 * For a form that posts to a server action which sends the person back to the page with `?note=` (it worked) or `?error=` (it did not), which the toast then turns into a message.
 * A form like that cannot know the outcome where it is typed, so what it keeps must not be thrown away when it is sent, only when it is known to have worked:
 *
 *   const sent = useSubmitOutcome();
 *   <form action={act} onSubmit={() => sent(() => draft.discard())}>
 *
 * On a note the callback runs; on an error nothing is cleared and the person finds their fields as they left them. Reads the address in the same render as the toast does,
 * before the toast takes the note and error out of it.
 */
export function useSubmitOutcome(): (onWorked: () => void) => void {
  const params = useSearchParams();
  const note = params.get("note");
  const error = params.get("error");
  const waiting = React.useRef<(() => void) | null>(null);
  React.useEffect(() => {
    const worked = waiting.current;
    if (!worked) return;
    if (note) {
      waiting.current = null;
      worked();
    } else if (error) {
      waiting.current = null;
    }
  }, [note, error]);
  return React.useCallback((onWorked) => {
    waiting.current = onWorked;
  }, []);
}

/**
 * The same, for a field that sits inside a form the page itself draws (a server component, which cannot hold a draft): the field finds its form and clears its draft when that
 * form has worked. `anchor` is any element inside the form, such as a hidden span next to the field.
 */
export function useClearOnSuccess(anchor: React.RefObject<Element | null>, draft: DraftControls) {
  const sent = useSubmitOutcome();
  const latest = React.useRef(draft);
  latest.current = draft;
  React.useEffect(() => {
    const form = anchor.current?.closest("form");
    if (!form) return;
    const onSubmit = () => sent(() => latest.current.discard());
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [anchor, sent]);
}
