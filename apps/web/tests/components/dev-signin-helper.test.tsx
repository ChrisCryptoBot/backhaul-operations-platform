import React from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DevSignInHelper } from "@/app/(auth)/sign-in/[[...sign-in]]/dev-signin-helper";

describe("dev sign-in helper", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_DEV_TEST_LOGIN_EMAIL", "dispatcher@example.com");
    vi.stubEnv("NEXT_PUBLIC_DEV_TEST_LOGIN_PASSWORD", "Password123!");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  test("renders without inline style attributes", () => {
    const { container } = render(<DevSignInHelper />);
    expect(container.innerHTML.includes("style=")).toBe(false);
  });

  test("autofills compatible email and password fields", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <input name="emailAddress" />
        <input name="password" type="password" />
        <DevSignInHelper />
      </div>
    );

    await user.click(screen.getByRole("button", { name: "Autofill Test Login" }));

    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("dispatcher@example.com");
    const passwordInput = document.querySelector("input[name='password']") as HTMLInputElement;
    expect(passwordInput.value).toBe("Password123!");
  });
});
