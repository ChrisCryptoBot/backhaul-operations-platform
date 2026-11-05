import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { feet, gallons, miles, perGallon, perMile, usd } from "@/lib/desk-format";

describe("numbers are the product: one minus, honest blanks, fixed decimals", () => {
  it("a loss carries the real minus (U+2212), never a hyphen", () => {
    expect(usd(-1945, 2)).toBe("−$1,945.00");
    expect(usd(-162)).toBe("−$162");
    expect(perMile(-0.34)).toBe("−$0.34/mi");
  });

  it("dollars to the cent where owed and to the dollar where summarised; rates to two places", () => {
    expect(usd(1945, 2)).toBe("$1,945.00");
    expect(usd(5940)).toBe("$5,940");
    expect(perMile(2.1)).toBe("$2.10/mi");
  });

  it("a figure that is not known is a dash, never 0 and never a guess", () => {
    expect(usd(null)).toBe("—");
    expect(usd(undefined, 2)).toBe("—");
    expect(usd(Number.NaN)).toBe("—");
    expect(perMile(null)).toBe("—");
    expect(miles(undefined)).toBe("—");
  });

  it("a negative that rounds to nothing is not shown as a loss", () => {
    expect(usd(-0.2)).toBe("$0");
    expect(perMile(-0.001)).toBe("$0.00/mi");
  });

  it("a price a gallon is two places (three for a discount), a dash when unknown, and gallons are to a tenth", () => {
    expect(perGallon(3.899)).toBe("$3.90");
    expect(perGallon(0.25, 3)).toBe("$0.250");
    expect(perGallon(-0.1, 3)).toBe("−$0.100");
    expect(perGallon(null)).toBe("—");
    expect(gallons(null)).toBe("—");
    expect(gallons(1234.56)).toBe("1,234.6");
    expect(gallons(100)).toBe("100");
  });

  it("a trailer length is feet to a tenth, and a dash when not known", () => {
    expect(feet(53)).toBe("53 ft");
    expect(feet(48.5)).toBe("48.5 ft");
    expect(feet(null)).toBe("—");
    expect(feet(Number.NaN)).toBe("—");
    expect(feet(0)).toBe("—");
  });

  it("no screen builds its own dollars with a raw template: they go through desk-format", () => {
    const root = path.join(__dirname, "..", "src");
    const files = [
      "components/desk/verdict-card.tsx", "components/desk/load-view.tsx", "components/desk/load-actions.tsx", "components/desk/partner-actions.tsx",
      "components/desk/live-fuel-price.tsx", "components/desk/statement-fuel.tsx", "app/(desk)/fleet/page.tsx", "app/(desk)/fleet/[id]/page.tsx", "app/(desk)/fuel/page.tsx"
    ];
    for (const f of files) expect(fs.readFileSync(path.join(root, f), "utf8"), f).not.toMatch(/\$\$\{[^}]*toFixed/);
  });
});
