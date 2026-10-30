"use client";

import { useClerk } from "@clerk/nextjs";
import React from "react";

/** Sign out: the provider ends its session, then /auth/leave removes the desk's own cookie. Rendered only when sign-in is on (the provider is only mounted then). */
export function AuthSignOutButton({ className, children, tip }: { className?: string; children: React.ReactNode; tip?: string }) {
  const { signOut } = useClerk();
  return (
    <button type="button" className={className} data-tip={tip} onClick={() => void signOut({ redirectUrl: "/auth/leave" })}>
      {children}
    </button>
  );
}
