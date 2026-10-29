import { describe, expect, it } from "vitest";
import { validateComplete, validateExpenses, validateStart, type CompleteValues } from "../src/lib/trip";

// 2026-10-29 10:00 on the Dallas clock (CDT) is 15:00 UTC.
const NOW = Date.parse("2026-10-29T15:00:00Z");

describe("validateStart", () => {
  it("takes an arrival, a wait and a seal", () => {
    const out = validateStart({ arrivedAt: "2026-10-29T07:30", waitMinutes: "45", seal: " 77123 " }, NOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.value.arrivedAt.toISOString()).toBe("2026-10-29T12:30:00.000Z");
      expect(out.value).toMatchObject({ waitMinutes: 45, seal: "77123" });
    }
  });

  it("refuses a time in the future, allowing a few minutes of clock difference", () => {
    expect(validateStart({ arrivedAt: "2026-10-29T10:05", waitMinutes: "", seal: "" }, NOW).ok).toBe(true);
    const out = validateStart({ arrivedAt: "2026-10-29T11:00", waitMinutes: "", seal: "" }, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.arrivedAt).toMatch(/future/);
  });

  it("wait and seal are optional; bad ones are named", () => {
    const ok = validateStart({ arrivedAt: "2026-10-29T07:30", waitMinutes: "", seal: "" }, NOW);
    expect(ok.ok && ok.value).toMatchObject({ waitMinutes: null, seal: null });
    const bad = validateStart({ arrivedAt: "", waitMinutes: "1441", seal: "x".repeat(31) }, NOW);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["arrivedAt", "seal", "waitMinutes"]);
  });
});

const done = (): CompleteValues => ({ stops: [{ id: "s2", arrivedAt: "2026-10-29T08:00", waitMinutes: "20" }], deliveredAt: "2026-10-29T09:00", pod: "received", podNote: "", fuel: "120.50", tolls: "", misc: "" });

describe("validateComplete", () => {
  it("a delivery with proof of delivery and expenses", () => {
    const out = validateComplete(done(), NOW);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toMatchObject({ pod: "received", podNote: null, expenses: { fuel: 120.5, tolls: 0, misc: 0 } });
  });

  it("no proof of delivery needs a reason", () => {
    const v = done();
    v.pod = "none";
    const out = validateComplete(v, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.podNote).toBeDefined();
    v.podNote = "Driver left it at a locked dock";
    expect(validateComplete(v, NOW).ok).toBe(true);
  });

  it("names the stop and the field that are wrong", () => {
    const v = done();
    v.stops[0]!.arrivedAt = "2026-10-30T08:00";
    v.stops[0]!.waitMinutes = "-5";
    v.fuel = "12.345";
    const out = validateComplete(v, NOW);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["fuel", "stop0.arrivedAt", "stop0.waitMinutes"]);
  });
});

describe("validateExpenses", () => {
  it("blank is zero, commas are fine, half-cents and negatives are not", () => {
    const ok = validateExpenses({ fuel: "1,200", tolls: "", misc: "0" });
    expect(ok.ok && ok.value).toEqual({ fuel: 1200, tolls: 0, misc: 0 });
    const bad = validateExpenses({ fuel: "-1", tolls: "1.005", misc: "abc" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(Object.keys(bad.errors).sort()).toEqual(["fuel", "misc", "tolls"]);
  });
});
