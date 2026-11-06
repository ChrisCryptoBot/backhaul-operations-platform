import { describe, expect, test } from "vitest";
import { SIGNAL_DEFAULTS, reportWhen, resolveSignalSettings, validateSignalSettings } from "@/lib/signal-settings";

describe("what the desk tells people about", () => {
  test("a desk with nothing stored sends block alerts only and the weekly report on Monday at 7 AM", () => {
    expect(resolveSignalSettings(null)).toEqual(SIGNAL_DEFAULTS);
    expect(SIGNAL_DEFAULTS).toEqual({ minLevel: "block", reportEnabled: true, reportDay: 1, reportHour: 7 });
    expect(reportWhen(SIGNAL_DEFAULTS)).toBe("Monday at 7 AM");
  });

  test("stored values win, and a stored value that is not valid falls back to the default rather than breaking a send", () => {
    expect(resolveSignalSettings({ minLevel: "warn", reportEnabled: false, reportDay: 5, reportHour: 15 })).toEqual({ minLevel: "warn", reportEnabled: false, reportDay: 5, reportHour: 15 });
    expect(resolveSignalSettings({ minLevel: "loud", reportDay: 9, reportHour: -1 })).toEqual(SIGNAL_DEFAULTS);
  });

  test("the form is checked: blanks are the default, anything out of range names the field", () => {
    expect(validateSignalSettings({ minLevel: "", reportEnabled: "", reportDay: "", reportHour: "" })).toMatchObject({ ok: true, stored: { minLevel: null, reportEnabled: null, reportDay: null, reportHour: null } });
    expect(validateSignalSettings({ minLevel: "info", reportEnabled: "on", reportDay: "0", reportHour: "23" })).toMatchObject({ ok: true, stored: { minLevel: "info", reportEnabled: true, reportDay: 0, reportHour: 23 } });
    const bad = validateSignalSettings({ minLevel: "loud", reportEnabled: "maybe", reportDay: "7", reportHour: "7.5" });
    expect(bad).toMatchObject({ ok: false });
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["minLevel", "reportDay", "reportEnabled", "reportHour"]);
  });

  test("the time is said in words, midnight and noon included", () => {
    expect(reportWhen({ reportDay: 0, reportHour: 0 })).toBe("Sunday at 12 AM");
    expect(reportWhen({ reportDay: 6, reportHour: 12 })).toBe("Saturday at 12 PM");
    expect(reportWhen({ reportDay: 3, reportHour: 17 })).toBe("Wednesday at 5 PM");
  });
});
