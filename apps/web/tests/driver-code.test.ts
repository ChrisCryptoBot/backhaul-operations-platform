import { describe, expect, it } from "vitest";
import { cleanDriverCode, driverCodeBase, nextDriverCode } from "@/lib/driver-code";

describe("driver codes: first initial and the first three letters of the last name", () => {
  it("is the plain rule for an ordinary name", () => {
    expect(driverCodeBase("John Smith")).toBe("JSMI");
    expect(driverCodeBase("casey brooks")).toBe("CBRO");
  });

  it("reads the last word as the last name, skipping suffixes, and the first word as the first name", () => {
    expect(driverCodeBase("Mary Ann Johnson")).toBe("MJOH");
    expect(driverCodeBase("Robert Downey Jr.")).toBe("RDOW");
    expect(driverCodeBase("Luis Garcia III")).toBe("LGAR");
  });

  it("drops accents and punctuation, and uses what a short last name has", () => {
    expect(driverCodeBase("Pat O'Neil")).toBe("PONE");
    expect(driverCodeBase("Zoë Núñez")).toBe("ZNUN");
    expect(driverCodeBase("Jo Li")).toBe("JLI");
    expect(driverCodeBase("Ann-Marie Lee-Jones")).toBe("ALEE");
  });

  it("copes with one word and with nothing", () => {
    expect(driverCodeBase("Cher")).toBe("CHER");
    expect(driverCodeBase("  ")).toBe("");
    expect(driverCodeBase("123 ---")).toBe("");
  });

  it("the first holder keeps the plain code and the next ones take a number", () => {
    const taken = new Set<string>();
    const a = nextDriverCode("John Smith", taken);
    taken.add(a);
    const b = nextDriverCode("Jane Smithers", taken);
    taken.add(b);
    const c = nextDriverCode("Jim Smith", taken);
    expect([a, b, c]).toEqual(["JSMI", "JSMI2", "JSMI3"]);
  });

  it("a name with no letters still gets a usable code", () => {
    expect(nextDriverCode("", new Set())).toBe("DRV");
    expect(nextDriverCode("", new Set(["DRV"]))).toBe("DRV2");
  });

  it("a typed code is capitals and digits only, up to eight", () => {
    expect(cleanDriverCode(" j-smi 2 ")).toBe("JSMI2");
    expect(cleanDriverCode("abcdefghijkl")).toBe("ABCDEFGH");
    expect(cleanDriverCode("--")).toBe("");
  });
});
