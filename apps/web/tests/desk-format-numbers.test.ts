import { describe, expect, it } from "vitest";
import { miles, perMile, usd } from "@/lib/desk-format";

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
});
