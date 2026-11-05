"use client";

import React from "react";
import { DraftStore, draftStorageKey, mergeDraft, sameValue } from "@/lib/draft";

/**
 * Every form in the desk keeps what has been typed into it until the person changes it themselves: going to another module, refreshing, or closing the tab does not lose it.
 * `useDraft` is `useState` for a form's values with that rule built in (docs/DESIGN_BRIEF.md, "Fields are kept"; tests/forms-keep-fields.test.ts fails for a form without it).
 *
 *   const [values, setValues, draft] = useDraft("truck:new", BLANK);
 *
 * - `key` names the form, and the record when it edits one ("load-edit:<id>"): the same key on another visit is the same draft.
 * - `initial` is how the form starts with nothing kept: blank, or the record as it is saved.
 * - What is kept is put back before the page is first drawn, so there is no flash of an empty form.
 * - It is written as the person types, and again the moment they leave, so nothing typed in the last instant is lost.
 * - It is cleared by `draft.saved()` once a save has gone through (the fields stay as they are), or `draft.discard()` for "Start over" and Cancel (the fields go back to `initial`).
 */
const store = new DraftStore(
  typeof window === "undefined"
    ? null
    : (() => {
        try {
          return window.localStorage;
        } catch {
          return null;
        }
      })()
);

const DraftScopeContext = React.createContext("desk");
/** Whose drafts these are: the desk's shell sets it to the workspace and the person signed in, so two people on one browser do not see each other's. */
export const DraftScope = DraftScopeContext.Provider;

const useIsoLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

export type DraftControls = {
  /** The fields were filled in from what was kept, and not yet saved or started over. */
  kept: boolean;
  /** The record this form edits has changed since the draft was started. */
  changedSince: boolean;
  /** A save went through: forget the draft, leave the fields as they are. */
  saved: () => void;
  /** Start over: forget the draft and put the fields back to how the form starts. */
  discard: () => void;
};

export function useDraft<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>, DraftControls] {
  const scope = React.useContext(DraftScopeContext);
  const full = draftStorageKey(scope, key);
  const initialJson = JSON.stringify(initial);
  const [value, setValue] = React.useState<T>(initial);
  const [kept, setKept] = React.useState<null | { changedSince: boolean }>(null);
  // What the unmount and page-hide handlers need, which must not go stale in a closure.
  const live = React.useRef({ full, initial, initialJson, baselineJson: initialJson, value, ready: false, first: true });
  const prev = React.useRef<T>(value);

  // What the form starts from changes when its content changes, not when a new object with the same content is passed (a literal in the caller is a new object every render, and
  // would otherwise reset the baseline of a form that has just been saved, and keep it all over again when it is left).
  useIsoLayoutEffect(() => {
    live.current.initial = initial;
    live.current.initialJson = initialJson;
    live.current.baselineJson = initialJson;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJson]);

  useIsoLayoutEffect(() => {
    live.current.value = value;
  });

  // Put back what was kept, before the first paint. A key that changes (the same form on another record) does it again.
  useIsoLayoutEffect(() => {
    const l = live.current;
    l.full = full;
    const rec = store.get<T>(full);
    const first = l.first;
    l.first = false;
    l.ready = true;
    if (!rec) {
      setKept(null);
      if (!first) {
        l.value = l.initial;
        prev.current = l.initial;
        setValue(l.initial);
      }
      return;
    }
    if (sameValue(rec.v, l.initial)) {
      store.drop(full);
      setKept(null);
      return;
    }
    const merged = mergeDraft(l.initial, rec.v);
    l.value = merged;
    setValue(merged);
    setKept({ changedSince: rec.base !== l.initialJson });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full]);

  const write = React.useCallback(() => {
    const l = live.current;
    if (!l.ready || JSON.stringify(l.value) === l.baselineJson) return;
    store.put(l.full, { v: l.value, base: l.initialJson, at: Date.now() });
  }, []);

  // Written a moment after typing stops. Going back to how it started is nothing to keep.
  React.useEffect(() => {
    const l = live.current;
    if (!l.ready || Object.is(prev.current, value)) return;
    prev.current = value;
    if (JSON.stringify(value) === l.baselineJson) {
      store.drop(l.full);
      return;
    }
    const t = window.setTimeout(write, 150);
    return () => window.clearTimeout(t);
  }, [value, write]);

  // And at once when the person leaves: to another module (this form unmounts) or away from the page.
  React.useEffect(() => {
    window.addEventListener("pagehide", write);
    return () => {
      window.removeEventListener("pagehide", write);
      write();
    };
  }, [write]);

  const saved = React.useCallback(() => {
    const l = live.current;
    l.baselineJson = JSON.stringify(l.value);
    store.drop(l.full);
    setKept(null);
  }, []);

  const discard = React.useCallback(() => {
    const l = live.current;
    store.drop(l.full);
    l.baselineJson = l.initialJson;
    l.value = l.initial;
    prev.current = l.initial;
    setValue(l.initial);
    setKept(null);
  }, []);

  return [value, setValue, { kept: kept != null, changedSince: kept?.changedSince ?? false, saved, discard }];
}

/**
 * Forgets a kept draft as soon as the page that holds this is reached. For a form whose action sends the person on to another page when it works (the request forms),
 * which cannot tell the form that it did: the page they land on does.
 */
export function ForgetDraft({ draftKey }: { draftKey: string }) {
  const scope = React.useContext(DraftScopeContext);
  React.useEffect(() => {
    store.drop(draftStorageKey(scope, draftKey));
  }, [scope, draftKey]);
  return null;
}

/** Says, where a form has been filled in from what was kept, that it was, and lets the person start over. Shows nothing otherwise. */
export function DraftNote({ draft, what = "this form" }: { draft: DraftControls; what?: string }) {
  if (!draft.kept) return null;
  return (
    <p className="tl-note dn-note" role="status">
      {`Picked up where you left off on ${what}${draft.changedSince ? ", though it has changed since" : ""}. `}
      <button type="button" className="tl-btn ghost sm" onClick={draft.discard}>
        Start over
      </button>
    </p>
  );
}
