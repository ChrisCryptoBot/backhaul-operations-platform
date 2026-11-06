import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { PLANS, centsText } from "@/lib/plans";

/**
 * The dispatcher software page (truelane-site/build.html, in the phone's repo beside this one) no longer lists plans (2026-11-06): it shows the $750 Leak Read and says
 * "Founding-carrier pricing, quoted after the Read" for Signals and the Desk. src/lib/plans.ts stays the desk's own internal plan config. This keeps a plan's price from
 * going on the public page by accident, so a figure is never sold from a stale copy. Skipped when the site is not beside the desk (the desk's own repo on its own).
 */
const PAGE = path.join(__dirname, "..", "..", "..", "..", "truelane-site", "build.html");
const present = existsSync(PAGE);

const textOf = (s: string) => s.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

describe.skipIf(!present)("the pricing on the dispatcher software page", () => {
  const html = present ? readFileSync(PAGE, "utf8") : "";
  const shown = [...textOf(html).matchAll(/\$\d[\d,]*(?:\.\d\d)?/g)].map((m) => m[0]);

  test("the only price is the Leak Read's $750", () => {
    expect(shown.length).toBeGreaterThan(0);
    for (const a of shown) expect(a, `${a} is not the Read's price`).toBe("$750");
  });

  test("no internal plan amount (base or per truck) is on the page", () => {
    const planAmounts = new Set(PLANS.flatMap((p) => [p.baseCents, p.perTruckCents]).filter((c) => c > 0).map((c) => centsText(c)));
    for (const a of shown) expect(planAmounts.has(a), `${a} is one of the plans' amounts`).toBe(false);
  });

  test("Signals and the Desk are founding-carrier pricing, quoted after the Read", () => {
    const t = textOf(html);
    expect(t).toContain("Founding-carrier pricing");
    expect(t).toContain("quoted after the");
  });
});
