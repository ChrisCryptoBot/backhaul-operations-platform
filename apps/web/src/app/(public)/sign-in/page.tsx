import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { ContactCard } from "@/components/desk/public/contact-card";

export const metadata: Metadata = { title: "Sign in · TrueLane" };

/**
 * Sign in. This build has no accounts (sign-in is not switched on), so it says so and offers the demo desk rather than a form that would do nothing.
 * When sign-in is switched on this is where the sign-in form goes; the page, the links and the contact stay.
 */
export default function SignInPage() {
  return (
    <div className="pub-split">
      <section className="pub-card" aria-labelledby="si-h">
        <h1 id="si-h">Sign in</h1>
        <p>Sign-in is not switched on in this build, so there are no accounts to sign in to yet.</p>
        <p className="pub-demo">What you can do now is look around the demo desk. Every name, load and number in it is invented.</p>
        <Link href="/loads" className="pub-btn">
          Continue to the demo desk
        </Link>
        <p className="pub-alt">
          New here? <Link href="/sign-up">Create an account</Link>. Running 50 or more trucks? <Link href="/enterprise">Ask for a person</Link>.
        </p>
      </section>
      <ContactCard />
    </div>
  );
}
