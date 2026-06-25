import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import SignInPage from "@/app/(auth)/sign-in/[[...sign-in]]/page";

vi.mock("@clerk/nextjs", () => ({
  SignIn: () => React.createElement("div", { "data-testid": "clerk-sign-in" }, "Clerk SignIn")
}));

vi.mock("next/dynamic", () => ({
  default: () => () => React.createElement("div", { "data-testid": "dev-signin-helper" }, "Dev helper")
}));

describe("sign-in page", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_DEV_AUTOFILL", "false");
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("CLERK_PUBLISHABLE_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("renders styled auth error state when Clerk key is missing", () => {
    const markup = renderToStaticMarkup(React.createElement(SignInPage));
    expect(markup).toContain("Sign-in unavailable");
    expect(markup).toContain("db-auth-card db-auth-error");
  });

  test("renders Clerk sign-in when key is valid", () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_123");
    const markup = renderToStaticMarkup(React.createElement(SignInPage));
    expect(markup).toContain("data-testid=\"clerk-sign-in\"");
  });

  test("renders dev helper when autofill flag is enabled", () => {
    vi.stubEnv("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "pk_test_123");
    vi.stubEnv("NEXT_PUBLIC_ENABLE_DEV_AUTOFILL", "true");
    const markup = renderToStaticMarkup(React.createElement(SignInPage));
    expect(markup).toContain("data-testid=\"dev-signin-helper\"");
  });
});
