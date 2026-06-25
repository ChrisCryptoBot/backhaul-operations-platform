"use client";

import React from "react";

function setInputValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(input, value);
  } else {
    input.value = value;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

export function DevSignInHelper() {
  const isProduction = process.env.NODE_ENV === "production";
  const testEmail = process.env.NEXT_PUBLIC_DEV_TEST_LOGIN_EMAIL?.trim();
  const testPassword = process.env.NEXT_PUBLIC_DEV_TEST_LOGIN_PASSWORD?.trim();
  const [message, setMessage] = React.useState<string | null>(null);

  const fillInputs = React.useCallback(() => {
    const emailInput = document.querySelector<HTMLInputElement>(
      "input[name='identifier'], input[name='emailAddress'], input[type='email']"
    );
    const passwordInput = document.querySelector<HTMLInputElement>("input[name='password'], input[type='password']");

    if (!emailInput || !passwordInput) {
      setMessage("Could not find sign-in fields yet. Wait for the form to load and retry.");
      return null;
    }
    if (!testEmail || !testPassword) {
      setMessage("Set NEXT_PUBLIC_DEV_TEST_LOGIN_EMAIL and NEXT_PUBLIC_DEV_TEST_LOGIN_PASSWORD in .env.local.");
      return null;
    }

    setInputValue(emailInput, testEmail);
    setInputValue(passwordInput, testPassword);
    passwordInput.focus();
    return { passwordInput };
  }, [testEmail, testPassword]);

  const handleAutofill = React.useCallback(() => {
    if (!fillInputs()) {
      return;
    }
    setMessage("Test credentials autofilled.");
  }, [fillInputs]);

  const handleAutofillAndSubmit = React.useCallback(() => {
    const inputs = fillInputs();
    if (!inputs) {
      return;
    }
    const form = inputs.passwordInput.closest("form");
    if (!form) {
      setMessage("Could not find the sign-in form to submit.");
      return;
    }
    form.requestSubmit();
    setMessage("Test credentials autofilled and submitted.");
  }, [fillInputs]);

  if (isProduction) {
    return null;
  }

  return (
    <section className="db-dev-helper">
      <div className="db-dev-helper-row">
        <button type="button" className="db-btn" onClick={handleAutofill}>
          Autofill Test Login
        </button>
        <button type="button" className="db-btn" onClick={handleAutofillAndSubmit}>
          Autofill + Submit
        </button>
      </div>
      {message ? (
        <p className="db-dev-helper-msg" aria-live="polite" role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
