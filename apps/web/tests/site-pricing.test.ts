import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PLANS, centsText, limitOf, type Plan } from "@/lib/plans";

/**
 * The dispatcher software page (truelane-site/build.html, in the phone's repo beside this one) shows the plans. The page is plain HTML, so the numbers are typed there; this keeps
 * each card equal to the desk's own plan numbers, so a price changed in src/lib/plans.ts cannot go on being sold at the old figure. Skipped when the site is not beside the desk
 * (the desk's own repo on its own).
 */
const PAGE = path.join(__dirname, "..", "..", "..", "..", "truelane-site", "build.html");
const present = existsSync(PAGE);

const cards = (html: string): string[] => {
  const section = html.slice(html.indexOf('id="pricing"'), html.indexOf('id="shelf"'));
  return section.split('<div class="blueprint price-card">').slice(1);
};
const textOf = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const priceOf = (p: Plan) => (p.perTruckCents > 0 ? `${centsText(p.baseCents)} /mo + ${centsText(p.perTruckCents)} a truck` : `${centsText(p.baseCents)} /mo`);
const fleetOf = (p: Plan) => (p.max == null ? `${p.min} trucks and up` : `${p.min} to ${p.max} trucks`);

describe.skipIf(!present)("the plans on the dispatcher software page", () => {
  const html = present ? readFileSync(PAGE, "utf8") : "";
  const found = cards(html);

  test("one card per plan, in the plans' order, each with the plan's name, price and fleet size", () => {
    expect(found).toHaveLength(PLANS.length);
    PLANS.forEach((p, i) => {
      const t = textOf(found[i]!);
      expect(t).toContain(p.label);
      expect(t).toContain(priceOf(p));
      expect(t).toContain(fleetOf(p));
    });
  });

  test("each card states the limits the desk enforces: trucks, and twice as many drivers and trailers", () => {
    PLANS.forEach((p, i) => {
      const t = textOf(found[i]!);
      const trucks = limitOf(p.key, "truck");
      if (trucks == null) {
        expect(t).toContain("No automatic limit");
        return;
      }
      expect(t).toContain(`Up to ${trucks} trucks`);
      expect(t).toContain(`Up to ${limitOf(p.key, "driver")} drivers and ${limitOf(p.key, "trailer")} trailers`);
    });
  });

  test("no other price is quoted on the page", () => {
    const amounts = new Set(PLANS.flatMap((p) => [p.baseCents, p.perTruckCents]).filter((c) => c > 0).map((c) => centsText(c)));
    const shown = [...textOf(html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ")).matchAll(/\$\d[\d,]*(?:\.\d\d)?/g)].map((m) => m[0]);
    expect(shown.length).toBeGreaterThan(0);
    for (const a of shown) expect(amounts.has(a), `${a} is not one of the plans' amounts`).toBe(true);
  });
});
