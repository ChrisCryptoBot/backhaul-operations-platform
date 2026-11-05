"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { adjustTrailerDwellAction, clearTrailerDwellAction, waiveTrailerDwellAction } from "@/app/(desk)/actions";
import { usd } from "@/lib/desk-format";
import { dwellSentence } from "@/lib/radar";
import type { Dwell } from "@/lib/telematics";
import { tried } from "./kit/tried";
import { Modal } from "./kit/modal";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * A dropped trailer's dwell, and the right of a dispatcher or a billing person to change it. The company's terms (Settings, Rules) are the start; a figure a person types for this stay is the
 * last word and shows in the typed colour with who typed it; a waived fee reads WAIVED. Nothing here is automatic: the desk computes, a person decides.
 */
export type DwellTyped = { rate: number | null; days: number | null; waived: boolean; by: string | null; note: string | null };

/** The one line (a square, the words) and, beneath it, whose figures they are. */
export function DwellLine({ d, freeHours, typed }: { d: Dwell; freeHours: number; typed: DwellTyped }) {
  const isTyped = d.source.rate === "typed" || d.source.days === "typed" || d.waived;
  const tone = isTyped ? "rd-typed" : d.alert ? "rd-leak" : "rd-sub";
  const source = d.waived
    ? `Waived${typed.by ? ` by ${typed.by}` : ""}${typed.note ? `: ${typed.note}` : ""}`
    : isTyped
      ? `Typed${typed.by ? ` by ${typed.by}` : ""}: ${[d.source.rate === "typed" ? `${usd(d.rate, 2)} a day` : null, d.source.days === "typed" ? `${d.billableDays} billable days` : null].filter(Boolean).join(", ")}. Company: ${usd(d.computedRate, 2)} a day, ${d.computedDays} days over.${typed.note ? ` ${typed.note}` : ""}`
      : `Company terms: ${freeHours}h free, then ${usd(d.computedRate, 2)} a day.`;
  return (
    <div>
      <div className={tone} style={{ font: "600 11px/16px var(--mono)" }}>{`■ ${dwellSentence(d, freeHours)}`}</div>
      <div className={isTyped ? "rd-typed" : "rd-sub"} style={{ font: "500 11px/16px var(--mono)", opacity: isTyped ? 0.85 : 1 }}>
        {source}
      </div>
    </div>
  );
}

/** The adjust dialog: type a rate or the billable days, waive the fee, or go back to the company's figure. */
export function DwellAdjust({ trailerId, number, d, typed, freeHours }: { trailerId: string; number: string; d: Dwell; typed: DwellTyped; freeHours: number }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = React.useTransition();
  const [open, setOpen] = React.useState(false);
  const [form, setForm, draft] = useDraft(`dwell:${trailerId}`, { rate: typed.rate == null ? "" : String(typed.rate), days: typed.days == null ? "" : String(typed.days), note: typed.note ?? "" });
  const [error, setError] = React.useState("");
  const isTyped = typed.rate != null || typed.days != null || typed.waived;

  const run = (job: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, after?: () => void) =>
    start(async () => {
      const got = await tried(job);
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      draft.saved();
      after?.();
      toast({ text: done, tone: "ok" });
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <button type="button" className="tl-btn ghost sm" onClick={() => setOpen(true)}>
        {isTyped ? "Change" : "Adjust"}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={`${number}: dwell charge`} eyebrow="Trailer dwell">
        <div style={{ display: "grid", gap: 10 }}>
          <p className="tl-sub">
            Company terms: {freeHours}h free, then {usd(d.computedRate, 2)} a day. As it stands the company figure is {d.computedDays} days over, {usd(d.computedAmount, 2)}. Type a rate or the billable days to replace them for this stay, or waive the fee. Leave a box blank to follow the company.
          </p>
          <fieldset disabled={pending} style={{ border: 0, padding: 0, margin: 0, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
            <label className="tl-field">
              Rate a day ($)
              <input value={form.rate} inputMode="decimal" placeholder={String(d.computedRate)} size={8} onChange={(e) => setForm({ ...form, rate: e.target.value })} />
            </label>
            <label className="tl-field">
              Billable days
              <input value={form.days} inputMode="decimal" placeholder={String(d.computedDays)} size={8} onChange={(e) => setForm({ ...form, days: e.target.value })} />
            </label>
            <label className="tl-field" style={{ flex: "1 1 220px" }}>
              Note
              <input value={form.note} maxLength={200} placeholder="Why, for the audit log" onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </label>
          </fieldset>
          {error ? (
            <p className="tl-note warn" role="alert">
              {error}
            </p>
          ) : null}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="tl-btn sm" disabled={pending} onClick={() => run(() => adjustTrailerDwellAction(trailerId, { ratePerDay: form.rate, billableDays: form.days, note: form.note }), "Dwell figure saved.")}>
              Save figure
            </button>
            {!typed.waived ? (
              <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => run(() => waiveTrailerDwellAction(trailerId, form.note), "Dwell fee waived.")}>
                Waive the fee
              </button>
            ) : null}
            {isTyped ? (
              <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => run(() => clearTrailerDwellAction(trailerId), "Back to the company figure.", () => setForm({ rate: "", days: "", note: "" }))}>
                Back to the company figure
              </button>
            ) : null}
          </div>
        </div>
      </Modal>
    </>
  );
}
