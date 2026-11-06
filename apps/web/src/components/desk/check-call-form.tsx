"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { logCheckCallAction, removeCheckCallAction } from "@/app/(desk)/actions";
import { CALL_STATUSES } from "@/lib/asset-history";
import { DateInput } from "./date-input";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * Log a check call on a truck or a trailer: where the driver says they are, when they expect to arrive, how it is going, and a note. The time of the call and the arrival are typed on the carrier's
 * clock (`clock` says which, "CT"); the call time can be left blank for "now". What is typed is kept until the call is logged, like every form on the desk.
 */
const BLANK = { at: "", place: "", eta: "", status: "", spokeWith: "", loadId: "", note: "" };

export function CheckCallForm({ unit, openLoads, clock }: { unit: { kind: "truck" | "trailer"; id: string; name: string }; openLoads: Array<{ id: string; number: string }>; clock: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`check-call:${unit.kind}:${unit.id}`, BLANK);
  const [error, setError] = React.useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const got = await tried(() => logCheckCallAction({ unit: { kind: unit.kind, id: unit.id }, at: form.at, place: form.place, etaAt: form.eta, status: form.status, spokeWith: form.spokeWith, loadId: form.loadId, note: form.note }));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      draft.discard();
      toast({ text: `Check call logged on ${unit.name}.`, tone: "ok" });
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} aria-label={`Log a check call on ${unit.name}`}>
      <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
        <label className="tl-field" style={{ flex: "1 1 240px" }}>
          Where they are
          <input value={form.place} maxLength={200} placeholder="I-40 past Amarillo, or in the yard, door 4" onChange={(e) => setForm({ ...form, place: e.target.value })} />
        </label>
        <div className="tl-field">
          <span>Expected arrival ({clock})</span>
          <DateInput type="datetime-local" aria-label={`Expected arrival, ${clock}`} value={form.eta} onChange={(e) => setForm({ ...form, eta: e.target.value })} />
        </div>
        <label className="tl-field">
          How it is going
          <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
            <option value="">Not said</option>
            {CALL_STATUSES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="tl-field">
          Spoke with
          <input value={form.spokeWith} maxLength={100} size={14} placeholder="The driver" onChange={(e) => setForm({ ...form, spokeWith: e.target.value })} />
        </label>
        {openLoads.length > 0 ? (
          <label className="tl-field">
            About load
            <select value={form.loadId} onChange={(e) => setForm({ ...form, loadId: e.target.value })}>
              <option value="">No load</option>
              {openLoads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.number}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <div className="tl-field">
          <span>Time of the call ({clock}), blank for now</span>
          <DateInput type="datetime-local" aria-label={`Time of the call, ${clock}`} value={form.at} onChange={(e) => setForm({ ...form, at: e.target.value })} />
        </div>
        <label className="tl-field" style={{ flex: "1 1 100%" }}>
          Note
          <input value={form.note} maxLength={1000} placeholder="What else was said" onChange={(e) => setForm({ ...form, note: e.target.value })} />
        </label>
      </fieldset>
      {error ? (
        <p className="tl-note warn" role="alert" style={{ marginTop: 8 }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button type="submit" className="tl-btn primary sm" disabled={pending}>
          Log the call
        </button>
        {draft.kept ? (
          <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => draft.discard()}>
            Start over
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Take a call off that was logged by mistake. The audit trail keeps what it said. */
export function RemoveCheckCall({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  return (
    <button
      type="button"
      className="tl-btn ghost sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const got = await tried(() => removeCheckCallAction(id));
          if (!got.ok) return toast({ text: got.message, tone: "bad" });
          if (!got.value.ok) return toast({ text: got.value.error, tone: "bad" });
          toast({ text: "Check call removed.", tone: "ok" });
          router.refresh();
        })
      }>
      Remove
    </button>
  );
}
