import Link from "next/link";
import React from "react";
import type { Metadata } from "next";
import { SignIn } from "@clerk/nextjs";
import { ContactCard } from "@/components/desk/public/contact-card";
import { authOn } from "@/server/tl/identity";

export const metadata: Metadata = { title: "Sign in · TrueLane" };

/**
 * Sign in. With DESK_AUTH on this is the provider's sign-in form, which hands on to /auth/enter to make the desk session. With it off (the default) there are no accounts, so
 * it says so and offers the demo desk rather than a form that would do nothing.
 */
export default function SignInPage() {
  if (authOn()) {
    return (
      <div className="pub-split">
        <section className="pub-card" aria-labelledby="si-h">
          <h1 id="si-h">Sign in</h1>
          <SignIn path="/sign-in" routing="path" fallbackRedirectUrl="/auth/enter" forceRedirectUrl="/auth/enter" signUpUrl="/sign-up" />
          <p className="pub-alt">
            Your desk&apos;s owner adds you to it. Running 50 or more trucks? <Link href="/enterprise">Ask for a person</Link>.
          </p>
        </section>
        <ContactCard />
      </div>
    );
  }
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
