import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const src = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");

/**
 * A driver's no stays neutral everywhere but on the load they declined (Chris, 2026-11-25). For a leased contractor with forced dispatch off, refusing a load is their right under the lease
 * (49 CFR 376.12), and holding it against them would treat them as an employee. Today nothing counts declines; these checks keep it that way until someone decides otherwise on purpose.
 */
describe("a decline only counts on the load that was declined", () => {
  it("the driver scorecard never reads declines", () => {
    expect(src("src/lib/driver-scorecard.ts")).not.toMatch(/declin/i);
  });

  it("the ranking reads declines only for the load being assigned", () => {
    const rank = src("src/server/tl/driver-rank.ts");
    const reads = [...rank.matchAll(/assignmentEvent\.findMany\(\{ where: \{([^}]*)\}/g)].map((m) => m[1]!);
    expect(reads.length).toBeGreaterThan(0);
    for (const where of reads) expect(where).toContain("loadId: load.id");
  });
});
