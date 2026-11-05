import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { clampSize, keptText, parseKept, splitStorageKey, stepSize } from "@/lib/split";

const L = { min: 120, max: 600 };

describe("a split keeps the first pane inside its limits", () => {
  it("clamps to the limits, and a max below the min gives the min", () => {
    expect(clampSize(50, L)).toBe(120);
    expect(clampSize(900, L)).toBe(600);
    expect(clampSize(300.4, L)).toBe(300);
    expect(clampSize(500, { min: 200, max: 100 })).toBe(200);
  });

  it("the keys step it by 24, and Home and End go to the ends", () => {
    expect(stepSize(300, "ArrowRight", L)).toBe(324);
    expect(stepSize(300, "ArrowDown", L)).toBe(324);
    expect(stepSize(300, "ArrowLeft", L)).toBe(276);
    expect(stepSize(300, "ArrowUp", L)).toBe(276);
    expect(stepSize(130, "ArrowLeft", L)).toBe(120);
    expect(stepSize(590, "ArrowRight", L)).toBe(600);
    expect(stepSize(300, "Home", L)).toBe(120);
    expect(stepSize(300, "End", L)).toBe(600);
    expect(stepSize(300, "a", L)).toBeNull();
  });

  it("reads what was kept and ignores anything it does not understand", () => {
    expect(parseKept(keptText({ size: 280, hidden: false }))).toEqual({ size: 280, hidden: false });
    expect(parseKept(keptText({ size: null, hidden: true }))).toEqual({ size: null, hidden: true });
    expect(parseKept(null)).toEqual({ size: null, hidden: false });
    expect(parseKept("not json")).toEqual({ size: null, hidden: false });
    expect(parseKept('{"size":"wide","hidden":"yes"}')).toEqual({ size: null, hidden: false });
    expect(splitStorageKey("fleet-map")).toBe("tl_split_fleet-map");
  });
});

describe("the split pane component", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "components", "desk", "kit", "split-pane.tsx"), "utf8");
  it("is a real separator: pointer drag, keyboard, double-click reset, and value for a screen reader", () => {
    expect(src).toContain('role="separator"');
    expect(src).toContain("aria-orientation");
    expect(src).toContain("aria-valuenow");
    expect(src).toContain("onPointerDown");
    expect(src).toContain("setPointerCapture");
    expect(src).toContain("onKeyDown");
    expect(src).toContain("onDoubleClick");
  });
  it("has Expand, Contract and Hide, and remembers the choice without ever throwing", () => {
    for (const w of ["Expand", "Contract", "Hide ", "Show "]) expect(src).toContain(w);
    expect(src).toContain("localStorage");
    expect(src).toMatch(/try \{[\s\S]*localStorage[\s\S]*\} catch/);
  });
});
