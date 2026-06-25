import { afterEach, describe, expect, test, vi } from "vitest";
import { isAuthBypassed, isWriteBypassed } from "@/lib/auth-mode";

describe("auth-mode prod hardening", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("bypass is honored outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BYPASS_AUTH", "true");
    expect(isAuthBypassed()).toBe(true);
  });

  test("bypass is ignored in production even when BYPASS_AUTH=true", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BYPASS_AUTH", "true");
    expect(isAuthBypassed()).toBe(false);
  });

  test("write bypass also collapses in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BYPASS_AUTH", "true");
    vi.stubEnv("BYPASS_AUTH_WRITES", "true");
    expect(isWriteBypassed()).toBe(false);
  });
});
