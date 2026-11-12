import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The finish line for the move from the old stylesheets to the terminal system (docs/TERMINAL_MIGRATION.md, Wave 0 of the UI/UX blueprint).
 *
 * Two kinds of check. The layer checks pin how the cascade is built: terminal.css declares the layer order and wins over the legacy sheets, and nothing new lands in an unlayered file (an unlayered rule beats
 * every layer, whatever its selector). The ratchets only go down: each number below is today's count, and a wave that removes some lowers it. Never raise one; fix the page instead.
 */
const SRC = join(__dirname, "..", "src");
const CR = String.fromCharCode(13);
const read = (p: string) => readFileSync(join(SRC, p), "utf8").split(CR).join("");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function walk(dir: string, ext: string[], out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}
const count = (files: string[], re: RegExp) => files.reduce((n, f) => n + (readFileSync(f, "utf8").match(re) ?? []).length, 0);

const LEGACY = ["app/globals.css", "app/(desk)/desk.css", "components/desk/cockpit.css", "components/desk/quote-terminal.css"];

describe("cascade layers", () => {
  test("terminal.css declares the order once, base < vendor < legacy < terminal < app, before any rule", () => {
    const css = strip(read("app/terminal.css"));
    expect(css.trimStart().startsWith("@layer base, vendor, legacy, terminal, app;")).toBe(true);
    expect(css.match(/@layer\s+base\s*,\s*vendor\s*,\s*legacy\s*,\s*terminal\s*,\s*app\s*;/g)).toHaveLength(1);
  });

  test("every legacy sheet sits wholly inside @layer legacy, so terminal.css wins whatever the import order or specificity", () => {
    for (const f of LEGACY) {
      const css = strip(read(f)).trim();
      expect(css.startsWith("@layer legacy {"), f).toBe(true);
      expect(css.endsWith("}"), f).toBe(true);
    }
  });

  test("the TrueLane app style is in the app layer, and nothing is nested inside the terminal layer's own name (a nested layer of the same name loses to its parent)", () => {
    const css = strip(read("app/terminal.css"));
    expect(css).toMatch(/@layer app \{\s*\n?\s*\/\*|@layer app \{/);
    expect(css).not.toMatch(/@layer terminal \{[^@]*@layer terminal \{/);
    const depthOk = (() => {
      let depth = 0;
      let inTerminal = false;
      for (const line of css.split("\n")) {
        if (/^@layer terminal \{/.test(line)) { inTerminal = true; depth = 1; continue; }
        if (inTerminal && /^\s+@layer terminal\b/.test(line)) return false;
      }
      return depth >= 0;
    })();
    expect(depthOk).toBe(true);
  });

  test("the unlayered sheets are only the two that carry their own classes, the map library's layered import, and the transitional flattener", () => {
    const files = walk(SRC, [".css"]).map((f) => f.slice(SRC.length + 1).split("\\").join("/"));
    const unlayered = files.filter((f) => !/^app\/terminal\.css$/.test(f) && !LEGACY.includes(f));
    expect(unlayered.sort()).toEqual(["app/legacy-flat.css", "components/desk/maplibre-vendor.css", "components/desk/public.css", "components/desk/splash.css"]);
  });
});

describe("ratchets (only ever lowered)", () => {
  const desk = [...walk(join(SRC, "components", "desk"), [".tsx"]), ...walk(join(SRC, "app", "(desk)"), [".tsx"])];
  const legacyCss = LEGACY.filter((f) => !f.endsWith("globals.css")).map((f) => join(SRC, f));

  test("inline style={{ }} in desk screens", () => {
    expect(count(desk, /style=\{\{/g)).toBeLessThanOrEqual(601);
  });

  test("non-zero border-radius written in the legacy sheets (legacy-flat.css still flattens them; remove it only when this is 0)", () => {
    expect(count(legacyCss, /border-radius:\s*(?!0[;\s}]|var\(--db-r)[^;}]+/g)).toBeLessThanOrEqual(150);
  });

  test("!important in the legacy sheets", () => {
    expect(count(legacyCss, /!important/g)).toBeLessThanOrEqual(9);
  });

  test("legacy-flat.css is only deleted once the radii above are gone", () => {
    const radii = count(legacyCss, /border-radius:\s*(?!0[;\s}]|var\(--db-r)[^;}]+/g);
    const flat = walk(SRC, [".css"]).some((f) => f.endsWith("legacy-flat.css"));
    if (!flat) expect(radii).toBe(0);
  });
});
