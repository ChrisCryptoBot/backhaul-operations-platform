import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The header rule: every module's head (its title and actions) stays on screen as the page scrolls, and its tab or filter bar pins right under it. What is pinned is the slim bar only: the one-line description
 * is not inside it and scrolls away. The head's real height is kept in --ph-h so the bar sits flush under it at any width.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const css = read("app/terminal.css");
const block = css.slice(css.indexOf("/* Pinned chrome:"));

describe("the page head and tab bar stay on screen", () => {
  test("the head is pinned, and the tab, filter and unit-tab bars pin under it by the measured height", () => {
    expect(block).toMatch(/\.t-main>\.t-pagehead\{position:sticky;top:0;z-index:\d+/);
    expect(block).toMatch(/\.t-main>\.t-pagehead~:is\(\.kbar,\.tl-tabs,\.eq-tabs\)\{position:sticky;top:var\(--ph-h,\d+px\)/);
  });

  test("the pinned bars are flat: a solid ground and a 1px rule, no shadow, blur or gradient", () => {
    expect(block).toMatch(/background:var\(--bg\);border-bottom:1px solid var\(--line\)/);
    expect(block.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/shadow|blur|gradient/i);
  });

  test("the description is outside the bar, so what stays pinned is slim", () => {
    const ui = read("components/desk/ui.tsx");
    const head = ui.slice(ui.indexOf("export function PageHead"), ui.indexOf("export function Card"));
    expect(head).toMatch(/<div className="t-pagehead">[\s\S]*<\/div>\s*\{sub \? <div className="t-pagesub">/);
    expect(head.slice(head.indexOf('<div className="t-pagehead">'), head.indexOf("</div>\n      {sub"))).not.toMatch(/\bsub\b/);
  });

  test("the shell keeps the measured height up to date", () => {
    expect(read("components/desk/desk-shell.tsx")).toMatch(/<PinnedChrome \/>/);
    const chrome = read("components/desk/pinned-chrome.tsx");
    expect(chrome).toMatch(/--ph-h/);
    expect(chrome).toMatch(/ResizeObserver/);
  });
});
