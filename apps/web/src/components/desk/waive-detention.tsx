"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { waiveDetentionAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { ConfirmDialog } from "./kit/modal";
import { useToast } from "./kit/toast";
import { tried } from "./kit/tried";

/**
 * Mark unbilled detention on a delivered load as waived, with a reason kept in the audit trail. Once waived, it leaves the
 * Invoices recovery card and clears the unbilled-detention alert on the load.
 */
export function WaiveDetentionButton({ loadId, loadNumber, amount }: { loadId: string; loadNumber: string | null; amount: number }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<string | null>(null);

  async function run(reason: string) {
    if (busy) return;
    setBusy(true);
    try {
      const got = await tried(() => waiveDetentionAction(loadId, reason));
      if (!got.ok) {
        setMessage(got.message);
        return;
      }
      const out = got.value;
      if (!out.ok) {
        setMessage(out.error ?? "That detention could not be waived.");
        return;
      }
      setOpen(false);
      toast({ text: `Detention waived on ${loadNumber ?? "the load"}.`, tone: "ok" });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="tl-btn sm"
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={() => {
          setMessage(null);
          setOpen(true);
        }}>
        {busy ? "Waiving…" : "Mark as waived"}
      </button>
      <ConfirmDialog
        open={open}
        onClose={() => !busy && setOpen(false)}
        onConfirm={(reason) => void run(reason)}
        eyebrow={loadNumber ?? "Detention"}
        title={`Waive ${usd(amount, 2)} of detention?`}
        confirmLabel={busy ? "Waiving…" : "Mark as waived"}
        askReason>
        <p className="tl-note">
          Use this when the detention will not be billed (for example, the customer refused it or it was forgiven). The reason stays in the audit trail, and the load leaves the unbilled detention list.
        </p>
        {message ? (
          <p className="tl-note warn" role="alert">
            {message}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
