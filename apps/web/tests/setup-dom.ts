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

// The shared sidebar navigates via useRouter() inside a transition; the real hook throws
// without an app-router provider. Stub only useRouter (keep usePathname et al. real, so
// active-item logic is unchanged). Files with their own next/navigation mock override this.
vi.mock("next/navigation", async (importActual) => {
  const actual = await importActual<typeof import("next/navigation")>();
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      prefetch: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      refresh: vi.fn()
    })
  };
});
