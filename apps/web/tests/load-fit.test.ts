import { describe, expect, it } from "vitest";
import { hasAnySpec, NO_SPECS, oversizeWords, truckFit, type LoadSpecs, type TruckLimits } from "../src/lib/load-fit";

const van: TruckLimits = { payloadLbs: 3000, maxLengthFt: 10, maxWidthFt: 5, maxHeightIn: 60, hasLiftgate: false, hasRamp: false, hasPalletJack: false };
const boxTruck: TruckLimits = { payloadLbs: 9000, maxLengthFt: 24, maxWidthFt: 7.5, maxHeightIn: 90, hasLiftgate: true, hasRamp: false, hasPalletJack: true };
const specs = (over: Partial<LoadSpecs> = {}): LoadSpecs => ({ ...NO_SPECS, ...over });

describe("a load with nothing said about it", () => {
  it("fits every truck and says nothing, so a plain quote prices as it always did", () => {
    expect(hasAnySpec(NO_SPECS)).toBe(false);
    expect(truckFit(NO_SPECS, van)).toEqual({ blocker: null, warnings: [] });
  });
});

describe("a load heavier or bigger than the truck is rated for", () => {
  it("blocks the truck and names the limit", () => {
    const fit = truckFit(specs({ weightLbs: 5000 }), van);
    expect(fit.blocker).toContain("5000");
    expect(fit.blocker).toContain("3000");
    expect(fit.blocker).not.toMatch(/vehicle/);
  });
  it("blocks on length, width and height too, and joins what is wrong", () => {
    const fit = truckFit(specs({ lengthFt: 12, widthFt: 6, heightIn: 70 }), van);
    expect(fit.blocker).toMatch(/length/i);
    expect(fit.blocker).toMatch(/width/i);
    expect(fit.blocker).toMatch(/height/i);
  });
  it("passes a truck that holds it", () => {
    expect(truckFit(specs({ weightLbs: 5000, lengthFt: 12, widthFt: 6, heightIn: 70 }), boxTruck).blocker).toBeNull();
  });
  it("does not block on a truck with no limit on file for that measure", () => {
    expect(truckFit(specs({ weightLbs: 90000 }), { ...van, payloadLbs: null }).blocker).toBeNull();
  });
});

describe("what a truck is marked as carrying", () => {
  it("warns, and does not block, when a load needs a liftgate the truck is not marked with", () => {
    const fit = truckFit(specs({ requiresLiftgate: true }), van);
    expect(fit.blocker).toBeNull();
    expect(fit.warnings.join(" ")).toMatch(/liftgate/i);
    expect(fit.warnings.join(" ")).toMatch(/truck/);
  });
  it("is quiet when the truck carries it", () => {
    expect(truckFit(specs({ requiresLiftgate: true, requiresPalletJack: true }), boxTruck).warnings).toEqual([]);
  });
  it("warns about each missing piece of equipment", () => {
    const w = truckFit(specs({ requiresLiftgate: true, requiresRamp: true, requiresPalletJack: true }), van).warnings;
    expect(w).toHaveLength(3);
  });
});

describe("oversize and hazmat", () => {
  it("flags freight past the legal limits as a warning, in words", () => {
    expect(oversizeWords({ lengthFt: null, widthFt: 9, heightIn: 170 })).toBe("wide and tall");
    expect(oversizeWords({ lengthFt: 40, widthFt: 8, heightIn: 100 })).toBeNull();
    const fit = truckFit(specs({ widthFt: 9 }), { ...boxTruck, maxWidthFt: null });
    expect(fit.blocker).toBeNull();
    expect(fit.warnings.join(" ")).toMatch(/Oversize freight \(wide\)/);
  });
  it("notes a hazmat class without stopping the truck", () => {
    const fit = truckFit(specs({ hazmatClass: "3" }), boxTruck);
    expect(fit.blocker).toBeNull();
    expect(fit.warnings.join(" ")).toMatch(/Hazmat class 3/);
  });
});
