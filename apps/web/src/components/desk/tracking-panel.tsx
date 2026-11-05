"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { shareLocationAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

/**
 * Tracking on one load: share where the truck is with the customer's tracking network, get the link the customer follows, and stop. Sharing a truck's position with anyone else is the
 * carrier's choice for THIS load, so the button stays off until the box is ticked, and the server refuses a share without it. With the simulator the link is on a name that cannot open.
 */
export function TrackingPanel({ loadId, loadNumber, shared, providerName, sandbox, reason, canStop }: { loadId: string; loadNumber: string; shared: { url: string; at: string } | null; providerName: string | null; sandbox: boolean; /** Why sharing cannot start now, in words, or null. */ reason: string | null; canStop: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [agree, setAgree] = React.useState(false);
  const [error, setError] = React.useState("");
  const [copied, setCopied] = React.useState(false);

  const go = (share: boolean) =>
    start(async () => {
      const got = await tried(() => shareLocationAction(loadId, share, share && agree));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      setAgree(false);
      toast({ text: share ? `Location of ${loadNumber} is being shared.` : `Stopped sharing ${loadNumber}.`, tone: "ok" });
      router.refresh();
    });

  const copy = async () => {
    if (!shared) return;
    try {
      await navigator.clipboard.writeText(shared.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the link is on screen to select */
    }
  };

  return (
    <div className="trk">
      {shared ? (
        <>
          <dl className="tl-kv" style={{ marginBottom: 8 }}>
            <dt>Sharing with</dt>
            <dd>{providerName ?? "A tracking company"}{sandbox ? " (simulator)" : ""} since {shared.at}</dd>
            <dt>Link to send</dt>
            <dd>
              <code className="t-typed" style={{ wordBreak: "break-all" }}>{shared.url}</code>{" "}
              <button type="button" className="t-btn sm" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
            </dd>
          </dl>
          {sandbox ? <p className="tl-note">This is the simulator&apos;s link: it is on a name that cannot open, so nothing real is reached.</p> : null}
          <button type="button" className="tl-btn sm" disabled={pending || !canStop} onClick={() => go(false)}>
            Stop sharing
          </button>
        </>
      ) : (
        <>
          <p className="tl-note" style={{ marginBottom: 8 }}>Not shared. Sharing gives {providerName ?? "the tracking company"} this truck&apos;s position for this load, and returns a link the customer can follow.</p>
          <label className="trk-agree" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 8 }}>
            <input type="checkbox" checked={agree} disabled={!!reason || pending} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to share where the truck is for load {loadNumber}, and for this load only.</span>
          </label>
          <span className="rb" style={{ display: "inline-flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
            <button type="button" className="tl-btn primary sm" disabled={!!reason || !agree || pending} onClick={() => go(true)}>
              Share this load&apos;s location
            </button>
            {reason ? <span className="tl-sub">{reason}</span> : null}
          </span>
        </>
      )}
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
