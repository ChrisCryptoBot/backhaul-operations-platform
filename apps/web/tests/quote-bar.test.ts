import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The compact verdict bar on Quote. Below 1100 px the verdict drops under the form, so a slim sticky bar keeps its headline in view.
 * Above that the verdict is already sticky beside the form, so the bar must not show. These read the source, since the layout is CSS.
 */
const css = fs.readFileSync(path.join(__dirname, "../src/app/(desk)/desk.css"), "utf8");
const tsx = fs.readFileSync(path.join(__dirname, "../src/components/desk/quote-desk.tsx"), "utf8");

describe("Quote verdict bar", () => {
  it("is hidden by default and shown only inside the 1100 px media query", () => {
    expect(css).toMatch(/\.qt-bar\s*\{\s*display:\s*none;/);
    const mq = css.match(/@media \(max-width: 1100px\) \{\s*\.qt-bar \{([^}]*)\}/);
    expect(mq?.[1]).toMatch(/display:\s*flex/);
    expect(mq?.[1]).toMatch(/position:\s*sticky/);
  });

  it("sticks below the floating header, not over it", () => {
    const top = css.match(/\.qt-bar \{[^}]*position: sticky; top: (\d+)px/);
    expect(Number(top?.[1])).toBeGreaterThanOrEqual(76);
  });

  it("is glass like the header, with a solid fallback", () => {
    expect(css).toMatch(/\.tl-header, \.qt-bar, \.dr,/);
    expect(css).toMatch(/@supports not[^{]*\{[^}]*\.qt-bar/);
    expect(css).toMatch(/prefers-reduced-transparency: reduce\) \{[^}]*\.qt-bar/);
  });

  it("is not a second live region: only the verdict panel announces", () => {
    const bar = tsx.slice(tsx.indexOf('className="qt-bar"'), tsx.indexOf('<div className="qt">'));
    expect(bar).not.toMatch(/aria-live/);
    expect(bar).not.toMatch(/aria-hidden/);
    expect(tsx.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("jumps to the verdict panel by id", () => {
    expect(tsx).toMatch(/getElementById\("qt-verdict"\)/);
    expect(tsx).toMatch(/<aside id="qt-verdict"/);
  });
});
