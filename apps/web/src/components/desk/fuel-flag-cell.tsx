"use client";

import { useRouter } from "next/navigation";
import React from "react";
import { clearFuelFlagAction, reopenFuelFlagAction } from "@/app/(desk)/actions";
import { FLAG_LABEL, type FlagCode } from "@/lib/fuel-exceptions";
import { tried } from "./kit/tried";
import { useToast } from "./kit/toast";
import { useDraft } from "./kit/use-draft";

/**
 * One fuel purchase's exception flags on the Fuel screen: each open flag as a chip (its detail on hover and in the review), and a Review panel where a person clears ONE flag with why, or reopens
 * one they cleared. Clearing names the flag it clears: another flag on the same purchase stays open.
 */
type Open = { code: FlagCode; detail: string; otherId?: string };
type Cleared = Open & { note: string; by: string; at: string | Date };

export function FuelFlagCell({ id, open, cleared }: { id: string; open: Open[]; cleared: Cleared[] }) {
  const router = useRouter();
  const toast = useToast();
  const [show, setShow] = React.useState(false);
  const [pending, start] = React.useTransition();
  const [form, setForm, draft] = useDraft(`fuel-flag:${id}`, { code: "", note: "" });
  const [error, setError] = React.useState("");
  if (open.length === 0 && cleared.length === 0) return <span className="dim">—</span>;
  const code = (open.some((f) => f.code === form.code) ? form.code : open[0]?.code) ?? "";

  const clear = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const got = await tried(() => clearFuelFlagAction(id, code, form.note));
      if (!got.ok) return setError(got.message);
      if (!got.value.ok) return setError(got.value.error);
      setError("");
      draft.discard();
      toast({ text: `${FLAG_LABEL[code as FlagCode]} cleared.`, tone: "ok" });
      router.refresh();
    });
  };
  const reopen = (c: FlagCode) =>
    start(async () => {
      const got = await tried(() => reopenFuelFlagAction(id, c));
      const msg = !got.ok ? got.message : !got.value.ok ? got.value.error : null;
      toast({ text: msg ?? `${FLAG_LABEL[c]} reopened.`, tone: msg ? "bad" : "ok" });
      if (!msg) router.refresh();
    });

  return (
    <div className="fflag">
      <div className="fflag-chips">
        {open.map((f) => (
          <span key={f.code} className="t-st" data-tone={f.code === "no_state" || f.code === "no_truck" ? "warn" : "bad"} title={f.detail}>
            {FLAG_LABEL[f.code]}
          </span>
        ))}
        {open.length === 0 ? <span className="dim">{cleared.length} cleared</span> : null}
        <button type="button" className="tl-btn ghost sm" aria-expanded={show} onClick={() => setShow(!show)}>
          {show ? "Close" : "Review"}
        </button>
      </div>
      {show ? (
        <div className="fflag-panel">
          {open.length > 0 ? (
            <form onSubmit={clear} aria-label="Clear one flag">
              <ul className="fflag-list">
                {open.map((f) => (
                  <li key={f.code}>
                    <b>{FLAG_LABEL[f.code]}</b> {f.detail}
                  </li>
                ))}
              </ul>
              <fieldset disabled={pending} className="fflag-form">
                {open.length > 1 ? (
                  <label className="tl-field">
                    Flag to clear
                    <select value={code} onChange={(e) => setForm({ ...form, code: e.target.value })}>
                      {open.map((f) => (
                        <option key={f.code} value={f.code}>
                          {FLAG_LABEL[f.code]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="tl-field fflag-note">
                  Why it is all right
                  <input value={form.note} maxLength={300} placeholder="Two tanks filled at the same pump, receipt checked" onChange={(e) => setForm({ ...form, note: e.target.value })} />
                </label>
                <button type="submit" className="tl-btn sm">
                  {pending ? "Clearing…" : `Clear ${FLAG_LABEL[code as FlagCode] ?? "flag"}`}
                </button>
              </fieldset>
              {error ? (
                <p className="tl-note warn" role="alert">
                  {error}
                </p>
              ) : null}
            </form>
          ) : null}
          {cleared.length > 0 ? (
            <ul className="fflag-list fflag-cleared">
              {cleared.map((f) => (
                <li key={f.code}>
                  <s>{FLAG_LABEL[f.code]}</s> cleared by {f.by}: {f.note}{" "}
                  <button type="button" className="tl-btn ghost sm" disabled={pending} onClick={() => reopen(f.code)}>
                    Reopen
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
