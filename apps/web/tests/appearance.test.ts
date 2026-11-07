import { describe, expect, test } from "vitest";
import {
  DEFAULT_SLEEP_MINUTES,
  MAX_SLEEP_MINUTES,
  UIS,
  UI_LABEL,
  asDensity,
  asSleepMinutes,
  asTheme,
  asUi,
  effectiveTheme,
  sleepBlurb,
  sleepPresetLabel
} from "@/lib/appearance";

describe("appearance and sleep mode settings", () => {
  test("theme and density fall back to night and dense", () => {
    expect(asTheme(undefined)).toBe("night");
    expect(asTheme("day")).toBe("day");
    expect(asTheme("bogus")).toBe("night");
    expect(asDensity(undefined)).toBe("dense");
    expect(asDensity("dense")).toBe("dense");
    expect(asDensity("comfortable")).toBe("comfortable");
    expect(asDensity("compact")).toBe("dense"); // the old name, from a cookie set before the redesign
    expect(asDensity("bogus")).toBe("dense");
  });

  test("the interface style defaults to the cockpit, rejects junk, and the app style is always drawn in night", () => {
    expect(asUi(undefined)).toBe("cockpit");
    expect(asUi("cockpit")).toBe("cockpit");
    expect(asUi("app")).toBe("app");
    expect(asUi("bogus")).toBe("cockpit");
    expect(UIS).toEqual(["cockpit", "app"]);
    expect(UI_LABEL.app.label).toBe("TrueLane app");
    expect(effectiveTheme("cockpit", "day")).toBe("day");
    expect(effectiveTheme("app", "day")).toBe("night"); // dark only; the saved Day choice is untouched and returns with the cockpit
  });

  test("asSleepMinutes parses off, valid minutes, clamps at MAX_SLEEP_MINUTES, and defaults cleanly", () => {
    expect(asSleepMinutes(undefined)).toBe(DEFAULT_SLEEP_MINUTES);
    expect(asSleepMinutes("")).toBe(DEFAULT_SLEEP_MINUTES);
    expect(asSleepMinutes("not-a-number")).toBe(DEFAULT_SLEEP_MINUTES);
    expect(asSleepMinutes("0")).toBe(0);
    expect(asSleepMinutes("off")).toBe(0);
    expect(asSleepMinutes("OFF")).toBe(0);
    expect(asSleepMinutes("1")).toBe(1);
    expect(asSleepMinutes("25")).toBe(25);
    expect(asSleepMinutes("9999")).toBe(MAX_SLEEP_MINUTES);
  });

  test("sleep labels and blurbs describe off, singular and plural minutes", () => {
    expect(sleepPresetLabel(0)).toBe("Off");
    expect(sleepPresetLabel(15)).toBe("15m");
    expect(sleepBlurb(0)).toContain("Off.");
    expect(sleepBlurb(1)).toContain("1 minute ");
    expect(sleepBlurb(15)).toContain("15 minutes");
  });
});
