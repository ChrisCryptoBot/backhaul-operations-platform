import { describe, expect, test } from "vitest";
import { fuelTaxCheck, type FuelTaxInput } from "@/lib/data-health";

/** Wave 5 step 9: fuel and fuel-tax gaps on Data health, each linked to where it is fixed. Counts only. */
const base: FuelTaxInput = { purchases: 40, flaggedPurchases: 0, openFlags: 0, flagsPartial: false, noState: 0, noTruck: 0, unknownProduct: 0, quarter: { quarter: "2026-Q3", dueDate: "2026-10-31", filed: true, changedSinceFiled: false, rateState: "final", blockers: [] } };

describe("fuel and fuel tax on Data health", () => {
  test("a clean window and a filed, unchanged return need nobody", () => {
    expect(fuelTaxCheck(base)).toMatchObject({ issues: [], clean: true });
    expect(fuelTaxCheck({ ...base, flagsPartial: true }).clean).toBe(false);
  });

  test("each gap is one line with its count and where it is fixed", () => {
    const c = fuelTaxCheck({ ...base, flaggedPurchases: 3, openFlags: 4, noState: 2, noTruck: 1, unknownProduct: 5 });
    expect(c.issues.map((i) => [i.key, i.count, i.href])).toEqual([
      ["open_flags", 3, "/fuel?flagged=1&days=90"],
      ["fuel_no_state", 2, "/fuel?days=90"],
      ["fuel_no_truck", 1, "/fuel?days=90"],
      ["fuel_unknown_product", 5, "/fuel?days=90"]
    ]);
    expect(c.issues[0]!.label).toContain("4 flags");
  });

  test("the last quarter's return: blocked and not filed, or filed and changed since", () => {
    const blocked = fuelTaxCheck({ ...base, quarter: { ...base.quarter!, filed: false, blockers: [{ code: "missing_rate", count: 2, text: "No tax rate for TX, OK." }] } });
    expect(blocked.issues).toEqual([{ key: "ifta_blocked", label: "2026-Q3 IFTA return not filed: 1 thing blocks it", count: 1, href: "/ifta?quarter=2026-Q3" }]);
    const changed = fuelTaxCheck({ ...base, quarter: { ...base.quarter!, changedSinceFiled: true } });
    expect(changed.issues.map((i) => i.key)).toEqual(["ifta_changed"]);
    // Not filed and nothing blocks it: not a gap (it is simply waiting to be filed).
    expect(fuelTaxCheck({ ...base, quarter: { ...base.quarter!, filed: false } }).issues).toEqual([]);
    expect(fuelTaxCheck({ ...base, quarter: null }).issues).toEqual([]);
  });
});
