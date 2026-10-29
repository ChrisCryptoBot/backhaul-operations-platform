import { describe, expect, it } from "vitest";
import { BLANK_TRUCK, validateTruck, type TruckValues } from "../src/lib/fleet-forms";
import { pickMake, pickModel, specFill, truckMakes, truckModels, truckYears, withCurrent } from "../src/lib/truck-specs";

const blank = (over: Partial<TruckValues> = {}): TruckValues => ({ ...BLANK_TRUCK, ...over });

describe("the dataset behind the picker", () => {
  it("lists the phone's makes, a make's models and a model's years, newest first", () => {
    expect(truckMakes()).toContain("Ford");
    const models = truckModels("Ford");
    expect(models.length).toBeGreaterThan(3);
    const years = truckYears("Ford", models[0]!);
    expect(years.length).toBeGreaterThan(0);
    expect([...years].sort((a, b) => b - a)).toEqual(years);
    expect(truckModels("Nobody")).toEqual([]);
  });

  it("gives a model's specs as the strings the form shows, with the type as the desk names it", () => {
    const fill = specFill("Mercedes-Benz", "Sprinter 2500 Cargo (High Roof)")!;
    expect(fill).toEqual({ type: "sprinter", mpg: "19", payloadLbs: "2502", maxLengthFt: "11.2", maxWidthFt: "4.7", maxHeightIn: "78" });
  });

  it("a retired medium-duty type reads as a box truck", () => {
    const withMedium = truckMakes()
      .flatMap((make) => truckModels(make).map((model) => ({ make, model })))
      .find(({ make, model }) => specFill(make, model)?.type === "box_truck");
    expect(withMedium).toBeDefined();
  });

  it("has nothing to fill for a custom or unknown vehicle", () => {
    expect(specFill("Other / Custom", "Custom Vehicle")).toBeNull();
    expect(specFill("Ford", "Not a model")).toBeNull();
  });
});

describe("picking a model", () => {
  const make = "Mercedes-Benz";
  const high = "Sprinter 2500 Cargo (High Roof)";
  const long = "Sprinter 3500 Cargo (High Roof)";

  it("a new truck is filled in from its model, and the year waits to be chosen", () => {
    const v = pickModel(pickMake(blank({ name: "Unit 7" }), make), high);
    expect(v).toMatchObject({ name: "Unit 7", make, model: high, year: "", type: "sprinter", mpg: "19", payloadLbs: "2502", maxLengthFt: "11.2", maxWidthFt: "4.7", maxHeightIn: "78" });
    expect(validateTruck({ ...v, year: "2022" }).ok).toBe(true);
  });

  it("choosing another model replaces what the first one filled", () => {
    const first = pickModel(pickMake(blank(), make), high);
    const second = pickModel(first, long);
    expect(second).toMatchObject({ model: long, mpg: "17", payloadLbs: "3307", maxLengthFt: "14.4" });
  });

  it("never overwrites a number someone typed", () => {
    const first = pickModel(pickMake(blank(), make), high);
    const typed = { ...first, mpg: "21.5", payloadLbs: "2400" };
    const second = pickModel(typed, long);
    expect(second.mpg).toBe("21.5");
    expect(second.payloadLbs).toBe("2400");
    expect(second.maxLengthFt).toBe("14.4"); // untouched, so it follows the model
  });

  it("an existing truck keeps its own numbers when a model is first picked for it", () => {
    const old = blank({ name: "Old", mpg: "12.5", type: "box_truck", payloadLbs: "9000" });
    const v = pickModel(pickMake(old, make), high);
    expect(v).toMatchObject({ mpg: "12.5", type: "box_truck", payloadLbs: "9000", maxLengthFt: "11.2" });
  });

  it("changing the make clears the model, the year and what the old model filled", () => {
    const filled = { ...pickModel(pickMake(blank(), make), high), year: "2022" };
    const v = pickMake(filled, "Ford");
    expect(v).toMatchObject({ make: "Ford", model: "", year: "", mpg: "", payloadLbs: "", type: "" });
  });

  it("picking the same make or model again changes nothing", () => {
    const v = { ...pickModel(pickMake(blank(), make), high), year: "2022" };
    expect(pickMake(v, make)).toBe(v);
    expect(pickModel(v, high)).toBe(v);
  });

  it("a custom vehicle fills nothing, so a hand-typed truck stays as typed", () => {
    const v = pickModel(pickMake(blank({ mpg: "9" }), "Other / Custom"), "Custom Vehicle");
    expect(v).toMatchObject({ make: "Other / Custom", model: "Custom Vehicle", mpg: "9", payloadLbs: "" });
  });
});

describe("withCurrent", () => {
  it("keeps a stored value that is not in the list, so editing never blanks it", () => {
    expect(withCurrent(["Ford", "Ram"], "Freightliner")).toEqual(["Freightliner", "Ford", "Ram"]);
    expect(withCurrent(["Ford", "Ram"], "Ford")).toEqual(["Ford", "Ram"]);
    expect(withCurrent(["Ford"], "")).toEqual(["Ford"]);
    expect(withCurrent([2024, 2023], 2019)).toEqual([2019, 2024, 2023]);
  });
});

describe("validateTruck, the spec fields", () => {
  it("checks them and returns them as numbers", () => {
    const out = validateTruck({ name: "U1", make: "Ford", model: "Transit 250", year: "2022", payloadLbs: "3,100", maxLengthFt: "10.1", maxWidthFt: "4.3", maxHeightIn: "56.5" });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.specs).toEqual({ year: 2022, payloadLbs: 3100, maxLengthFt: 10.1, maxWidthFt: 4.3, maxHeightIn: 56.5 });
  });

  it("blank specs are null, not zero", () => {
    const out = validateTruck({ name: "U1" });
    expect(out.ok && out.specs).toEqual({ year: null, payloadLbs: null, maxLengthFt: null, maxWidthFt: null, maxHeightIn: null });
  });

  it("names each one that is wrong", () => {
    const out = validateTruck({ name: "U1", year: "1950", payloadLbs: "12.5", maxLengthFt: "0", maxWidthFt: "30", maxHeightIn: "abc", make: "x".repeat(61) });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["make", "maxHeightIn", "maxLengthFt", "maxWidthFt", "payloadLbs", "year"]);
  });
});
