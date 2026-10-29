import { describe, expect, test } from "vitest";
import { addDays, addMonths, display, formatValue, monthGrid, parseTyped, parseValue, ymd } from "@/lib/date-field";

describe("date field rules", () => {
  test("a real day is accepted and an impossible one is not", () => {
    expect(ymd(2026, 10, 29)).toEqual({ y: 2026, m: 10, d: 29 });
    expect(ymd(2026, 2, 29)).toBeNull();
    expect(ymd(2028, 2, 29)).not.toBeNull();
    expect(ymd(2026, 13, 1)).toBeNull();
    expect(ymd(2026, 4, 31)).toBeNull();
  });

  test("a value round-trips, with and without a time", () => {
    expect(parseValue("2026-10-29")).toEqual({ day: { y: 2026, m: 10, d: 29 }, time: null });
    expect(parseValue("2026-10-29T17:06")).toEqual({ day: { y: 2026, m: 10, d: 29 }, time: { h: 17, min: 6 } });
    expect(parseValue("2026-10-29T17:06:00")?.time).toEqual({ h: 17, min: 6 });
    expect(formatValue({ y: 2026, m: 3, d: 5 }, { h: 8, min: 0 })).toBe("2026-03-05T08:00");
    expect(formatValue({ y: 2026, m: 3, d: 5 })).toBe("2026-03-05");
    expect(parseValue("2026-10-29T24:00")).toBeNull();
    expect(parseValue("2026-02-30")).toBeNull();
    expect(parseValue("")).toBeNull();
    expect(parseValue(undefined)).toBeNull();
  });

  test("the box shows month, day, year and a 12-hour clock", () => {
    expect(display("2026-10-29", false)).toBe("10/29/2026");
    expect(display("2026-10-29T17:06", true)).toBe("10/29/2026 5:06 PM");
    expect(display("2026-10-29T00:05", true)).toBe("10/29/2026 12:05 AM");
    expect(display("2026-10-29T12:00", true)).toBe("10/29/2026 12:00 PM");
    expect(display("2026-10-29T17:06", false)).toBe("10/29/2026");
    expect(display("nonsense", true)).toBe("");
  });

  test("typed text is read in the ways a dispatcher types it", () => {
    const eight = { h: 8, min: 0 };
    expect(parseTyped("10/29/2026", false, eight)).toBe("2026-10-29");
    expect(parseTyped("10-29-26", false, eight)).toBe("2026-10-29");
    expect(parseTyped(" 1/5/2027 ", false, eight)).toBe("2027-01-05");
    expect(parseTyped("10/29/2026 5:06 pm", true, eight)).toBe("2026-10-29T17:06");
    expect(parseTyped("10/29/2026 12:30 AM", true, eight)).toBe("2026-10-29T00:30");
    expect(parseTyped("10/29/2026 12:30 PM", true, eight)).toBe("2026-10-29T12:30");
    expect(parseTyped("10/29/2026 17:06", true, eight)).toBe("2026-10-29T17:06");
    expect(parseTyped("10/29/2026 5pm", true, eight)).toBe("2026-10-29T17:00");
  });

  test("a day alone gets the time the caller names, and a bad time or day is refused", () => {
    expect(parseTyped("10/29/2026", true, { h: 8, min: 0 })).toBe("2026-10-29T08:00");
    expect(parseTyped("10/29/2026 13:00 PM", true, { h: 8, min: 0 })).toBeNull();
    expect(parseTyped("10/29/2026 25:00", true, { h: 8, min: 0 })).toBeNull();
    expect(parseTyped("10/29/2026 5:75 PM", true, { h: 8, min: 0 })).toBeNull();
    expect(parseTyped("02/30/2026", false, { h: 8, min: 0 })).toBeNull();
    expect(parseTyped("soon", false, { h: 8, min: 0 })).toBeNull();
  });

  test("a month grid is six Sunday-first weeks that include the whole month", () => {
    const g = monthGrid(2026, 10); // 1 Oct 2026 is a Thursday
    expect(g).toHaveLength(42);
    expect(g[0]!.day).toEqual({ y: 2026, m: 9, d: 27 });
    expect(g[0]!.inMonth).toBe(false);
    expect(g[4]!.day).toEqual({ y: 2026, m: 10, d: 1 });
    expect(g.filter((c) => c.inMonth)).toHaveLength(31);
    expect(g[41]!.day).toEqual({ y: 2026, m: 11, d: 7 });
    // A month that starts on a Sunday begins its grid on the 1st.
    expect(monthGrid(2026, 2)[0]!.day).toEqual({ y: 2026, m: 2, d: 1 });
  });

  test("moving by days and months crosses edges and clamps the date", () => {
    expect(addDays({ y: 2026, m: 12, d: 31 }, 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(addDays({ y: 2026, m: 3, d: 1 }, -1)).toEqual({ y: 2026, m: 2, d: 28 });
    expect(addMonths({ y: 2026, m: 1, d: 31 }, 1)).toEqual({ y: 2026, m: 2, d: 28 });
    expect(addMonths({ y: 2028, m: 1, d: 31 }, 1)).toEqual({ y: 2028, m: 2, d: 29 });
    expect(addMonths({ y: 2026, m: 1, d: 15 }, -1)).toEqual({ y: 2025, m: 12, d: 15 });
    expect(addMonths({ y: 2026, m: 11, d: 15 }, 3)).toEqual({ y: 2027, m: 2, d: 15 });
  });
});
