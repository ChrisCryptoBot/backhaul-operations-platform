import { describe, expect, test } from "vitest";
import { auditRange } from "@/lib/audit-range";

describe("auditRange: the From and To days on the Dallas calendar", () => {
  test("both days are included: from midnight Central that morning to midnight Central after the To day", () => {
    const r = auditRange("2026-10-05", "2026-10-06");
    expect(r.gte?.toISOString()).toBe("2026-10-05T05:00:00.000Z"); // CDT, UTC-5
    expect(r.lt?.toISOString()).toBe("2026-10-07T05:00:00.000Z");
  });

  test("winter days use the winter offset", () => {
    const r = auditRange("2027-01-10", "2027-01-10");
    expect(r.gte?.toISOString()).toBe("2027-01-10T06:00:00.000Z"); // CST, UTC-6
    expect(r.lt?.toISOString()).toBe("2027-01-11T06:00:00.000Z");
  });

  test("the day the clocks fall back is 25 hours long, and the To day still ends at the next midnight", () => {
    const r = auditRange("2026-11-01", "2026-11-01"); // fall back: a 25-hour day
    expect(r.gte?.toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(r.lt?.toISOString()).toBe("2026-11-02T06:00:00.000Z");
  });

  test("one end alone is an open range", () => {
    expect(auditRange("2026-10-05", undefined)).toEqual({ gte: new Date("2026-10-05T05:00:00.000Z") });
    expect(auditRange(undefined, "2026-10-05")).toEqual({ lt: new Date("2026-10-06T05:00:00.000Z") });
  });

  test("a From after the To is swapped rather than matching nothing", () => {
    const r = auditRange("2026-10-09", "2026-10-02");
    expect(r.gte?.toISOString()).toBe("2026-10-02T05:00:00.000Z");
    expect(r.lt?.toISOString()).toBe("2026-10-10T05:00:00.000Z");
  });

  test("a blank, malformed or impossible day is ignored", () => {
    expect(auditRange("", "")).toEqual({});
    expect(auditRange("yesterday", "2026-13-01")).toEqual({});
    expect(auditRange("2026-02-31", undefined)).toEqual({});
  });
});
