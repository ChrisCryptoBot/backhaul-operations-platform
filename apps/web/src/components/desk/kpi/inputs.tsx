"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { saveKpiNoteAction, setLaneTargetAction } from "@/app/(desk)/actions";
import { useToast } from "../kit/toast";
import { useDraft } from "../kit/use-draft";

/**
 * The few things typed on the KPI screens. A lane's target rate per load, saved on its own button; the note for the weekly call, kept as it is typed and saved on its own button; and a button that reads
 * today's diesel price so the weekly history can build. A typed figure shows in the typed colour. The server decides who may save (dispatch or billing): `canEdit` only hides the controls.
 */
export function LaneTargetCell({ lane, target, canEdit }: { lane: string; target: number | null; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`lane-target:${lane}`, { rate: target == null ? "" : String(target) });
  const [error, setError] = React.useState("");
  if (!canEdit) return target == null ? <span className="dim">{"—"}</span> : <span className="rd-typed">{`$${target.toLocaleString("en-US")}`}</span>;
  return (
    <form
      className="lt-form"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const out = await setLaneTargetAction(lane, form.rate);
          if (!out.ok) return setError(out.error);
          setError("");
          draft.saved();
          toast({ text: out.changed ? (form.rate.trim() ? "Target saved." : "Target taken away.") : "Nothing changed.", tone: "ok" });
          router.refresh();
        });
      }}>
      <label className="db-sr-only" htmlFor={`lt-${lane}`}>{`Target rate per load for ${lane}`}</label>
      <input id={`lt-${lane}`} className="rd-typed" value={form.rate} inputMode="decimal" size={7} placeholder="none" maxLength={10} onChange={(e) => setForm({ rate: e.target.value })} aria-invalid={error ? true : undefined} title={error || "Dollars per load"} />
      <button type="submit" className="tl-btn ghost sm" disabled={pending} aria-busy={pending || undefined}>
        Set
      </button>
      {error ? <span className="tone-neg" role="alert">{error}</span> : null}
    </form>
  );
}

export function NotesBox({ weekKey, initial, canEdit, updatedBy }: { weekKey: string; initial: string; canEdit: boolean; updatedBy: string | null }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`kpi-note:${weekKey}`, { body: initial });
  const [error, setError] = React.useState("");
  if (!canEdit) return initial ? <p className="kn-read">{initial}</p> : <p className="tl-sub">No notes for this week.</p>;
  return (
    <form
      className="kn-form"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const out = await saveKpiNoteAction(weekKey, form.body);
          if (!out.ok) return setError(out.error);
          setError("");
          draft.saved();
          toast({ text: out.changed ? "Notes saved." : "Nothing changed.", tone: "ok" });
          router.refresh();
        });
      }}>
      <label className="db-sr-only" htmlFor="kn-body">Notes for the call</label>
      <textarea id="kn-body" className="rd-typed" rows={5} maxLength={4000} value={form.body} placeholder="Operational challenges, what to discuss on the call." onChange={(e) => setForm({ body: e.target.value })} />
      <div className="kn-bar">
        <button type="submit" className="tl-btn sm" disabled={pending} aria-busy={pending || undefined}>
          Save notes
        </button>
        {updatedBy ? <span className="tl-sub">{`Last saved by ${updatedBy}`}</span> : null}
        {error ? <span className="tone-neg" role="alert">{error}</span> : null}
      </div>
    </form>
  );
}

/** Reads today's national diesel price from EIA (which the desk then keeps), so the surcharge summary can compare weeks. */
export function DieselReadButton() {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  return (
    <button
      type="button"
      className="tl-btn ghost sm"
      disabled={pending}
      aria-busy={pending || undefined}
      onClick={() =>
        start(async () => {
          try {
            const r = await fetch("/fuel/eia?fuel=diesel", { cache: "no-store" });
            const j = (await r.json()) as { ok?: boolean; reason?: string; pricePerGallon?: number; period?: string };
            if (j.ok) toast({ text: `Diesel $${j.pricePerGallon?.toFixed(3)} for the week of ${j.period} kept.`, tone: "ok" });
            else toast({ text: j.reason === "no_key" ? "No EIA key is set on this server." : "The price is not available right now.", tone: "bad" });
            router.refresh();
          } catch {
            toast({ text: "Could not read the price.", tone: "bad" });
          }
        })
      }>
      Read the diesel price now
    </button>
  );
}
