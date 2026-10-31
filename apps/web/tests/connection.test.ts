import { describe, expect, test } from "vitest";
import { isLostConnection } from "@/lib/connection";

describe("a lost connection", () => {
  test("is known by each browser's own words", () => {
    for (const words of ["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."]) expect(isLostConnection(new TypeError(words))).toBe(true);
  });

  test("is not any other failure: a bug must not read as a bad connection", () => {
    expect(isLostConnection(new TypeError("x is not a function"))).toBe(false);
    expect(isLostConnection(new Error("Failed to fetch"))).toBe(false);
    expect(isLostConnection("Failed to fetch")).toBe(false);
    expect(isLostConnection(undefined)).toBe(false);
  });
});
