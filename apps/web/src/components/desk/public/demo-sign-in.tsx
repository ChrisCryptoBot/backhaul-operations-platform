"use client";

import React from "react";
import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/demo-session";

/**
 * The demo's sign-in: one button fills the two fields with the demo credentials and signs in at once. The fields are display-only (the server checks nothing: there are no accounts
 * in the demo), so nothing typed here is ever kept or sent anywhere but to the demo door.
 */
export function DemoSignIn({ next }: { next?: string }) {
  const form = React.useRef<HTMLFormElement>(null);
  const [filled, setFilled] = React.useState(false);
  const go = () => {
    setFilled(true);
    // Let the fields show what was filled in for a beat, then come in.
    window.setTimeout(() => form.current?.requestSubmit(), 350);
  };
  return (
    <form ref={form} className="pub-demo-form" method="post" action="/auth/demo" aria-label="Demo sign in">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <label>
        Email
        <input type="text" readOnly value={filled ? DEMO_EMAIL : ""} placeholder="Filled in by the demo button" autoComplete="off" tabIndex={-1} />
      </label>
      <label>
        Password
        <input type="password" readOnly value={filled ? DEMO_PASSWORD : ""} placeholder="Filled in by the demo button" autoComplete="off" tabIndex={-1} />
      </label>
      <button type="button" className="pub-btn" onClick={go} disabled={filled}>
        {filled ? "Signing in…" : "Use demo credentials"}
      </button>
      <noscript>
        <button type="submit" className="pub-btn">Continue to the demo desk</button>
      </noscript>
    </form>
  );
}
