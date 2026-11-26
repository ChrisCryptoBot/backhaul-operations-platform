"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { sendInlineAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

/**
 * Send a load that already has its driver, from the queue row: one press. The server decides what is missing; a load that lacks something asks once, in place, whether to send it anyway
 * (the driver may have it another way), and the audit says what it went without.
 */
export function SendButton({ loadId, loadNumber }: { loadId: string; loadNumber: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  const [missing, setMissing] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  async function send(anyway: boolean) {
    setBusy(true);
    setError(null);
    const got = await tried(() => sendInlineAction(loadId, anyway));
    setBusy(false);
    if (!got.ok) return setError(got.message);
    const out = got.value;
    if (!out.ok) {
      if (out.code === "not_ready" && out.missing) return setMissing(out.missing);
      return setError(out.error);
    }
    setMissing(null);
    toast({ text: `${loadNumber}: ${out.message}`, tone: "ok" });
    router.refresh();
  }

  if (missing) {
    return (
      <span className="dq-ask" role="group" aria-label={`Send ${loadNumber} without ${missing}?`}>
        <span className="tl-sub">Missing {missing}.</span>
        <button type="button" className="t-btn sm" disabled={busy} onClick={() => void send(true)}>
          {busy ? "Sending…" : "Send anyway"}
        </button>
        <button type="button" className="t-btn sm" disabled={busy} onClick={() => setMissing(null)}>
          Not yet
        </button>
      </span>
    );
  }
  return (
    <span className="dq-ask">
      {error ? (
        <span className="tl-note warn" role="alert">
          {error}
        </span>
      ) : null}
      <button type="button" className="t-btn sm pri" disabled={busy} aria-busy={busy || undefined} onClick={() => void send(false)}>
        {busy ? "Sending…" : "Send"}
      </button>
    </span>
  );
}
