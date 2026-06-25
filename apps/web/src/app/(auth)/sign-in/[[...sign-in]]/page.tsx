import React from "react";
import Link from "next/link";
import { SignIn } from "@clerk/nextjs";
import dynamic from "next/dynamic";
import { AuthErrorState } from "@/components/auth/auth-error-state";
import { getClerkPublishableKey, hasValidClerkPublishableKey } from "@/lib/auth/clerk-config";
import { isAuthBypassed } from "@/lib/auth-mode";

const DevSignInHelperClient = dynamic(
  () => import("@/app/(auth)/sign-in/[[...sign-in]]/dev-signin-helper").then((module) => module.DevSignInHelper),
  { ssr: false }
);

export default function SignInPage() {
  const publishableKey = getClerkPublishableKey();
  const hasValidKey = hasValidClerkPublishableKey(publishableKey);
  const isDev = process.env.NODE_ENV !== "production";
  const showDevAutofill = isDev && process.env.NEXT_PUBLIC_ENABLE_DEV_AUTOFILL === "true";

  // Dev (auth bypassed): render a Clerk-free login mockup so the sign-in design is
  // viewable without authenticating. Every action just enters the board — there is
  // no real auth in this mode. Production still uses the live Clerk <SignIn/> below.
  if (isAuthBypassed()) {
    return (
      <form className="db-signin-card" action="/">
        <div>
          <h1 className="db-signin-h">Sign in</h1>
          <p className="db-signin-sub">Dev mode — Clerk is disabled. Enter the board with one click.</p>
        </div>

        <Link href="/" className="db-btn primary db-signin-submit" prefetch={false}>
          Enter board →
        </Link>

        <div className="db-signin-or">or</div>

        <label className="db-field-label">
          Work email
          <input className="db-input" type="email" placeholder="you@company.com" autoComplete="off" />
        </label>
        <label className="db-field-label">
          Password
          <input className="db-input" type="password" placeholder="••••••••" autoComplete="off" />
        </label>

        <div className="db-signin-row">
          <label className="db-signin-check">
            <input type="checkbox" defaultChecked /> Keep me signed in
          </label>
          <span className="db-signin-link">Forgot password?</span>
        </div>

        <Link href="/" className="db-btn db-signin-sso" prefetch={false}>
          Continue with company SSO
        </Link>

        <p className="db-signin-legal">Local development build · authentication is bypassed.</p>
      </form>
    );
  }

  // Dev-only shortcut: jump straight to the board without signing in. With
  // BYPASS_AUTH=true the board renders directly; hidden entirely in production.
  const demoEntry = isDev ? (
    <section className="db-signin-dev">
      <Link href="/" className="db-btn primary db-signin-dev-btn" prefetch={false}>
        Dev: enter board (skip sign-in) →
      </Link>
      <p className="db-signin-dev-hint">Skips Clerk sign-in. Requires BYPASS_AUTH=true.</p>
    </section>
  ) : null;

  if (!hasValidKey) {
    return (
      <>
        {demoEntry}
        <AuthErrorState
          title="Sign-in unavailable"
          description="Clerk is not configured for this environment."
          hint="Set NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY (or CLERK_PUBLISHABLE_KEY) and refresh."
        />
      </>
    );
  }

  return (
    <>
      {demoEntry}
      {showDevAutofill ? <DevSignInHelperClient /> : null}
      <SignIn
        appearance={{
          variables: {
            colorPrimary: "var(--db-accent)",
            colorBackground: "var(--db-bg-elev-2)",
            colorInputBackground: "var(--db-bg-elev-3)",
            colorText: "var(--db-fg)",
            colorTextSecondary: "var(--db-fg-mid)",
            colorDanger: "var(--db-neg)",
            fontFamily: "var(--db-font-ui)"
          },
          elements: {
            rootBox: "db-clerk-root",
            card: "db-clerk-card",
            formButtonPrimary: "db-btn",
            footerActionLink: "db-link"
          }
        }}
      />
    </>
  );
}
