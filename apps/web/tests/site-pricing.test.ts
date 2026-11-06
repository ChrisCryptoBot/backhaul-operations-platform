import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { OVERAGE_CENTS_PER_READ, PLANS, READS_INCLUDED_PER_TRUCK, centsText, monthlyPriceCents } from "@/lib/plans";

/**
 * The dispatcher software page (truelane-site/build.html, in the phone's repo beside this one) shows the Desk's price (2026-11-06: $99 + $25 a truck, $349 minimum, the same formula at every size,
 * "From $349 a month"), the Leak Read's $750, and "Founding-carrier pricing, quoted after the Read" for Signals, which has no public price. The page is plain HTML, so the numbers are typed there; this
 * keeps the Desk card equal to the desk's own plan numbers in src/lib/plans.ts, so a price changed there cannot go on being sold at the old figure, and keeps the fine print about reads equal to the
 * meter's constants. Skipped when the site is not beside the desk (the desk's own repo on its own).
 */
const PAGE = path.join(__dirname, "..", "..", "..", "..", "truelane-site", "build.html");
const present = existsSync(PAGE);

const textOf = (s: string) => s.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

describe.skipIf(!present)("the pricing on the dispatcher software page", () => {
  const html = present ? readFileSync(PAGE, "utf8") : "";
  const text = textOf(html);
  const starter = PLANS.find((p) => p.key === "starter")!;
  const shown = [...text.matchAll(/\$\d[\d,]*(?:\.\d\d)?/g)].map((m) => m[0].replace(/,$/, ""));

  test("the Desk card is the plans' formula: base, a price for every truck, and the minimum, the same at every size below Enterprise", () => {
    for (const p of PLANS.filter((x) => x.key !== "enterprise")) {
      expect([p.baseCents, p.perTruckCents, p.minCents]).toEqual([starter.baseCents, starter.perTruckCents, starter.minCents]);
    }
    expect(text).toContain(`${centsText(starter.baseCents)} + ${centsText(starter.perTruckCents)} a truck`);
    expect(text).toContain(`${centsText(starter.minCents)} a month minimum`);
  });

  test("the examples on the page are what the formula gives: 10 trucks and 25 trucks", () => {
    expect(text).toContain(`10 trucks is ${centsText(monthlyPriceCents("starter", 10))}`);
    expect(text).toContain(`25 trucks is ${centsText(monthlyPriceCents("growth", 25))}`);
  });

  test("the only dollar amounts are the formula's, its two examples, and the Leak Read's $750", () => {
    const allowed = new Set([starter.baseCents, starter.perTruckCents, starter.minCents, monthlyPriceCents("starter", 10), monthlyPriceCents("growth", 25)].map(centsText).concat("$750"));
    expect(shown.length).toBeGreaterThan(0);
    for (const a of shown) expect(allowed.has(a), `${a} is not on the plans' price list`).toBe(true);
  });

  test("Signals has no public price, only founding-carrier pricing quoted after the Read", () => {
    expect(text).toContain("Founding-carrier pricing");
    expect(text).toContain("Signals is quoted after the Read");
    expect(text).not.toMatch(/\$(20|30) a truck/);
  });

  test("the fine print on reads matches the meter: reads included a truck a month, and the price of an extra one", () => {
    expect(text).toContain(`Each truck includes ${READS_INCLUDED_PER_TRUCK} rate-confirmation reads a month; extra reads are ${OVERAGE_CENTS_PER_READ} cents each, billed separately.`);
    expect(text).toContain(`Each truck includes ${READS_INCLUDED_PER_TRUCK} a month, pooled across your desk. Extra reads are ${OVERAGE_CENTS_PER_READ} cents each`);
  });
});
