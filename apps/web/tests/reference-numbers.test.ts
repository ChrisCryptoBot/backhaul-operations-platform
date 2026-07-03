import { describe, expect, test } from "vitest";
import { derivePickupNumbers, normalizeReferenceNumbers } from "@/lib/reference-numbers";

describe("normalizeReferenceNumbers", () => {
  test("drops blank values and trims", () => {
    const out = normalizeReferenceNumbers([
      { kind: "PU", value: "  123 " },
      { kind: "PO", value: "   " },
      { kind: "BOL", value: "" }
    ]);
    expect(out).toEqual([{ kind: "PU", value: "123" }]);
  });

  test("clamps unknown kinds to OTHER and upper-cases known ones", () => {
    const out = normalizeReferenceNumbers([
      { kind: "weird", value: "A1" },
      { kind: "bol", value: "B2" }
    ]);
    expect(out).toEqual([
      { kind: "OTHER", value: "A1" },
      { kind: "BOL", value: "B2" }
    ]);
  });

  test("preserves a valid source and ignores an invalid one", () => {
    expect(normalizeReferenceNumbers([{ kind: "PU", value: "1", source: "RATE_CON" }])).toEqual([
      { kind: "PU", value: "1", source: "RATE_CON" }
    ]);
    expect(normalizeReferenceNumbers([{ kind: "PU", value: "1", source: "bogus" }])).toEqual([{ kind: "PU", value: "1" }]);
  });

  test("returns [] for non-array / junk input and caps the length", () => {
    expect(normalizeReferenceNumbers(null)).toEqual([]);
    expect(normalizeReferenceNumbers("nope")).toEqual([]);
    const big = Array.from({ length: 60 }, (_, i) => ({ kind: "OTHER", value: `n${i}` }));
    expect(normalizeReferenceNumbers(big).length).toBe(40);
  });
});

describe("derivePickupNumbers", () => {
  test("projects PU-kind entries onto the legacy pickup fields", () => {
    const derived = derivePickupNumbers([
      { kind: "PU", value: "PU1" },
      { kind: "BOL", value: "B9" },
      { kind: "PU", value: "PU2" }
    ]);
    expect(derived).toEqual({ pickupNumber: "PU1", pickupNumbers: ["PU1", "PU2"] });
  });

  test("no PU entries → null / empty", () => {
    expect(derivePickupNumbers([{ kind: "BOL", value: "B1" }])).toEqual({ pickupNumber: null, pickupNumbers: [] });
  });
});
