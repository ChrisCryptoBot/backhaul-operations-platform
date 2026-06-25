import { describe, expect, test } from "vitest";
import { ParseState } from "@prisma/client";
import { mapParseFailure } from "@/server/ingestion";

describe("parse failure precedence", () => {
  test("returns FAILED_INVALID before low-confidence", () => {
    expect(mapParseFailure(0.2, "invalid")).toBe(ParseState.FAILED_INVALID);
  });

  test("returns FAILED_TIMEOUT before low-confidence", () => {
    expect(mapParseFailure(0.1, "timeout")).toBe(ParseState.FAILED_TIMEOUT);
  });

  test("returns FAILED_SCHEMA before low-confidence", () => {
    expect(mapParseFailure(0.3, "schema")).toBe(ParseState.FAILED_SCHEMA);
  });

  test("returns FAILED_LOW_CONFIDENCE when explicit code is low-confidence", () => {
    expect(mapParseFailure(0.2, "low-confidence")).toBe(ParseState.FAILED_LOW_CONFIDENCE);
  });
});
