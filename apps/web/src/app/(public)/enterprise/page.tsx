import React from "react";
import type { Metadata } from "next";
import { RequestForm } from "@/components/desk/public/request-form";
import { ContactCard } from "@/components/desk/public/contact-card";
import { ENTERPRISE_TRUCKS, parseTrucks } from "@/lib/signup";

export const metadata: Metadata = { title: "Set up with a person · TrueLane" };

/**
 * The door for a large fleet. There is no self-serve account here by design: a fleet of this size has terminals, imports and connections that need hands, so a person
 * sets it up. This page takes the details and promises one thing, that a person follows up, and shows how to reach them now.
 */
export default function EnterprisePage({ searchParams }: { searchParams?: { trucks?: string } }) {
  const trucks = parseTrucks(searchParams?.trucks ?? "");
  return (
    <div className="pub-split">
      <section className="pub-card" aria-labelledby="en-h">
        <h1 id="en-h">Set up with a person</h1>
        <p>
          A fleet of {ENTERPRISE_TRUCKS} or more trucks is set up with a person who walks you through it, loads your trucks and drivers, and gets you signed up. Tell us about your fleet and we will be in touch.
        </p>
        <RequestForm enterprise trucks={trucks != null ? String(trucks) : undefined} />
      </section>
      <ContactCard heading="Or reach a person now" />
    </div>
  );
}
