"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { offerTextAction, respondInlineAction, retryInlineAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * On a Sent row whose driver has no app: the dispatcher calls them and records the answer here, without opening the load. A no needs its reason (the server refuses one without), and the
 * reason typed is kept until it is saved. "Copy offer text" puts the driver-safe offer on the clipboard, to paste into a text message.
 */
export function AnswerForDriver({ loadId, loadNumber, driverName }: { loadId: string; loadNumber: string; driverName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [declining, setDeclining] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // When the browser will not copy, the offer is shown selected so it can be copied by hand.
  const [shown, setShown] = React.useState<string | null>(null);
  const [{ note }, setV, draft] = useDraft(`decline:${loadId}`, { note: "" });

  async function answer(response: "accepted" | "declined") {
    setBusy(true);
    setError(null);
    const got = await tried(() => respondInlineAction(loadId, response, note));
    setBusy(false);
    if (!got.ok) return setError(got.message);
    if (!got.value.ok) return setError(got.value.error);
    draft.saved();
    setDeclining(false);
    toast({ text: `${loadNumber}: ${got.value.message}`, tone: "ok" });
    router.refresh();
  }

  async function copy() {
    const got = await tried(() => offerTextAction(loadId));
    if (!got.ok) return setError(got.message);
    if (!got.value.ok) return setError(got.value.error);
    try {
      await navigator.clipboard.writeText(got.value.text);
      toast({ text: `The offer for ${driverName} is copied. Paste it into a text message.`, tone: "ok" });
    } catch {
      setShown(got.value.text);
    }
  }

  return (
    <span className="dq-ask" role="group" aria-label={`${driverName}'s answer`}>
      {error ? (
        <span className="tl-note warn" role="alert">
          {error}
        </span>
      ) : null}
      {shown ? (
        <textarea className="dq-offer" readOnly rows={6} value={shown} aria-label="The offer, to copy" ref={(el) => el?.select()} onBlur={() => setShown(null)} />
      ) : null}
      {declining ? (
        <>
          <input className="dq-why" aria-label="Why the driver declined" placeholder="Why they declined" value={note} onChange={(e) => setV({ note: e.target.value })} />
          <button type="button" className="t-btn sm" disabled={busy} onClick={() => void answer("declined")}>
            Save the no
          </button>
          <button type="button" className="t-btn sm" disabled={busy} onClick={() => setDeclining(false)}>
            Back
          </button>
        </>
      ) : (
        <>
          <button type="button" className="t-btn sm" onClick={() => void copy()}>
            Copy offer text
          </button>
          <button type="button" className="t-btn sm pri" disabled={busy} onClick={() => void answer("accepted")}>
            Accepted
          </button>
          <button type="button" className="t-btn sm" disabled={busy} onClick={() => setDeclining(true)}>
            Declined
          </button>
        </>
      )}
    </span>
  );
}

/** On a Sent row whose offer did not reach the driver's phone: try again now (the schedule keeps trying too). */
export function RetryDelivery({ loadId, loadNumber }: { loadId: string; loadNumber: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  return (
    <button
      type="button"
      className="t-btn sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const got = await tried(() => retryInlineAction(loadId));
        setBusy(false);
        const text = !got.ok ? got.message : got.value.ok ? got.value.message : got.value.error;
        toast({ text: `${loadNumber}: ${text}`, tone: got.ok && got.value.ok ? "ok" : "bad" });
        router.refresh();
      }}>
      {busy ? "Trying…" : "Retry"}
    </button>
  );
}
