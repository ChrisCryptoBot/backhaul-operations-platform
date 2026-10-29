import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast for the desk's two themes. Reads src/app/globals.css, resolves each token, and checks every pair that carries text:
 * body text on every surface, accent text, each tone on its own soft background, and text on the accent fill.
 * 4.5:1 for text; 3:1 for the fills that carry only bars and dots.
 */
const css = fs.readFileSync(path.join(__dirname, "../src/app/globals.css"), "utf8");

function block(selectorRe: RegExp): Record<string, string> {
  const m = css.match(new RegExp(`${selectorRe.source}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`no block for ${selectorRe}`);
  const out: Record<string, string> = {};
  for (const d of m[1].matchAll(/(--db-[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}

const night = block(/:root,\s*\[data-theme="night"\]/);
const day = { ...night, ...block(/\[data-theme="day"\]/) };

function rgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
function lum(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const THEMES = { night, day } as const;
const SURFACES = ["--db-bg", "--db-bg-card", "--db-bg-inset", "--db-bg-rail"];
const TEXT = ["--db-fg", "--db-fg-mid", "--db-fg-dim"];
const TONES: Array<[string, string]> = [
  ["--db-pos", "--db-pos-bg"],
  ["--db-neg", "--db-neg-bg"],
  ["--db-warn", "--db-warn-bg"],
  ["--db-info", "--db-info-bg"],
  ["--db-muted-fg", "--db-muted-bg"],
  ["--db-accent-fg", "--db-accent-bg"]
];

describe.each(Object.entries(THEMES))("%s theme contrast", (_name, t) => {
  it("defines every token the tests read, as hex", () => {
    for (const k of [...SURFACES, ...TEXT, ...TONES.flat(), "--db-accent", "--db-accent-on", "--db-pos-fill", "--db-neg-fill", "--db-warn-fill", "--db-info-fill", "--db-accent-ink"]) {
      expect(t[k], k).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)("accent text and every tone's text are readable on %s", (bg) => {
    for (const fg of ["--db-accent-fg", "--db-pos", "--db-neg", "--db-warn", "--db-info"]) {
      expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(TONES)("%s on its soft background %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  // Raised and interactive surfaces: hovered rows and the active nav item (elev 2 and 3), inputs and placeholders, and the selected-row fill.
  const RAISED = ["--db-bg-elev-2", "--db-bg-elev-3", "--db-bg-input", "--db-accent-bg"];
  it.each(TEXT.flatMap((fg) => RAISED.map((bg) => [fg, bg] as const)))("%s on the raised surface %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each([...SURFACES, ...RAISED])("the gold kicker (accent text) is readable on %s", (bg) => {
    expect(ratio(t["--db-accent-fg"]!, t[bg]!), `${t["--db-accent-fg"]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  it("text on the accent fill is at least 4.5:1", () => {
    expect(ratio(t["--db-accent-on"]!, t["--db-accent"]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--db-pos-fill", "--db-neg-fill", "--db-warn-fill", "--db-info-fill", "--db-accent-ink"])("%s is at least 3:1 against the card (bars and dots)", (fill) => {
    expect(ratio(t[fill]!, t["--db-bg-card"]!), `${fill} ${t[fill]}`).toBeGreaterThanOrEqual(3);
  });
});
