"use client";

import React from "react";
import { useFormState, useFormStatus } from "react-dom";
import { submitRequestAction, type RequestState } from "@/app/(public)/actions";
import { CALL_ZONE_CHOICES, EMPTY_REQUEST, ENTERPRISE_TRUCKS, type RequestValues } from "@/lib/signup";
import { CARRIER_ZONES, zoneAbbr } from "@/lib/tz";
import { useDraft } from "../kit/use-draft";

const INITIAL: RequestState = { values: EMPTY_REQUEST, errors: {} };

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="pub-btn" disabled={pending}>
      {pending ? "Sending…" : label}
    </button>
  );
}

function Field({ name, label, hint, error, children }: { name: keyof RequestValues; label: string; hint?: string; error?: string; children: React.ReactNode }) {
  return (
    <div className="pub-field">
      <label htmlFor={`f-${name}`}>{label}</label>
      {children}
      {hint && !error ? <small id={`h-${name}`}>{hint}</small> : null}
      {error ? (
        <small id={`e-${name}`} className="err" role="alert">
          {error}
        </small>
      ) : null}
    </div>
  );
}

/**
 * One form for both doors. `enterprise` asks for what a person needs to phone you (a number or a time, your MC number, a note); the self-serve form asks for the four things
 * an account needs. Whatever the form says, the server decides which door a request is from the truck count.
 * What is typed is kept in this browser until the request has gone through (the page it lands on forgets it), so a refusal or a refresh does not lose it.
 */
export function RequestForm({ enterprise, trucks }: { enterprise: boolean; trucks?: string }) {
  const [state, action] = useFormState(submitRequestAction, INITIAL);
  const [v, setV] = useDraft<RequestValues>(`request:${enterprise ? "enterprise" : "self"}`, { ...EMPTY_REQUEST, trucks: trucks ?? "" });
  const e = state.errors;
  // The visitor's own zone, from their browser, offered as the default so a West Coast or East Coast fleet does not do the sum: they can change it, and it is kept with the rest.
  React.useEffect(() => {
    if (v.callZone) return;
    try {
      const mine = CARRIER_ZONES.find((z) => z.abbr === zoneAbbr(Intl.DateTimeFormat().resolvedOptions().timeZone));
      if (mine) setV((cur) => (cur.callZone ? cur : { ...cur, callZone: mine.id }));
    } catch {
      /* no zone to read: they pick one */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const input = (name: keyof RequestValues, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={`f-${name}`} name={name} value={v[name]} onChange={(ev) => setV((cur) => ({ ...cur, [name]: ev.target.value }))} aria-invalid={e[name] ? true : undefined} aria-describedby={e[name] ? `e-${name}` : undefined} {...props} />
  );
  return (
    <form action={action} className="pub-form" noValidate>
      {state.error ? (
        <p className="pub-error" role="alert">
          {state.error}
        </p>
      ) : null}
      <div className="pub-grid">
        <Field name="name" label="Your name" error={e.name}>
          {input("name", { autoComplete: "name", required: true })}
        </Field>
        <Field name="company" label="Company" error={e.company}>
          {input("company", { autoComplete: "organization", required: true })}
        </Field>
        <Field name="email" label="Work email" error={e.email}>
          {input("email", { type: "email", autoComplete: "email", required: true })}
        </Field>
        <Field name="trucks" label="Trucks you run" hint={enterprise ? `${ENTERPRISE_TRUCKS} or more is set up by a person.` : undefined} error={e.trucks}>
          {input("trucks", { inputMode: "numeric", required: true })}
        </Field>
        {enterprise ? (
          <>
            <Field name="role" label="Your role" error={e.role}>
              {input("role", { autoComplete: "organization-title" })}
            </Field>
            <Field name="mcNumber" label="MC number" hint="Optional." error={e.mcNumber}>
              {input("mcNumber")}
            </Field>
            <Field name="phone" label="Phone" hint="A number to reach you on, or give a time below." error={e.phone}>
              {input("phone", { type: "tel", autoComplete: "tel" })}
            </Field>
            <Field name="bestTime" label="Best time to call" hint="In your own time zone: pick it beside the time." error={e.bestTime}>
              <div className="pub-inline">
                {input("bestTime", { placeholder: "Weekdays after 2 pm" })}
                <select id="f-callZone" name="callZone" aria-label="Your time zone" value={v.callZone} onChange={(ev) => setV((cur) => ({ ...cur, callZone: ev.target.value }))}>
                  <option value="">My time zone</option>
                  {CALL_ZONE_CHOICES.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          </>
        ) : null}
      </div>
      {enterprise ? (
        <Field name="note" label="Anything we should know" hint="How you dispatch today, your terminals, what you need connected." error={e.note}>
          <textarea id="f-note" name="note" rows={4} value={v.note} onChange={(ev) => setV((cur) => ({ ...cur, note: ev.target.value }))} />
        </Field>
      ) : null}
      <Submit label={enterprise ? "Ask for a person to set us up" : "Save my place"} />
    </form>
  );
}
