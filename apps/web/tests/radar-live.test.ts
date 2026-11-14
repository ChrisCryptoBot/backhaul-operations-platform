import { describe, expect, test } from "vitest";
import { readLiveSeconds } from "@/lib/radar-points";

/** `?live=5` on the radar page: a whole number of seconds from 2 to 30 asks every that many seconds (for a demo or a recording); anything else is the usual rhythm. */
describe("the radar's ?live= refresh", () => {
  test("2 to 30 whole seconds is taken; everything else is the usual rhythm", () => {
    for (const ok of ["2", "5", "10", "30"]) expect(readLiveSeconds(ok), ok).toBe(Number.parseInt(ok, 10));
    for (const bad of [null, undefined, "", "0", "1", "31", "99", "100", "-5", "5.5", "1e1", "abc", " 5", "5 ", "05x"]) expect(readLiveSeconds(bad), String(bad)).toBeNull();
  });
});
