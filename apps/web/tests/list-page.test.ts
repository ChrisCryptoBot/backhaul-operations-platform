import { describe, expect, test } from "vitest";
import { listPage } from "@/lib/list-page";

type Row = { name: string; n: number | null };
const rows: Row[] = [
  { name: "Dallas to Atlanta", n: 5 },
  { name: "Memphis to Chicago", n: null },
  { name: "Dallas to Houston", n: 9 },
  { name: "Tulsa to Dallas", n: 1 },
  { name: "Reno to Boise", n: 5 }
];
const base = { text: (r: Row) => r.name, sorters: { name: (r: Row) => r.name, n: (r: Row) => r.n } };

describe("a worked-out list shown a page at a time", () => {
  test("it keeps the list's own order when no sort is asked, and pages it", () => {
    const p = listPage(rows, { ...base, pageSize: 2 });
    expect(p.rows.map((r) => r.name)).toEqual(["Dallas to Atlanta", "Memphis to Chicago"]);
    expect(p).toMatchObject({ total: 5, all: 5, page: 1, pages: 3, sort: null });
    expect(listPage(rows, { ...base, pageSize: 2, page: 3 }).rows.map((r) => r.name)).toEqual(["Reno to Boise"]);
  });

  test("a page past the end lands on the last page, and one below one on the first", () => {
    expect(listPage(rows, { ...base, pageSize: 2, page: 99 }).page).toBe(3);
    expect(listPage(rows, { ...base, pageSize: 2, page: 0 }).page).toBe(1);
  });

  test("search reads the text, ignoring case, and counts what it found against all", () => {
    const p = listPage(rows, { ...base, q: "  DALLAS " });
    expect(p.rows.map((r) => r.name)).toEqual(["Dallas to Atlanta", "Dallas to Houston", "Tulsa to Dallas"]);
    expect(p).toMatchObject({ total: 3, all: 5, q: "DALLAS" });
    expect(listPage(rows, { ...base, q: "nowhere" })).toMatchObject({ rows: [], total: 0, page: 1, pages: 1 });
  });

  test("a sort goes ascending, a leading minus descending, a missing figure always last, ties in the list's own order", () => {
    expect(listPage(rows, { ...base, sort: "n" }).rows.map((r) => r.name)).toEqual(["Tulsa to Dallas", "Dallas to Atlanta", "Reno to Boise", "Dallas to Houston", "Memphis to Chicago"]);
    expect(listPage(rows, { ...base, sort: "-n" }).rows.map((r) => r.name)).toEqual(["Dallas to Houston", "Dallas to Atlanta", "Reno to Boise", "Tulsa to Dallas", "Memphis to Chicago"]);
    expect(listPage(rows, { ...base, sort: "-name" }).rows[0]!.name).toBe("Tulsa to Dallas");
    expect(listPage(rows, { ...base, sort: "n" }).sort).toEqual({ key: "n", dir: "asc" });
  });

  test("a column the list cannot sort by is ignored", () => {
    const p = listPage(rows, { ...base, sort: "bogus" });
    expect(p.sort).toBeNull();
    expect(p.rows.map((r) => r.name)[0]).toBe("Dallas to Atlanta");
  });

  test("an empty list is one empty page", () => {
    expect(listPage([] as Row[], base)).toMatchObject({ rows: [], total: 0, all: 0, page: 1, pages: 1 });
  });
});
