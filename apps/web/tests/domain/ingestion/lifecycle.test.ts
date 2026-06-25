import { describe, expect, test } from "vitest";
import { assertValidIngestionTransition } from "@/domain/ingestion/lifecycle";

describe("ingestion lifecycle guards", () => {
  test("allows UPLOADED -> QUEUED", () => {
    expect(() => assertValidIngestionTransition("UPLOADED", "QUEUED")).not.toThrow();
  });

  test("rejects EXTRACTED -> QUEUED", () => {
    expect(() => assertValidIngestionTransition("EXTRACTED", "QUEUED")).toThrow(/Illegal ingestion lifecycle transition/);
  });
});

