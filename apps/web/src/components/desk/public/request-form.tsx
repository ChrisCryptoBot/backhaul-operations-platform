"use client";

import React from "react";
import { useFormState, useFormStatus } from "react-dom";
import { submitRequestAction, type RequestState } from "@/app/(public)/actions";
import { EMPTY_REQUEST, ENTERPRISE_TRUCKS, type RequestValues } from "@/lib/signup";

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
 */
export function RequestForm({ enterprise, trucks }: { enterprise: boolean; trucks?: string }) {
  const [state, action] = useFormState(submitRequestAction, INITIAL);
  const v = state.values;
  const e = state.errors;
  const input = (name: keyof RequestValues, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <input id={`f-${name}`} name={name} defaultValue={v[name] || (name === "trucks" ? (trucks ?? "") : "")} aria-invalid={e[name] ? true : undefined} aria-describedby={e[name] ? `e-${name}` : undefined} {...props} />
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
            <Field name="bestTime" label="Best time to call" error={e.bestTime}>
              {input("bestTime", { placeholder: "Weekdays after 2 pm Central" })}
            </Field>
          </>
        ) : null}
      </div>
      {enterprise ? (
        <Field name="note" label="Anything we should know" hint="How you dispatch today, your terminals, what you need connected." error={e.note}>
          <textarea id="f-note" name="note" rows={4} defaultValue={v.note} />
        </Field>
      ) : null}
      <Submit label={enterprise ? "Ask for a person to set us up" : "Save my place"} />
    </form>
  );
}
