import React from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { TopbarSignOutButton } from "@/components/auth/sign-out-button";

afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
});

describe("TopbarSignOutButton", () => {
  test("renders the sign-out control when Clerk is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_Y2xlcmsuZXhhbXBsZS5jb20k");
    render(<TopbarSignOutButton />);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  test("no-ops (renders nothing) when Clerk is disabled in dev bypass", () => {
    // No publishable key → the layout never mounts <ClerkProvider>, so the button must
    // not reach useAuth(). Guard short-circuits even though the mocked useAuth is signed in.
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    const { container } = render(<TopbarSignOutButton />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
  });
});
