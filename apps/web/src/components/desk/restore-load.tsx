"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { restoreLoadAction } from "@/app/(desk)/actions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";

/** Put a deleted load back as it was. The server re-checks the load number, the truck and the driver, and says what is in the way. */
export function RestoreLoadButton({ loadId, loadNumber }: { loadId: string; loadNumber: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = React.useState(false);
  async function go() {
    setBusy(true);
    const got = await tried(() => restoreLoadAction(loadId));
    setBusy(false);
    if (!got.ok) return toast({ text: got.message, tone: "bad" });
    toast({ text: got.value.ok ? `${loadNumber} is back.` : got.value.error, tone: got.value.ok ? "ok" : "bad", ms: got.value.ok ? undefined : 10000 });
    router.refresh();
  }
  return (
    <button type="button" className="tl-btn sm" disabled={busy} onClick={() => void go()}>
      {busy ? "Restoring…" : "Restore"}
    </button>
  );
}
