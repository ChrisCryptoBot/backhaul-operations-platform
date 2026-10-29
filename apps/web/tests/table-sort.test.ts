import { describe, expect, test } from "vitest";
import { compareKeys, nextSort, sortKey } from "@/lib/table-sort";

describe("table sorting", () => {
  test("a header cycles none, ascending, descending, none", () => {
    expect(nextSort("none")).toBe("ascending");
    expect(nextSort("ascending")).toBe("descending");
    expect(nextSort("descending")).toBe("none");
  });

  test("a number column reads the first figure in the text", () => {
    expect(sortKey("num", "$1,234.50")).toBe(1234.5);
    expect(sortKey("num", "26.7 days")).toBe(26.7);
    expect(sortKey("num", "−6.0%")).toBe(-6);
    expect(sortKey("num", "-$12.00")).toBe(-12);
    expect(sortKey("num", "$1.76/mi")).toBe(1.76);
    expect(sortKey("num", "4")).toBe(4);
  });

  test("a cell with no figure has no key", () => {
    expect(sortKey("num", "—")).toBeNull();
    expect(sortKey("num", "no market rate")).toBeNull();
    expect(sortKey("text", "—")).toBeNull();
    expect(sortKey("text", "  ")).toBeNull();
  });

  test("a row's own value wins over its text", () => {
    expect(sortKey("num", "Oct 24", "1792800000000")).toBe(1792800000000);
    expect(sortKey("text", "Oct 24", "2026-10-24")).toBe("2026-10-24");
  });

  test("text compares without case and numbers inside names compare as numbers", () => {
    const names = ["Unit 10", "unit 2", "Unit 1"];
    const sorted = [...names].sort((a, b) => compareKeys(sortKey("text", a), sortKey("text", b), "ascending"));
    expect(sorted).toEqual(["Unit 1", "unit 2", "Unit 10"]);
  });

  test("a missing key goes last in either direction", () => {
    const keys = [3, null, 1, 2];
    expect([...keys].sort((a, b) => compareKeys(a, b, "ascending"))).toEqual([1, 2, 3, null]);
    expect([...keys].sort((a, b) => compareKeys(a, b, "descending"))).toEqual([3, 2, 1, null]);
  });
});
