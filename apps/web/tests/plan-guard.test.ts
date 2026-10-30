import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every path that makes a truck, a driver or a trailer, or brings one back (restores a truck or trailer, reactivates a driver), takes the plan's room check inside its own
 * transaction: `lockWorkspace` and then `roomFor`. A new path that skips it is how fifty trucks get added on a three-truck plan, so this reads the source and fails on one.
 */
const SRC = path.join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "truelane" ? [] : files(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const MODEL = "(?:vehicle|driver|trailer|member)";
const SITES = [
  new RegExp(`\\b${MODEL}\\.(?:create|createMany|upsert)\\(`),
  // bringing one back: archivedAt cleared (or set from a flag), or a driver made active
  new RegExp(`\\b${MODEL}\\.update(?:Many)?\\(.*(?:archivedAt: null|archivedAt: archived|active: true|\\{ active \\})`)
];
const WINDOW = 80;

type Site = { file: string; line: number; checked: boolean };

function sites(): Site[] {
  const out: Site[] = [];
  for (const f of files(SRC)) {
    const lines = readFileSync(f, "utf8").split(/\r?\n/);
    lines.forEach((text, i) => {
      if (!SITES.some((re) => re.test(text))) return;
      const before = lines.slice(Math.max(0, i - WINDOW), i + 1).join("\n");
      out.push({ file: path.relative(SRC, f), line: i + 1, checked: before.includes("lockWorkspace(") && before.includes("roomFor(") });
    });
  }
  return out;
}

describe("the plan's room check", () => {
  const found = sites();

  it("sees the paths it is guarding (a scan that finds nothing proves nothing)", () => {
    // fleet.ts: driver add, driver reactivate, truck add, truck restore; trailers.ts: add, restore; import.ts: three createMany; members.ts: add a person (a seat)
    expect(found.length).toBeGreaterThanOrEqual(10);
    expect(new Set(found.map((s) => s.file))).toEqual(new Set([path.join("server", "tl", "fleet.ts"), path.join("server", "tl", "trailers.ts"), path.join("server", "tl", "import.ts"), path.join("server", "tl", "members.ts")]));
  });

  it("is taken, under the workspace lock, before every create and every bring-back", () => {
    const missing = found.filter((s) => !s.checked).map((s) => `${s.file}:${s.line}`);
    expect(missing, "Add `await lockWorkspace(tx, workspaceId)` and `await roomFor(kind, 1, workspaceId, tx)` inside the writing transaction (src/server/tl/plan.ts).").toEqual([]);
  });
});
