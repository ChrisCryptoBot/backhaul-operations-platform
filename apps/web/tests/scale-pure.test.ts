import { describe, expect, test } from "vitest";
import { haversineMiles, nearestHomes } from "@/lib/geo";
import { asPage, asSort, nextSortParam, pageCount } from "@/lib/paging";
import { TERMINAL_MAX_LENGTH, asTerminal, scopeOf } from "@/lib/terminal";

describe("paging", () => {
  test("a page number from the address is a whole number from 1", () => {
    expect(asPage(undefined)).toBe(1);
    expect(asPage("")).toBe(1);
    expect(asPage("0")).toBe(1);
    expect(asPage("-3")).toBe(1);
    expect(asPage("abc")).toBe(1);
    expect(asPage("7")).toBe(7);
    expect(asPage("7.9")).toBe(7);
  });

  test("the number of pages is at least one and rounds up", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(50, 50)).toBe(1);
    expect(pageCount(51, 50)).toBe(2);
    expect(pageCount(1500, 50)).toBe(30);
  });

  test("a sort is kept only if the list can sort by it", () => {
    const allowed = ["name", "type"] as const;
    const fallback = { key: "name" as const, dir: "asc" as const };
    expect(asSort("type", allowed, fallback)).toEqual({ key: "type", dir: "asc" });
    expect(asSort("-type", allowed, fallback)).toEqual({ key: "type", dir: "desc" });
    expect(asSort("password", allowed, fallback)).toEqual(fallback);
    expect(asSort(undefined, allowed, fallback)).toEqual(fallback);
  });

  test("a column header sorts ascending, then descending, then back to the list's own order", () => {
    expect(nextSortParam(null, "name")).toBe("name");
    expect(nextSortParam({ key: "name", dir: "asc" }, "name")).toBe("-name");
    expect(nextSortParam({ key: "name", dir: "desc" }, "name")).toBeNull();
    expect(nextSortParam({ key: "name", dir: "asc" }, "type")).toBe("type");
  });
});

describe("terminals", () => {
  test("a terminal is trimmed, single-spaced and at most 40 characters; blank is none", () => {
    expect(asTerminal("  North   Yard ")).toBe("North Yard");
    expect(asTerminal("")).toBeNull();
    expect(asTerminal("   ")).toBeNull();
    expect(asTerminal(null)).toBeNull();
    expect(asTerminal("x".repeat(80))).toHaveLength(TERMINAL_MAX_LENGTH);
  });

  test("the scope is the cookie's terminal while someone still works out of it, and otherwise all", () => {
    const terminals = ["Dallas", "St. Louis"];
    expect(scopeOf("Dallas", terminals)).toBe("Dallas");
    expect(scopeOf(encodeURIComponent("St. Louis"), terminals)).toBe("St. Louis");
    expect(scopeOf("Houston", terminals)).toBeNull(); // an old cookie for a terminal nobody uses
    expect(scopeOf("", terminals)).toBeNull();
    expect(scopeOf(undefined, terminals)).toBeNull();
    expect(scopeOf("%E0%A4%A", terminals)).toBeNull(); // a cookie that does not decode
  });
});

describe("the nearest bases", () => {
  const dallas = { lat: 32.7767, lng: -96.797 };
  const homes = [
    { id: "chicago", address: "Chicago, IL", point: { lat: 41.8781, lng: -87.6298 } },
    { id: "okc", address: "Oklahoma City, OK", point: { lat: 35.4676, lng: -97.5164 } },
    { id: "houston", address: "Houston, TX", point: { lat: 29.7604, lng: -95.3698 } },
    { id: "unknown-1", address: "Somewhere, TX", point: null },
    { id: "no-address", address: "  ", point: null },
    { id: "dallas", address: "Dallas, TX", point: dallas }
  ];

  test("the nearest few with a point come first, nearest first", () => {
    expect(nearestHomes(homes, dallas, 2, 0).map((h) => h.id)).toEqual(["dallas", "okc"]);
  });

  test("bases with an address and no point yet are kept, a few, after the nearest; a base with no address is dropped", () => {
    const got = nearestHomes(homes, dallas, 1, 5).map((h) => h.id);
    expect(got).toEqual(["dallas", "unknown-1"]);
  });

  test("fewer bases than the limit returns them all", () => {
    expect(nearestHomes(homes, dallas, 40, 5)).toHaveLength(5);
  });

  test("the great-circle distance is about right: Dallas to Houston is about 225 miles", () => {
    const miles = haversineMiles(dallas, { lat: 29.7604, lng: -95.3698 });
    expect(miles).toBeGreaterThan(215);
    expect(miles).toBeLessThan(235);
    expect(haversineMiles(dallas, dallas)).toBe(0);
  });
});
