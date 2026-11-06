"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { acknowledgeSignalAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

/** Says someone is on this one. It leaves the open list until it clears, or gets worse; the server checks the person may see it. */
export function AcknowledgeSignalButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  async function go() {
    setBusy(true);
    const got = await tried(() => acknowledgeSignalAction(id));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    toast({ text: got.value.ok ? "Acknowledged." : got.value.error, tone: got.value.ok ? "ok" : "bad", ms: got.value.ok ? undefined : 8000 });
    router.refresh();
  }
  return (
    <button type="button" className="tl-btn sm" disabled={busy} onClick={() => void go()}>
      {busy ? "Saving…" : "Acknowledge"}
    </button>
  );
}
