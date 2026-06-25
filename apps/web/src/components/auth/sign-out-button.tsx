"use client";

import React from "react";
import { SignOutButton, useAuth } from "@clerk/nextjs";

export function TopbarSignOutButton() {
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
