import { describe, expect, test } from "vitest";
import { quarterOf, returnDrift, type FiledSnapshot } from "@/lib/ifta-return";

/** Wave 5 step 8: what changed since a return was filed, and which quarter a purchase belongs to (the workspace's own calendar). */
const line = (jurisdiction: string, miles: string, total: string) => ({ jurisdiction, miles, taxableGallons: "64", taxPaidGallons: "0", netGallons: "64", rate: "0.2850", surchargeRate: "0.0000", tax: total, surcharge: "0.00", total });
const filed: FiledSnapshot = { miles: "2500.0", gallons: "400.000", taxPaidGallons: "350.000", bulkGallons: "50.000", mpg: "6.25", tax: "1.89", surcharge: "0.00", total: "1.89", lines: [line("AR", "400.0", "-24.51"), line("OK", "500.0", "15.20"), line("TX", "1600.0", "11.20")] };

describe("drift since filed", () => {
  test("the same numbers (whatever their written places) are unchanged", () => {
    const live = { ...filed, miles: "2500", total: "1.890", lines: filed.lines.map((l) => ({ ...l, rate: "0.285" })) };
    expect(returnDrift(filed, live)).toEqual({ changed: false, header: [], lines: [] });
  });

  test("a late receipt: the header and the lines it moves, each filed, now and the change; a new state and a state gone", () => {
    const live = {
      ...filed,
      gallons: "420.000",
      mpg: "5.95",
      total: "-3.11",
      lines: [{ ...line("AR", "400.0", "-29.51"), netGallons: "60" }, line("MO", "0.0", "-2.00"), line("TX", "1600.0", "11.20")]
    };
    const d = returnDrift(filed, live);
    expect(d.changed).toBe(true);
    expect(d.header.map((f) => [f.field, f.filed, f.now, f.delta])).toEqual([
      ["gallons", "400.000", "420.000", "20"],
      ["mpg", "6.25", "5.95", "-0.3"],
      ["total", "1.89", "-3.11", "-5"]
    ]);
    expect(d.lines.map((l) => [l.jurisdiction, l.kind, l.fields.filter((f) => f.filed !== f.now).map((f) => f.field)])).toEqual([
      ["AR", "changed", ["netGallons", "tax", "total"]],
      ["MO", "added", ["miles", "taxableGallons", "taxPaidGallons", "netGallons", "rate", "surchargeRate", "tax", "surcharge", "total"]],
      ["OK", "removed", ["miles", "taxableGallons", "taxPaidGallons", "netGallons", "rate", "surchargeRate", "tax", "surcharge", "total"]]
    ]);
  });

  test("no MPG then or now is not a change; one side missing is", () => {
    expect(returnDrift({ ...filed, mpg: null }, { ...filed, mpg: null }).changed).toBe(false);
    expect(returnDrift({ ...filed, mpg: null }, filed).header.map((f) => [f.field, f.delta])).toEqual([["mpg", null]]);
  });
});

describe("the quarter of a purchase", () => {
  test("by the workspace's own calendar, not UTC", () => {
    expect(quarterOf(new Date("2026-07-01T04:30:00Z"), "America/Chicago")).toBe("2026-Q2"); // June 30, 11:30 pm in Chicago
    expect(quarterOf(new Date("2026-07-01T05:30:00Z"), "America/Chicago")).toBe("2026-Q3");
    expect(quarterOf(new Date("2026-12-31T23:30:00Z"), "America/Los_Angeles")).toBe("2026-Q4");
    expect(quarterOf(new Date("2027-01-01T00:30:00Z"), "UTC")).toBe("2027-Q1");
  });
});
