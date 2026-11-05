import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CALL_ZONE_CHOICES, EMPTY_REQUEST, callTime, readRequest } from "@/lib/signup";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

describe("the best time to call carries the caller's own zone", () => {
  it("puts the zone after the words, once, and keeps what was typed when there is no zone or one was already said", () => {
    expect(callTime({ bestTime: "Weekdays after 2 pm", callZone: "America/Los_Angeles" })).toBe("Weekdays after 2 pm (Pacific time)");
    expect(callTime({ bestTime: "Weekdays after 2 pm", callZone: "America/New_York" })).toBe("Weekdays after 2 pm (Eastern time)");
    expect(callTime({ bestTime: "Weekdays after 2 pm", callZone: "" })).toBe("Weekdays after 2 pm");
    expect(callTime({ bestTime: "after 2 pm Central", callZone: "America/New_York" })).toBe("after 2 pm Central");
    expect(callTime({ bestTime: "mornings, my time", callZone: "America/Denver" })).toBe("mornings, my time");
    expect(callTime({ bestTime: "   ", callZone: "America/Denver" })).toBeNull();
  });

  it("drops a zone that is not one of the carrier zones, never storing it", () => {
    for (const bad of ["Mars/Olympus", "America/Chicago; drop", "central"]) expect(callTime({ bestTime: "after 2", callZone: bad })).toBe("after 2");
  });

  it("is read from the form like every other field, and offered as the seven carrier zones", () => {
    const f = new FormData();
    f.set("bestTime", " after 2 pm ");
    f.set("callZone", " America/Chicago ");
    expect(readRequest(f)).toMatchObject({ ...EMPTY_REQUEST, bestTime: "after 2 pm", callZone: "America/Chicago" });
    expect(CALL_ZONE_CHOICES).toHaveLength(7);
    expect(CALL_ZONE_CHOICES[0]).toEqual({ id: "America/New_York", label: "ET · Eastern" });
  });

  it("the form no longer assumes Central, and the booking link says it opens elsewhere", () => {
    const form = src("src/components/desk/public/request-form.tsx");
    expect(form).not.toContain("Central");
    expect(form).toContain('name="callZone"');
    const card = src("src/components/desk/public/contact-card.tsx");
    expect(card).toContain('target="_blank"');
    expect(card).toContain("Pick a time that suits");
    expect(card).toContain("opens the scheduling page in a new tab");
  });
});
