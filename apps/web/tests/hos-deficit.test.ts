import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hosDeficit, hosDeficitLabel, hosDeficitTitle } from "../src/lib/hos-deficit";

/**
 * The hours-deficit tag on a Fleet Matrix row: a note beside the verdict. It reads what the server's hours check already decided
 * (`level`), and words how far short the truck is.
 */
describe("hosDeficit", () => {
  it("flags a truck whose clock is shorter than the trip, with the hours the load needs", () => {
    const d = hosDeficit({ level: "short", availableHours: 6, tripHours: 22 });
    expect(d).toEqual({ needsHours: 22, leftHours: 6, shortByHours: 16 });
    expect(d && hosDeficitLabel(d)).toBe("Deficit: needs 22h");
    expect(d && hosDeficitTitle(d)).toBe("Has 6h left on the clock; about 16h short.");
  });

  it("rounds the need UP: a dispatcher is never told the load needs less than it does", () => {
    expect(hosDeficit({ level: "short", availableHours: 6, tripHours: 21.2 })?.needsHours).toBe(22);
    expect(hosDeficit({ level: "short", availableHours: 6.5, tripHours: 21.2 })?.shortByHours).toBe(15);
  });

  it("does not let floating-point noise from the drive-time spread tip a whole hour into the next", () => {
    expect(hosDeficit({ level: "short", availableHours: 6, tripHours: 22.0000000001 })?.needsHours).toBe(22);
    expect(hosDeficit({ level: "short", availableHours: 6, tripHours: 22.1 })?.needsHours).toBe(23);
  });

  it("shows the hours left to a tenth, and a truck with none left is short too", () => {
    expect(hosDeficit({ level: "short", availableHours: 6.25, tripHours: 12 })?.leftHours).toBe(6.3);
    expect(hosDeficit({ level: "short", availableHours: 0, tripHours: 8 })).toEqual({ needsHours: 8, leftHours: 0, shortByHours: 8 });
  });

  it("says nothing unless the server's own check said short: 'nearly all' and 'fine' are not a deficit", () => {
    expect(hosDeficit({ level: "caution", availableHours: 11, tripHours: 10 })).toBeNull();
    expect(hosDeficit({ level: "none", availableHours: 6, tripHours: 22 })).toBeNull();
  });

  it("says nothing when a figure is missing or cannot be right", () => {
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(hosDeficit({ level: "short", availableHours: bad, tripHours: 22 })).toBeNull();
      expect(hosDeficit({ level: "short", availableHours: 6, tripHours: bad })).toBeNull();
    }
    expect(hosDeficit({ level: "short", availableHours: -1, tripHours: 22 })).toBeNull();
    expect(hosDeficit({ level: "short", availableHours: 6, tripHours: 0 })).toBeNull();
    expect(hosDeficit({ level: "short", availableHours: 6, tripHours: -4 })).toBeNull();
  });

  it("says nothing when the level and the figures disagree (the trip fits the clock)", () => {
    expect(hosDeficit({ level: "short", availableHours: 11, tripHours: 8 })).toBeNull();
    expect(hosDeficit({ level: "short", availableHours: 8, tripHours: 8 })).toBeNull();
  });
});

/** The matrix is client code with no component tests here, so these read the source for the two things that must stay true. */
describe("the deficit tag in the Fleet Matrix row", () => {
  const tsx = fs.readFileSync(path.join(__dirname, "../src/components/desk/quote-desk.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../src/components/desk/quote-terminal.css"), "utf8");

  it("sits with the hours left, inside the same hours-left block, and only when the truck has hours", () => {
    const start = tsx.indexOf("r.hos.availableHours != null ? (");
    const end = tsx.indexOf("r.blocked ?", start);
    expect(start).toBeGreaterThan(-1);
    const block = tsx.slice(start, end);
    expect(block).toMatch(/Hours left:/);
    expect(block).toMatch(/hosDeficitLabel\(deficit\)/);
    expect(block).toMatch(/className="tl-chip warn"/);
  });

  it("is built from the server's own caution level and the trip's on-duty hours, not from elapsed hours", () => {
    expect(tsx).toMatch(/hosDeficit\(\{ level: r\.hos\.caution\.level, availableHours: r\.hos\.availableHours, tripHours: r\.detail\.metrics\.tripHours \}\)/);
    expect(tsx).not.toMatch(/hosDeficit\([^)]*elapsedHours/);
  });

  it("is a note, not a gate: it never feeds `blocked`, and adds no second live region", () => {
    expect(tsx).not.toMatch(/blocked[^;\n]*deficit|deficit[^;\n]*blocked/i);
    expect(tsx.match(/aria-live="polite"/g)).toHaveLength(1);
  });

  it("has its own line in the matrix CSS and uses only the design tokens (no hex colours)", () => {
    const rule = css.match(/\.qt-hos-line \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toMatch(/display:\s*flex/);
    expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const chip = css.match(/\.qt-hos-line \.tl-chip \{[^}]*\}/)?.[0] ?? "";
    expect(chip).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("the gross rate line under the Offer field", () => {
  const tsx = fs.readFileSync(path.join(__dirname, "../src/components/desk/quote-desk.tsx"), "utf8");

  it("is read off the Offer and Loaded fields, and is a quiet hint line, not a live region", () => {
    expect(tsx).toMatch(/note=\{grossNote\(values\.offer, values\.loadedMiles\)\}/);
    const money = tsx.slice(tsx.indexOf("function Money("), tsx.indexOf("/** What the audited math said"));
    expect(money).toMatch(/\{note \? <span className="th-hint">\{note\}<\/span> : null\}/);
    expect(money).not.toMatch(/aria-live/);
  });

  it("tells the net 'Load rate' apart from it, since the two numbers differ by the fees", () => {
    expect(tsx).toMatch(/Load rate after fees \(loaded miles\)/);
  });
});
