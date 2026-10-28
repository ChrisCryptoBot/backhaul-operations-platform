import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The chat copilot was removed on purpose. This guard fails if it (or its vocabulary) comes back
 * into the source tree: the modules, the route, the panel, the env vars, or the old "use the copilot" copy.
 */
const root = path.join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|css|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the copilot is gone", () => {
  it("has no copilot module, route or component on disk", () => {
    for (const rel of ["src/server/copilot", "src/components/copilot", "src/app/api/copilot"]) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(false);
    }
  });

  it("mentions the copilot nowhere in src, scripts or the styles", () => {
    const files = [...walk(path.join(root, "src")), ...walk(path.join(root, "scripts"))];
    const hits = files.filter((f) => /copilot|COPILOT/.test(fs.readFileSync(f, "utf8")));
    expect(hits.map((f) => path.relative(root, f))).toEqual([]);
  });
});
