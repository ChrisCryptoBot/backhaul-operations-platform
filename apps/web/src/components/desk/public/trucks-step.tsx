"use client";

import React from "react";
import { trucksStepAction } from "@/app/(public)/actions";
import { ENTERPRISE_TRUCKS } from "@/lib/signup";
import { useDraft } from "../kit/use-draft";

/** Step one of signing up: how many trucks. The number typed is kept in this browser, so it is still there after a refusal or a refresh. */
export function TrucksStep({ typed, wrong }: { typed: string; wrong: boolean }) {
  const [trucks, setTrucks] = useDraft("trucks-step", typed);
  return (
    <form action={trucksStepAction} className="pub-form">
      <div className="pub-field">
        <label htmlFor="f-trucks">How many trucks do you run?</label>
        <input id="f-trucks" name="trucks" inputMode="numeric" autoComplete="off" required value={trucks} onChange={(e) => setTrucks(e.target.value)} aria-invalid={wrong ? true : undefined} />
        {wrong ? (
          <small className="err" role="alert">
            Enter a whole number of trucks, like 12.
          </small>
        ) : (
          <small>{ENTERPRISE_TRUCKS} or more is set up by a person; under that you make your own account.</small>
        )}
      </div>
      <button type="submit" className="pub-btn">
        Continue
      </button>
    </form>
  );
}
