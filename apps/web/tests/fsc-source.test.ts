import { describe, expect, test } from "vitest";
import { mapWireToDbFscSource, parseWireFscSource } from "@/lib/fsc-source";

describe("fsc source mapping", () => {
  test("accepts canonical wire format and maps to db enum", () => {
    const wire = parseWireFscSource("manual-override");
    expect(mapWireToDbFscSource(wire)).toBe("manual_override");
  });

  test("rejects non-canonical source", () => {
    expect(() => parseWireFscSource("manual_override")).toThrow();
  });
});
