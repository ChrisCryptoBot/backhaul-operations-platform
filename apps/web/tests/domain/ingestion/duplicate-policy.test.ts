import { describe, expect, test } from "vitest";
import { evaluateDuplicatePolicy } from "@/domain/ingestion/duplicate-policy";

describe("duplicate policy engine", () => {
  test("prefers exact duplicate over soft duplicate", () => {
    expect(
      evaluateDuplicatePolicy({
        hasExactHashDuplicate: true,
        hasSoftDuplicate: true
      }).kind
    ).toBe("EXACT_DUPLICATE");
  });

  test("returns soft duplicate warning", () => {
    expect(
      evaluateDuplicatePolicy({
        hasExactHashDuplicate: false,
        hasSoftDuplicate: true
      }).kind
    ).toBe("SOFT_DUPLICATE_WARNING");
  });

  test("accepts new when no duplicates", () => {
    expect(
      evaluateDuplicatePolicy({
        hasExactHashDuplicate: false,
        hasSoftDuplicate: false
      }).kind
    ).toBe("ACCEPT_NEW");
  });
});

