import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * A place is display only. Where a unit is, in words, never feeds a figure, a ranking or a verdict: the money, the quote, the KPI and the verdict code do not import the whereabouts
 * modules, and the whereabouts modules make no call to a map provider.
 */
const SRC = join(__dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : /\.(ts|tsx)$/.test(f) ? [join(dir, f)] : []));
const text = (p: string) => readFileSync(p, "utf8");
// Where a unit is and where it has been (the whereabouts, the history, the stays and the check calls) is for people to read; nothing that makes a figure imports any of it.
const IMPORTS_WHEREABOUTS = /from\s+["'](@\/lib\/(whereabouts|asset-history|stays)|@\/server\/tl\/(whereabouts|asset-history|check-calls|stays)|\.\/(whereabouts|asset-history|stays|check-calls)|\.\.\/(whereabouts|asset-history|stays))["']/;

describe("whereabouts stays display only", () => {
  test("no money, quote, KPI, verdict or leak code imports it", () => {
    const guarded = files(SRC).filter((f) => /[\\/](lib[\\/](verdict|kpi[^\\/]*|quote[^\\/]*|leaks|detention|invoicing|settlement|pay[^\\/]*|load-gross|load-fit)\.ts|server[\\/]tl[\\/](kpi[^\\/]*|quote[^\\/]*|leaks|detention|invoicing|settlement|evaluate|driver-rank)\.ts)$/.test(f));
    expect(guarded.length).toBeGreaterThan(5);
    expect(guarded.filter((f) => IMPORTS_WHEREABOUTS.test(text(f)))).toEqual([]);
  });

  test("the whereabouts modules reach no map provider", () => {
    for (const f of [join(SRC, "lib", "whereabouts.ts"), join(SRC, "server", "tl", "whereabouts.ts")]) {
      const t = text(f);
      expect(t, f).not.toMatch(/mapbox|lookupPlace|fetch\(|server\/geo/i);
    }
  });
});
