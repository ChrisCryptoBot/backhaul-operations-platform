import Link from "next/link";
import React from "react";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Place saved · TrueLane" };

export default function SignUpThanks() {
  return (
    <section className="pub-card pub-narrow" aria-labelledby="st-h">
      <h1 id="st-h">Your place is saved</h1>
      <p>Accounts are not open in this build yet. We have your details and will write to you when they are.</p>
      <p>In the meantime you can look around the demo desk.</p>
      <Link href="/loads" className="pub-btn">
        Continue to the demo desk
      </Link>
      <p className="pub-alt">
        <Link href="/sign-in">Back to sign in</Link>
      </p>
    </section>
  );
}
