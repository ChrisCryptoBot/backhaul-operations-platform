import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { uiZoom } from "../src/lib/ui-zoom";

/**
 * Big screens: the desk scales itself the way 125% browser zoom would (terminal.css, --ui-zoom on the root). A pop-up placed from getBoundingClientRect() must divide by that zoom, or it lands
 * far from its field (measured: the calendar sat 100px below its button at 1904px wide before the fix, 10px after).
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8").split(String.fromCharCode(13)).join("");

describe("the desk's big-screen zoom", () => {
  const css = read("app/terminal.css");

  test("steps up at 1500px and 1700px, never on print, and viewport-sized boxes divide by it", () => {
    expect(css).toMatch(/@media \(min-width:1500px\)\{:root\{--ui-zoom:1\.12\}\}/);
    expect(css).toMatch(/@media \(min-width:1700px\)\{:root\{--ui-zoom:1\.25\}\}/);
    expect(css).toMatch(/html\{zoom:var\(--ui-zoom\)\}/);
    expect(css).toMatch(/--vh:calc\(100vh \/ var\(--ui-zoom\)\)/);
    expect(css).toMatch(/\.t-app\{height:var\(--vh\)\}/);
    expect(css).toMatch(/@media print\{html\{zoom:1\}/);
  });

  test("every component that places a pop-up from element positions reads the zoom", () => {
    for (const f of ["date-input", "address-input", "scope-menu", "verdict-card", "quote-desk", "kit/tooltip"]) {
      expect(read(`components/desk/${f}.tsx`), f).toMatch(/uiZoom\(\)/);
    }
  });

  test("off the browser the zoom is 1", () => {
    expect(uiZoom()).toBe(1);
  });
});
