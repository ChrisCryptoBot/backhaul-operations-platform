import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import RootLayout from "@/app/layout";

vi.mock("@clerk/nextjs", () => ({
  ClerkProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="clerk-provider">{children}</div>
  )
}));

describe("root layout Clerk fallback", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CI", "false");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("bypasses Clerk provider when key is missing", () => {
    const markup = renderToStaticMarkup(<RootLayout>content</RootLayout>);
    expect(markup).not.toContain("data-testid=\"clerk-provider\"");
  });

  test("bypasses Clerk provider when key is invalid", () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "test-publishable");
    const markup = renderToStaticMarkup(<RootLayout>content</RootLayout>);
    expect(markup).not.toContain("data-testid=\"clerk-provider\"");
  });

  test("uses Clerk provider when key is valid", () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_123");
    const markup = renderToStaticMarkup(<RootLayout>content</RootLayout>);
    expect(markup).toContain("data-testid=\"clerk-provider\"");
  });

  test("throws in production when key is invalid", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "false");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "test-publishable");
    expect(() => renderToStaticMarkup(<RootLayout>content</RootLayout>)).toThrow(
      "Missing or invalid Clerk publishable key in production."
    );
  });

  test("falls back in CI even when production key is invalid", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CI", "true");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "test-publishable");
    const markup = renderToStaticMarkup(<RootLayout>content</RootLayout>);
    expect(markup).not.toContain("data-testid=\"clerk-provider\"");
  });
});
