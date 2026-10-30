import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { AuthSignOutButton } from "@/components/desk/auth-sign-out";
import { ContactCard } from "@/components/desk/public/contact-card";
import { authOn } from "@/server/tl/identity";

export const metadata: Metadata = { title: "No desk yet · TrueLane" };

/**
 * Where a person lands who has signed in but is on no desk: nobody added their email, or they were taken off. A sign-in alone gives no access to any desk's data; an owner
 * adds people, or a person sets a large fleet up.
 */
export default function NoWorkspacePage() {
  return (
    <div className="pub-split">
      <section className="pub-card" aria-labelledby="nw-h">
        <h1 id="nw-h">You are not on a desk yet</h1>
        <p>You are signed in, but no desk has this email address on it. Ask the owner of your desk to add you (Settings, Team), or ask for a person to set one up.</p>
        <p className="pub-alt">
          Running 50 or more trucks? <Link href="/enterprise">Ask for a person</Link>.
        </p>
        {authOn() ? (
          <AuthSignOutButton className="pub-btn">Sign out</AuthSignOutButton>
        ) : (
          <Link href="/loads" className="pub-btn">
            Continue to the demo desk
          </Link>
        )}
      </section>
      <ContactCard />
    </div>
  );
}
