import "@testing-library/jest-dom/vitest";
import React from "react";
import { vi } from "vitest";

// DOM tests render the authenticated shell, so treat Clerk as configured by default.
// Tests that exercise the no-Clerk path override this with vi.stubEnv("", ...).
process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY =
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isSignedIn: true }),
  SignOutButton: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children)
}));
