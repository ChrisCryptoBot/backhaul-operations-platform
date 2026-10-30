import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { validateComplete, type CompleteValues } from "../src/lib/trip";

const NOW = Date.UTC(2026, 9, 31, 18, 0, 0);
const base: CompleteValues = { stops: [], deliveredAt: "2026-10-31T11:00", pod: "received", podNote: "", fuel: "", tolls: "", misc: "" };

describe("the linehaul actually paid, typed at delivery", () => {
  it("blank keeps the rate on the load", () => {
    const r = validateComplete(base, NOW);
    expect(r.ok && r.value.actualRevenue).toBeNull();
    const r2 = validateComplete({ ...base, actualRevenue: "   " }, NOW);
    expect(r2.ok && r2.value.actualRevenue).toBeNull();
  });
  it("a typed amount in dollars and cents is taken, with a comma allowed", () => {
    const r = validateComplete({ ...base, actualRevenue: "1,150.25" }, NOW);
    expect(r.ok && r.value.actualRevenue).toBe(1150.25);
  });
  it("refuses a negative, zero, an absurd amount, half a cent and words", () => {
    for (const bad of ["-5", "0", "0.00", "100000.01", "12.345", "twelve", "1e3"]) {
      const r = validateComplete({ ...base, actualRevenue: bad }, NOW);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.errors.actualRevenue, bad).toBeTruthy();
    }
  });
  it("an error on this field does not hide the others", () => {
    const r = validateComplete({ ...base, actualRevenue: "x", fuel: "abc" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["actualRevenue", "fuel"]);
  });
});

describe("a seal at any stop", () => {
  const stop = (seal?: string) => ({ ...base, stops: [{ id: "s1", arrivedAt: "", waitMinutes: "", seal }] });
  it("blank is none (the recorded seal is kept), a typed one is taken trimmed", () => {
    const blank = validateComplete(stop(""), NOW);
    expect(blank.ok && blank.value.stops[0]!.seal).toBeNull();
    const none = validateComplete(stop(undefined), NOW);
    expect(none.ok && none.value.stops[0]!.seal).toBeNull();
    const typed = validateComplete(stop("  S-4471 "), NOW);
    expect(typed.ok && typed.value.stops[0]!.seal).toBe("S-4471");
  });
  it("30 characters at most, said on that stop", () => {
    const r = validateComplete(stop("x".repeat(31)), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors["stop0.seal"]).toMatch(/30 characters/);
  });
});

describe("where it goes", () => {
  const src = (rel: string) => fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");
  it("delivery writes it as the load's actual revenue and says so in the audit; the invoice starts from it", () => {
    const ex = src("server/tl/execution.ts");
    expect(ex).toContain("actualRevenue: v.actualRevenue ?? load.quotedRevenue");
    expect(ex).toContain("linehaul paid");
    for (const f of ["server/tl/invoicing.ts", "server/tl/queries.ts", "components/desk/load-view.tsx"]) expect(src(f)).toContain("actualRevenue ?? ");
  });
});
