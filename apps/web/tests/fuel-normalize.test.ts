import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JURISDICTION_CODES, isCounted, isFuelGallons, nextStatus, placeParts, productOf, stateCode, statusOf } from "@/lib/fuel-normalize";

describe("fuel purchases read cleanly (Wave 5 step 1)", () => {
  it("a state is a two-letter code from a code, a name, or either with a postal code; never a guess", () => {
    expect(stateCode("TX")).toBe("TX");
    expect(stateCode(" tx ")).toBe("TX");
    expect(stateCode("Texas")).toBe("TX");
    expect(stateCode("new  mexico")).toBe("NM");
    expect(stateCode("TX 75201")).toBe("TX");
    expect(stateCode("Texas 75201-1234")).toBe("TX");
    expect(stateCode("ON")).toBe("ON");
    expect(stateCode("Ontario M5V 2T6")).toBe("ON");
    expect(stateCode("Washington DC")).toBe("DC");
    for (const bad of ["XX", "T", "Tex", "", "   ", null, undefined, "75201"]) expect(stateCode(bad)).toBeNull();
  });

  it("the city and state come from the end of a place line", () => {
    expect(placeParts("Pilot Flying J, Dallas, TX")).toEqual({ city: "Dallas", state: "TX" });
    expect(placeParts("Amarillo, TX 79101")).toEqual({ city: "Amarillo", state: "TX" });
    expect(placeParts("Love's #512, Little Rock, Arkansas")).toEqual({ city: "Little Rock", state: "AR" });
    expect(placeParts("tx")).toEqual({ city: null, state: "TX" });
    expect(placeParts("Somewhere, XX")).toEqual({ city: null, state: null });
    expect(placeParts(null)).toEqual({ city: null, state: null });
  });

  it("what was pumped: reefer and DEF are never road diesel", () => {
    for (const c of ["DIESEL", "Diesel #2", "ULSD", "tractor diesel", "No. 2", "B20", "DSL"]) expect(productOf(c)).toBe("road_diesel");
    for (const c of ["REEFER_DIESEL", "Reefer", "dyed diesel", "Off-Road Diesel", "red diesel"]) expect(productOf(c)).toBe("reefer_diesel");
    for (const c of ["DEF", "Diesel Exhaust Fluid", "AdBlue"]) expect(productOf(c)).toBe("def");
    for (const c of ["UNLEADED", "Gasoline", "UNL", "Premium", "E85"]) expect(productOf(c)).toBe("gasoline");
    expect(productOf("Snacks")).toBe("other");
    expect(productOf("")).toBe("unknown");
    expect(productOf(null)).toBe("unknown");
    expect(isFuelGallons("def")).toBe(false);
    expect(isFuelGallons("reefer_diesel")).toBe(true);
  });

  it("status: blank is settled, an unknown word is pending, and only settled counts", () => {
    expect(statusOf(undefined)).toBe("settled");
    expect(statusOf("POSTED")).toBe("settled");
    expect(statusOf("PENDING")).toBe("pending");
    expect(statusOf("authorized")).toBe("pending");
    expect(statusOf("DECLINED")).toBe("declined");
    expect(statusOf("REVERSED")).toBe("void");
    expect(statusOf("weird")).toBe("pending");
    expect(["settled", "pending", "declined", "void"].filter(isCounted)).toEqual(["settled"]);
  });

  it("a status moves forward only: pending to anything, settled only to void, declined and void stay", () => {
    expect(nextStatus("pending", "settled")).toBe("settled");
    expect(nextStatus("pending", "declined")).toBe("declined");
    expect(nextStatus("settled", "void")).toBe("void");
    expect(nextStatus("settled", "pending")).toBeNull();
    expect(nextStatus("settled", "declined")).toBeNull();
    expect(nextStatus("declined", "settled")).toBeNull();
    expect(nextStatus("void", "settled")).toBeNull();
    expect(nextStatus("settled", "settled")).toBeNull();
  });

  it("the migration's backfill keeps exactly the codes the parser knows", () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../../prisma/migrations/20261221000000_fuel_purchase_state/migration.sql"), "utf8");
    const list = /r\.st IN \(([^)]*)\)/.exec(sql)![1]!;
    const codes = [...list.matchAll(/'([A-Z]{2})'/g)].map((m) => m[1]).sort();
    expect(codes).toEqual([...JURISDICTION_CODES].sort());
  });
});
