"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { setDriverCodeAction } from "@/app/(desk)/actions";
import { cleanDriverCode } from "@/lib/driver-code";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/** A driver's code, editable by a driver manager or an admin. The code is made once from the name and does not follow a rename; a code another driver holds is refused. */
export function DriverCodeEdit({ driverId, code }: { driverId: string; code: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`driver-code:${driverId}`, { code: code ?? "" });
  const [error, setError] = React.useState("");
  const save = () =>
    start(async () => {
      const out = await setDriverCodeAction(driverId, form.code);
      if (!out.ok) return setError(out.error);
      setError("");
      draft.saved();
      toast({ text: "Code saved.", tone: "ok" });
      router.refresh();
    });
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <label className="tl-field" style={{ margin: 0 }}>
        <span className="db-sr-only">Driver code</span>
        <input value={form.code} maxLength={8} size={9} aria-label="Driver code" onChange={(e) => setForm({ code: cleanDriverCode(e.target.value) })} />
      </label>
      <button type="button" className="tl-btn ghost sm" disabled={pending || form.code === (code ?? "")} onClick={save}>
        Save code
      </button>
      {error ? (
        <span className="tl-note warn" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}
