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
  const page = read("app/(desk)/loads/page.tsx");
  // The open board's columns and cells (Loads, History has its own list of columns).
  const board = page.slice(0, page.indexOf("const HISTORY_COLUMNS")) + page.slice(page.indexOf("// Open: what is still moving."));
  const css = read("app/terminal.css");

  test("DataTable takes a column priority and marks folded columns, headers and bands", () => {
    expect(table).toMatch(/priority\?: 1 \| 2 \| 3/);
    expect(table.match(/data-pr=/g)?.length).toBeGreaterThanOrEqual(3);
  });

  test("the open board folds Truck and Answer first (3), then Customer, Pickup, Driver and Miles at 1024 (2), and keeps money and the verdict at 1", () => {
    for (const k of ["truck", "assignment"]) expect(board).toMatch(new RegExp(`key: "${k}"[^}]*priority: 3`));
    for (const k of ["customer", "pickup", "driver", "miles"]) expect(board).toMatch(new RegExp(`key: "${k}"[^}]*priority: 2`));
    for (const k of ["pay", "perMile", "floor", "verdict"]) expect(board).not.toMatch(new RegExp(`key: "${k}"[^}]*priority: [23]`));
  });

  test("what folds stays on the row: the truck beside its driver, and at 1024 the customer, driver and miles on the load's second line", () => {
    expect(board).toContain('className="fold-only q">{r.vehicleName}');
    expect(board).toContain('className="sub fold-2">{[r.brokerName, r.driverName ?? "no driver", miles(r.totalMiles)]');
    expect(css).toMatch(/@container \(max-width:960px\)\{\s*\.dt \[data-pr="2"\]\{display:none\}/);
    expect(css).toMatch(/\.dt \.fold-only\{display:none\}/);
    expect(css).toMatch(/@container \(max-width:1400px\)\{\.dt \[data-pr="3"\]\{display:none\}/);
    expect(css).toMatch(/\.dt-wrap\{container-type:inline-size\}/);
  });

  test("a second status is a square with its word in the tooltip, not a second chip", () => {
    expect(board).toMatch(/className="t-sq" data-tone="bad"[^>]*title="Pickup passed/);
    expect(board).not.toMatch(/tl-chip bad[^>]*>Pickup passed/);
  });
});

describe("a row that looks like it opens, opens", () => {
  test("the table itself carries the row click, so a list without a search toolbar has it too", () => {
    const table = read("components/desk/data-table.tsx");
    expect(table).toContain("rows.some((r) => r.href) ? <RowClicks tableId={id} /> : null");
    expect(read("components/desk/data-table-tools.tsx")).not.toContain("tr[data-href]");
  });
});
