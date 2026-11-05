import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { RequestForm } from "@/components/desk/public/request-form";
import { TrucksStep } from "@/components/desk/public/trucks-step";
import { ContactCard } from "@/components/desk/public/contact-card";
import { kindFor, parseTrucks } from "@/lib/signup";

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
            <TrucksStep typed={searchParams?.trucks ?? ""} wrong={searchParams?.error === "trucks"} />
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
