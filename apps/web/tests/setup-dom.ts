import "@testing-library/jest-dom/vitest";
import React from "react";
import { vi } from "vitest";

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ isSignedIn: true }),
  SignOutButton: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children)
}));
