import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * WCAG contrast for the desk's two themes. Reads src/app/terminal.css (the one place colours are defined), resolves each token, and checks every pair that carries text:
 * the ink jobs (ink, mid, dim, label, typed) on every surface, each verdict tone on the panel, and text on the amber bar and on the fills.
 * 4.5:1 for text; 3:1 for the fills that carry only squares, bars and marks.
 */
const css = fs.readFileSync(path.join(__dirname, "../src/app/terminal.css"), "utf8");

function block(selectorRe: RegExp): Record<string, string> {
  const m = css.match(new RegExp(`${selectorRe.source}\\s*\\{([^}]*)\\}`, "m"));
  if (!m) throw new Error(`no block for ${selectorRe}`);
  const out: Record<string, string> = {};
  for (const d of m[1]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out[d[1]!] = d[2]!.trim();
  return out;
}

const night = block(/:root,\s*\[data-theme="night"\]/);
const day = { ...night, ...block(/\[data-theme="day"\]/) };

function rgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
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
/** Every surface text can sit on. */
const SURFACES = ["--bg", "--panel", "--head", "--sunk", "--hover"];
/** Ink that carries words. `--faint` is for disabled controls and rules only and is not tested. */
const TEXT = ["--ink", "--mid", "--dim"];
/** Verdict, delta and money-state inks: text on a panel. */
const TONES = ["--pos", "--neg", "--warn"];

describe.each(Object.entries(THEMES))("%s theme contrast", (_name, t) => {
  it("defines every token the tests read, as hex", () => {
    for (const k of [...SURFACES, ...TEXT, ...TONES, "--label", "--label-hi", "--typed", "--bar", "--on-bar", "--pos-fill", "--neg-fill", "--warn-fill", "--on-fill", "--line-hi", "--prompt"]) {
      expect(t[k], k).toMatch(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    }
  });

  it.each(TEXT.flatMap((fg) => SURFACES.map((bg) => [fg, bg] as const)))("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  // The gold (what a thing is) and the blue (what a person typed) are read on the panel, its header bar and the sunk field they are typed into.
  it.each(["--label", "--typed"].flatMap((fg) => ["--panel", "--head", "--sunk", "--hover", "--bg"].map((bg) => [fg, bg] as const)))("%s on %s is at least 4.5:1", (fg, bg) => {
    expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--panel", "--head", "--sunk", "--hover"])("verdict, delta and money-state inks are readable on %s", (bg) => {
    for (const fg of TONES) expect(ratio(t[fg]!, t[bg]!), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
  });

  // The open row, the current rail item and the primary button are an amber bar with black ink, in both themes.
  it("black ink on the amber bar is at least 4.5:1", () => {
    expect(ratio(t["--on-bar"]!, t["--bar"]!)).toBeGreaterThanOrEqual(4.5);
    expect(t["--on-bar"]!.toLowerCase()).toBe("#000");
  });

  it("black or white ink on each verdict fill is at least 4.5:1 (the glyph inside the mark)", () => {
    for (const fill of ["--pos-fill", "--neg-fill", "--warn-fill"]) expect(ratio(t["--on-fill"]!, t[fill]!), `${fill} ${t[fill]}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(["--pos-fill", "--neg-fill", "--warn-fill", "--label", "--typed"])("%s is at least 3:1 against the panel (squares, bars and marks)", (fill) => {
    expect(ratio(t[fill]!, t["--panel"]!), `${fill} ${t[fill]}`).toBeGreaterThanOrEqual(3);
  });

  it("the rules between panels are visible (the strong line is at least 3:1 on the panel)", () => {
    expect(ratio(t["--line-hi"]!, t["--panel"]!)).toBeGreaterThanOrEqual(3);
  });
});

describe("the day theme keeps the parchment ground", () => {
  it("panel is the ledger tone #f5f2eb, not white", () => {
    expect(day["--panel"]!.toLowerCase()).toBe("#f5f2eb");
  });
});
