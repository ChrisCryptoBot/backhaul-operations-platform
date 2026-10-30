import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { trucksStepAction } from "../actions";
import { RequestForm } from "@/components/desk/public/request-form";
import { ContactCard } from "@/components/desk/public/contact-card";
import { ENTERPRISE_TRUCKS, kindFor, parseTrucks } from "@/lib/signup";

export const metadata: Metadata = { title: "Create an account · TrueLane" };

/**
 * Sign up, in two steps. First: how many trucks. Under 50 you go on and make your own account; 50 or more is a person's job, so the next step is a request
 * for one (the server decides this from the number, whatever the form says). This build has no accounts yet, so making one saves your place.
 */
export default function SignUpPage({ searchParams }: { searchParams?: { trucks?: string; error?: string } }) {
  const trucks = parseTrucks(searchParams?.trucks ?? "");
  const selfServe = trucks != null && kindFor(trucks) === "self_serve";
  return (
    <div className="pub-split">
      <section className="pub-card" aria-labelledby="su-h">
        <h1 id="su-h">Create an account</h1>
        {!selfServe ? (
          <>
            <p>Start with the size of your fleet. A smaller fleet sets itself up here; a large one is set up with a person.</p>
            <form action={trucksStepAction} className="pub-form">
              <div className="pub-field">
                <label htmlFor="f-trucks">How many trucks do you run?</label>
                <input id="f-trucks" name="trucks" inputMode="numeric" autoComplete="off" required defaultValue={searchParams?.trucks ?? ""} aria-invalid={searchParams?.error === "trucks" ? true : undefined} />
                {searchParams?.error === "trucks" ? (
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
          </>
        ) : (
          <>
            <p>
              {trucks} {trucks === 1 ? "truck" : "trucks"}: you can set yourself up. Accounts are not open in this build yet, so this saves your place and we will write when they are.{" "}
              <Link href="/sign-up">Change the number</Link>.
            </p>
            <RequestForm enterprise={false} trucks={String(trucks)} />
          </>
        )}
        <p className="pub-alt">
          Already have an account? <Link href="/sign-in">Sign in</Link>.
        </p>
      </section>
      <ContactCard heading="Questions first?" />
    </div>
  );
}
