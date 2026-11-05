"use client";

import React from "react";
import { DEMO_PASSWORD, DEMO_USERS } from "@/lib/demo-session";

/**
 * The demo's sign-in: a button for each way of using the desk (admin, dispatcher, billing, viewer). A button fills the two fields with that person's demo credentials and signs in as them,
 * and each lands on the screen that job starts on. The fields are display-only (the server checks nothing: there are no accounts in the demo), so nothing typed here is ever kept or sent
 * anywhere but to the demo door.
 */
export function DemoSignIn({ next }: { next?: string }) {
  const form = React.useRef<HTMLFormElement>(null);
  const [as, setAs] = React.useState<string | null>(null);
  const user = DEMO_USERS.find((u) => u.key === as) ?? null;
  const go = (key: string) => {
    setAs(key);
    // Let the fields show what was filled in for a beat, then come in.
    window.setTimeout(() => form.current?.requestSubmit(), 350);
  };
  return (
    <form ref={form} className="pub-demo-form" method="post" action="/auth/demo" aria-label="Demo sign in">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <input type="hidden" name="as" value={as ?? "admin"} />
      <label>
        Email
        <input type="text" readOnly value={user?.email ?? ""} placeholder="Filled in by the demo button" autoComplete="off" tabIndex={-1} />
      </label>
      <label>
        Password
        <input type="password" readOnly value={user ? DEMO_PASSWORD : ""} placeholder="Filled in by the demo button" autoComplete="off" tabIndex={-1} />
      </label>
      <div className="pub-demo-roles" role="group" aria-label="Sign in to the demo as">
        {DEMO_USERS.map((u) => (
          <button key={u.key} type="button" className="pub-btn pub-demo-role" onClick={() => go(u.key)} disabled={as != null} data-picked={as === u.key ? "true" : undefined}>
            <b>{as === u.key ? "Signing in…" : `Demo as ${u.label}`}</b>
            <span>{u.blurb}</span>
          </button>
        ))}
      </div>
      <noscript>
        <button type="submit" className="pub-btn">Continue to the demo desk</button>
      </noscript>
    </form>
  );
}
