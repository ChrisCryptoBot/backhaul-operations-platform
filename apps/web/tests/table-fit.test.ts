import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

/**
 * The Loads board must fit its room with no sideways scroll (Wave 1 of the UI/UX blueprint). Secondary columns carry priority 3 and fold away under a container query; what they showed (driver, truck) moves into the
 * Load cell's second line, so folding hides no fact. Measured in the browser at 1440 wide: table 1209px in a 1209px wrap. These checks pin the mechanism, not the pixels.
 */
const SRC = join(__dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8").split(String.fromCharCode(13)).join("");

describe("the board folds secondary columns instead of scrolling sideways", () => {
  const table = read("components/desk/data-table.tsx");
  const board = read("app/(desk)/loads/page.tsx");
  const css = read("app/terminal.css");

  test("DataTable takes a column priority and marks folded columns, headers and bands", () => {
    expect(table).toMatch(/priority\?: 1 \| 2 \| 3/);
    expect(table.match(/data-pr=/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("the open board marks Truck, Driver and Answer as priority 3, and keeps money and the verdict at 1", () => {
    for (const k of ["truck", "driver", "assignment"]) expect(board).toMatch(new RegExp(`key: "${k}"[^}]*priority: 3`));
    for (const k of ["pay", "perMile", "floor", "verdict"]) expect(board).not.toMatch(new RegExp(`key: "${k}"[^}]*priority: 3`));
  });

  test("the driver and truck stay on the row when their columns fold", () => {
    expect(board).toMatch(/className="fold-only"/);
    expect(css).toMatch(/\.dt \.fold-only\{display:none\}/);
    expect(css).toMatch(/@container \(max-width:1400px\)\{\.dt \[data-pr="3"\]\{display:none\}/);
    expect(css).toMatch(/\.dt-wrap\{container-type:inline-size\}/);
  });

  test("a second status is a square with its word in the tooltip, not a second chip", () => {
    expect(board).toMatch(/className="t-sq" data-tone="bad"[^>]*title="Pickup passed/);
    expect(board).not.toMatch(/tl-chip bad[^>]*>Pickup passed/);
  });
});
