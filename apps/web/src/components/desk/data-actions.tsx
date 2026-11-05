"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { calculateIftaAction, syncFuelCardsAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

/** A button that asks the server, says what it did, and says in words why it could not. */
function useAsk() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [error, setError] = React.useState("");
  const ask = (call: () => Promise<{ ok: true; text: string } | { ok: false; error: string }>) =>
    start(async () => {
      const got = await tried(call);
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      toast({ text: got.value.text, tone: "ok" });
      router.refresh();
    });
  return { pending, error, ask };
}

const Note = ({ error }: { error: string }) =>
  error ? (
    <p className="tl-note warn" role="alert" style={{ margin: "6px 0 0" }}>
      {error}
    </p>
  ) : null;

/** Reads the last days of card purchases for every truck that has a card. */
export function FuelSyncButton({ days, reason }: { days: number; reason: string | null }) {
  const { pending, error, ask } = useAsk();
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      <button
        type="button"
        className="tl-btn"
        disabled={pending || !!reason}
        title={reason ?? undefined}
        onClick={() =>
          ask(async () => {
            const out = await syncFuelCardsAction(days);
            return out.ok ? { ok: true, text: out.fresh > 0 ? `${out.fresh} new ${out.fresh === 1 ? "purchase" : "purchases"} read from ${out.trucks} ${out.trucks === 1 ? "truck" : "trucks"}.` : `Nothing new for ${out.trucks} ${out.trucks === 1 ? "truck" : "trucks"}.` } : { ok: false, error: out.error };
          })
        }>
        {pending ? "Reading…" : "Read card purchases"}
      </button>
      {reason ? <span className="tl-sub">{reason}</span> : null}
      <Note error={error} />
    </span>
  );
}

/** Works out a quarter's miles by state from the quarter's delivered loads, and keeps the answer. */
export function IftaCalcButton({ quarter, reason, again }: { quarter: string; reason: string | null; again: boolean }) {
  const { pending, error, ask } = useAsk();
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
      <button
        type="button"
        className="tl-btn primary"
        disabled={pending || !!reason}
        title={reason ?? undefined}
        onClick={() =>
          ask(async () => {
            const out = await calculateIftaAction(quarter);
            return out.ok ? { ok: true, text: `${quarter}: ${out.jurisdictions.length} ${out.jurisdictions.length === 1 ? "state" : "states"} from ${out.loads ?? 0} delivered ${out.loads === 1 ? "load" : "loads"}.` } : { ok: false, error: out.error };
          })
        }>
        {pending ? "Working it out…" : again ? "Work it out again" : "Work out this quarter"}
      </button>
      {reason ? <span className="tl-sub">{reason}</span> : null}
      <Note error={error} />
    </span>
  );
}
