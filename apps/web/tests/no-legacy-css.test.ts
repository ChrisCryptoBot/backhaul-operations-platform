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
      // Wholly: the layer closes once, at the very end. (desk.css once closed it 170 lines early; the rest was unlayered and beat every layer.)
      let depth = 0;
      let closes = 0;
      for (const ch of css) {
        if (ch === "{") depth += 1;
        else if (ch === "}" && --depth === 0) closes += 1;
      }
      expect([depth, closes], `${f} leaves its layer`).toEqual([0, 1]);
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
    expect(count(desk, /style=\{\{/g)).toBeLessThanOrEqual(494);
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

describe("the TrueLane app style's curvature (committed, 2026-11-23)", () => {
  const css = strip(read("app/terminal.css"));
  const appLayer = css.slice(css.lastIndexOf("@layer app {"));

  test("the curve tokens are the phone's radius by role (press 6, field 8, tile 10, note 14, card 20, pill), set only under the app style", () => {
    expect(appLayer).toContain("--r-press:6px; --r-field:8px; --r-tile:10px; --r-note:14px; --r-card:20px; --r-pill:999px;");
    expect(appLayer).toContain("--db-r-sm:6px; --db-r-press:6px; --db-r-md:8px; --db-r-field:8px; --db-r-tile:10px; --db-r-lg:14px; --db-r-note:14px; --db-r-card:20px; --db-r-pill:999px;");
    // Defined once, under [data-ui="app"]: Night and Day have none.
    expect(css.match(/--r-(press|field|tile|note|card|pill):/g)?.length).toBe(6);
  });

  test("every curve is scoped to the app style; rows, cells and the status word stay square (a status dot is round)", () => {
    const curved = [...css.matchAll(/([^{}]+)\{[^{}]*border-radius:var\(--r-[a-z]+\)/g)].map((m) => m[1]!.trim());
    expect(curved.length).toBeGreaterThan(10);
    for (const sel of curved) {
      expect(sel.startsWith('[data-ui="app"]')).toBe(true);
      expect(sel).not.toMatch(/\.tl-chip\b|\.t-st(?!::before)\b/);
    }
  });

  test("legacy-flat.css flattens Cockpit Night and Day only, never the app style", () => {
    const flat = read("app/legacy-flat.css");
    expect(flat).toContain(':root:not([data-ui="app"]) *:not(.vm):not(.vm *),');
    expect(flat).not.toMatch(/^\*:not\(\.vm\)/m);
  });
});
