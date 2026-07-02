"use client";

import React from "react";
import { SignOutButton, useAuth } from "@clerk/nextjs";
import { isClerkEnabled } from "@/lib/auth/clerk-config";

/** The real sign-out control — only mounted when <ClerkProvider> is present. */
function ClerkSignOutButton() {
  const { isSignedIn } = useAuth();
  if (!isSignedIn) {
    return null;
  }

  return (
    <SignOutButton redirectUrl="/sign-in">
      <button type="button" className="db-btn db-btn-ghost db-btn-mini" aria-label="Sign out">
        Sign out
      </button>
    </SignOutButton>
  );
}

/**
 * In dev bypass there is no Clerk key, so the layout doesn't mount <ClerkProvider>
 * and calling useAuth() would throw. Gate on the same condition and render nothing —
 * the hook lives in the inner component, which is only reached when Clerk is enabled.
 */
export function TopbarSignOutButton() {
  if (!isClerkEnabled()) {
    return null;
  }
  return <ClerkSignOutButton />;
}
