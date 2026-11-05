import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => fs.readFileSync(path.join(__dirname, "..", p), "utf8").replace(/\r\n/g, "\n");

/**
 * A load outside the driver's shift is shown with a full outline and a chip, never a coloured strip down one edge (the standing design rule, docs/DESIGN_BRIEF.md), flat, with no radius,
 * from the existing tokens, and it says so in words as well as colour.
 */
describe("the planner's shift flag keeps to the design rules", () => {
  const css = read("src/app/terminal.css");
  const rule = (selector: string) => {
    const at = css.indexOf(selector + "{");
    expect(at, `${selector} is in terminal.css`).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf("}", at));
  };

  it("outlines the whole card and draws no edge strip", () => {
    const flagged = rule(".pl-load.shiftflag");
    expect(flagged).toMatch(/outline:\s*1px solid var\(--neg/);
    for (const r of [flagged, rule(".pl-flag"), rule(".pl-shift"), rule(".pl-shift.off")]) {
      expect(r).not.toMatch(/border-left|border-right|border-inline|inset\s+[-\d]+px\s+0/);
      expect(r).not.toMatch(/border-radius:\s*[1-9]/);
    }
  });

  it("is a chip with words and an icon, so colour is not the only signal", () => {
    const parts = read("src/components/desk/planner-parts.tsx");
    expect(parts).toContain('className="pl-flag"');
    expect(parts).toMatch(/<Icon name="alert"[^>]*\/> \{i\.shiftFlag\.tag\}/);
    expect(parts).toContain("i.shiftFlag.words");
    const lib = read("src/lib/shifts.ts");
    expect(lib).toContain('exceeds_end: "EXCEEDS SHIFT END"');
    expect(lib).toContain('before_start: "BEFORE SHIFT START"');
    expect(lib).toContain('off_duty: "OFF DUTY"');
  });

  it("a day off is a sunk cell with OFF DUTY printed in it", () => {
    expect(rule(".pl td.off")).toMatch(/background:\s*var\(--sunk\)/);
    expect(read("src/components/desk/planner-parts.tsx")).toContain("OFF DUTY");
  });
});
