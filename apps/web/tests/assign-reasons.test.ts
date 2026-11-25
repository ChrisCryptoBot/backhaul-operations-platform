import { describe, expect, it } from "vitest";
import { missingReasons, needsMessage, reasonText, reasonsFrom, type ReasonNeed } from "../src/lib/assign-reasons";

const needs: ReasonNeed[] = [
  { code: "double_booked", message: "Mike is already on TL-88." },
  { code: "reason_required", message: "Dana has this load." }
];

describe("each condition has its own reason", () => {
  it("a reason given for one condition never covers another", () => {
    expect(missingReasons(needs, { reason_required: "Dana called in sick" }).map((n) => n.code)).toEqual(["double_booked"]);
    expect(missingReasons(needs, { double_booked: "short hop", reason_required: "sick" })).toEqual([]);
  });

  it("a reason has to say something", () => {
    expect(missingReasons(needs, { double_booked: "  ", reason_required: ".." }).map((n) => n.code)).toEqual(["double_booked", "reason_required"]);
  });

  it("keeps each reason beside its condition, in the order the conditions came", () => {
    expect(reasonText(needs, { reason_required: "Dana called in sick", double_booked: "R2 is a short hop" })).toBe("Double-booked: R2 is a short hop; Driver changed: Dana called in sick");
    expect(reasonText([], {})).toBeNull();
  });

  it("reads one form field per condition and ignores anything else", () => {
    const form: Record<string, string> = { reason_double_booked: " team run ", reason_hos_short: "", overrideReason: "old box", reason_made_up: "x" };
    expect(reasonsFrom((k) => form[k])).toEqual({ double_booked: "team run" });
  });

  it("says the one condition in its own words, or how many are missing", () => {
    expect(needsMessage([needs[0]!])).toBe("Mike is already on TL-88. Add a reason to go ahead.");
    expect(needsMessage(needs)).toMatch(/^2 things need a reason/);
  });
});
