import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { daysUntil, iftaDueDate, rateState, returnMoney } from "@/lib/ifta-return";

/**
 * Wave 5 step 7: the return screen's small rules (the filing due date, the rate table's state, money with a credit's minus) and who gets the files: both IFTA CSVs are the billing office's.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

describe("the IFTA return screen's rules", () => {
  test("a return is due the last day of the month after the quarter", () => {
    expect(iftaDueDate("2026-Q1")).toBe("2026-04-30");
    expect(iftaDueDate("2026-Q2")).toBe("2026-07-31");
    expect(iftaDueDate("2026-Q3")).toBe("2026-10-31");
    expect(iftaDueDate("2026-Q4")).toBe("2027-01-31");
    expect(iftaDueDate("2026Q4")).toBeNull();
    expect(daysUntil("2026-10-31", "2026-10-17")).toBe(14);
    expect(daysUntil("2026-10-31", "2026-11-13")).toBe(-13);
    expect(daysUntil("2027-01-31", "2026-12-31")).toBe(31);
  });

  test("the rate table's state in one word", () => {
    expect(rateState(0, 0, 0)).toBe("none");
    expect(rateState(48, 0, 48)).toBe("sample");
    expect(rateState(48, 0, 0)).toBe("provisional");
    expect(rateState(48, 10, 0)).toBe("mixed");
    expect(rateState(48, 48, 0)).toBe("final");
  });

  test("money on the screen: commas, cents, a credit's minus, a dash for nothing", () => {
    expect(returnMoney("13.8")).toBe("$13.80");
    expect(returnMoney("-102.30")).toBe("-$102.30");
    expect(returnMoney("12345.678")).toBe("$12,345.68");
    expect(returnMoney(null)).toBe("—");
  });

  test("both IFTA files ask for the billing office, and both kinds are exports", () => {
    expect(read("app/(desk)/export/[kind]/route.ts")).toMatch(/params\.kind === "ifta" \|\| params\.kind === "ifta-audit"\) \{\s+const noBill = await guardRoute\("bill"\)/);
    expect(read("server/tl/exports.ts")).toMatch(/"ifta", "ifta-audit"/);
    // The screen and the audit page read the one return; neither works a number out on its own.
    expect(read("app/(desk)/ifta/page.tsx")).toMatch(/iftaReturn\(quarter\)/);
    expect(read("app/(desk)/ifta/trucks/[id]/page.tsx")).toMatch(/iftaReturnDetail\(quarter, \{ vehicleId: truck\.id \}\)/);
  });
});
