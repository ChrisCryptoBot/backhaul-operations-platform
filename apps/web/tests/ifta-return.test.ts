import { describe, expect, test } from "vitest";
import { IFTA_ROUNDING, iftaReturnMath, roundGallons, roundMoney, roundMpg, type ReturnFuel, type ReturnMiles, type ReturnRate } from "@/lib/ifta-return";

/**
 * Wave 5 step 6: a quarter's return worked by hand, then by the code.
 *
 * Miles (each truck's counted rows):
 *   T1: TX 1000, OK 500, AR 300          T2: TX 800, KY 600, IN 400          T3: TX 500, AR 100, KY 300
 *   By state: TX 2300, OK 500, AR 400, KY 900, IN 400. Total 4500.
 * Settled road diesel:
 *   T1 TX 300.4 tax paid · T2 IN 250 tax paid · T2 KY 50.5 tax paid · T3 TX 101 BULK (no tax paid) · T3 MO 20 tax paid (no miles in MO)
 *   All of it into the tanks: 721.9 gallons.  Fleet MPG = 4500 / 721.9 = 6.23355... → 6.23
 * Not counted: reefer 40 (TX), DEF 10 (TX), pending road diesel 80 (TX), declined road diesel 60 (OK), Canadian fill 30 (ON, counted aside).
 *
 *   state  miles  taxable = miles/6.23   paid   net    rate    tax                 surcharge
 *   AR      400   64.205 → 64              0     64   .2850    18.24                0
 *   IN      400   64.205 → 64            250   -186   .5500  -102.30 (credit)       0
 *   KY      900  144.462 → 144          50.5→51  93   .2460    22.878 → 22.88    144 × .1020 = 14.688 → 14.69
 *   MO        0     0                     20    -20   .1950    -3.90 (credit)       0
 *   OK      500   80.257 → 80              0     80   .1900    15.20                0
 *   TX     2300  369.181 → 369          300.4→300 69  .2000    13.80                0
 *   Tax -36.08, surcharge 14.69, total -21.39 (a credit).
 */
const miles: ReturnMiles[] = [
  { vehicleId: "T1", jurisdiction: "TX", miles: "1000.0" },
  { vehicleId: "T1", jurisdiction: "OK", miles: "500.0" },
  { vehicleId: "T1", jurisdiction: "AR", miles: "300.0" },
  { vehicleId: "T2", jurisdiction: "TX", miles: "800.0" },
  { vehicleId: "T2", jurisdiction: "KY", miles: "600.0" },
  { vehicleId: "T2", jurisdiction: "IN", miles: "400.0" },
  { vehicleId: "T3", jurisdiction: "TX", miles: "500.0" },
  { vehicleId: "T3", jurisdiction: "AR", miles: "100.0" },
  { vehicleId: "T3", jurisdiction: "KY", miles: "300.0" }
];
const f = (id: string, vehicleId: string | null, state: string | null, gallons: string | null, over: Partial<ReturnFuel> = {}): ReturnFuel => ({ id, vehicleId, state, product: "road_diesel", status: "settled", taxPaid: true, gallons, ...over });
const fuel: ReturnFuel[] = [
  f("p1", "T1", "TX", "300.4"),
  f("p2", "T2", "IN", "250"),
  f("p3", "T2", "KY", "50.5"),
  f("p4", "T3", "TX", "101", { taxPaid: false }),
  f("p5", "T3", "MO", "20"),
  f("x1", "T1", "TX", "40", { product: "reefer_diesel" }),
  f("x2", "T1", "TX", "10", { product: "def" }),
  f("x3", "T2", "TX", "80", { status: "pending" }),
  f("x4", "T2", "OK", "60", { status: "declined" }),
  f("x5", "T1", "ON", "30")
];
const rate = (jurisdiction: string, r: string, surcharge = "0", isSample = false): ReturnRate => ({ jurisdiction, rate: r, surcharge, isSample });
const rates: ReturnRate[] = [rate("TX", "0.2000"), rate("OK", "0.1900"), rate("AR", "0.2850"), rate("KY", "0.2460", "0.1020"), rate("IN", "0.5500"), rate("MO", "0.1950")];
const trucks = [
  { vehicleId: "T1", name: "Unit 1", method: "eld", source: "motive" },
  { vehicleId: "T2", name: "Unit 2", method: "routed", source: "promiles" },
  { vehicleId: "T3", name: "Unit 3", method: "eld", source: "motive" }
];
const noFlags = { count: 0, ids: [] };

describe("the IFTA return, worked by hand", () => {
  test("fleet MPG from all road diesel, taxable and net gallons whole, tax and surcharge to the cent per state, then summed", () => {
    const r = iftaReturnMath({ miles, fuel, rates, trucks, openFlags: noFlags });
    expect(r).toMatchObject({ miles: "4500.0", gallons: "721.900", taxPaidGallons: "620.900", bulkGallons: "101.000", mpg: "6.23" });
    expect(r.lines.map((l) => [l.jurisdiction, l.miles, l.taxableGallons, l.taxPaidGallons, l.netGallons, l.rate, l.surchargeRate, l.tax, l.surcharge, l.total])).toEqual([
      ["AR", "400.0", "64", "0", "64", "0.2850", "0.0000", "18.24", "0.00", "18.24"],
      ["IN", "400.0", "64", "250", "-186", "0.5500", "0.0000", "-102.30", "0.00", "-102.30"],
      ["KY", "900.0", "144", "51", "93", "0.2460", "0.1020", "22.88", "14.69", "37.57"],
      ["MO", "0.0", "0", "20", "-20", "0.1950", "0.0000", "-3.90", "0.00", "-3.90"],
      ["OK", "500.0", "80", "0", "80", "0.1900", "0.0000", "15.20", "0.00", "15.20"],
      ["TX", "2300.0", "369", "300", "69", "0.2000", "0.0000", "13.80", "0.00", "13.80"]
    ]);
    expect(r).toMatchObject({ tax: "-36.08", surcharge: "14.69", total: "-21.39" });
    expect(r.blockers).toEqual([]);
    // Reefer, DEF and the Canadian fill are settled but not counted; pending and declined are not settled.
    expect(r.notes).toEqual({ canadaGallons: "30.000", notFuel: 2, notSettled: 2 });
  });

  test("each truck's audit detail adds up to the fleet", () => {
    const r = iftaReturnMath({ miles, fuel, rates, trucks, openFlags: noFlags });
    expect(r.trucks.map((t) => [t.name, t.method, t.miles, t.gallons, t.bulkGallons, t.mpg, t.purchases])).toEqual([
      ["Unit 1", "eld", "1800.0", "300.400", "0.000", "5.99", 1],
      ["Unit 2", "routed", "1800.0", "300.500", "0.000", "5.99", 2],
      ["Unit 3", "eld", "900.0", "121.000", "101.000", "7.44", 2]
    ]);
    expect(r.trucks[2]!.taxPaidByState).toEqual([{ jurisdiction: "MO", gallons: "20.000" }]);
    expect(r.trucks.reduce((s, t) => s + Number(t.miles), 0)).toBe(4500);
    expect(r.trucks.reduce((s, t) => s + Number(t.gallons) * 1000, 0)).toBe(721_900);
  });

  test("blockers: a missing rate (the tax-paid state with no miles too), sample rates, open flags, fuel with no state, no truck or no product", () => {
    const r = iftaReturnMath({
      miles,
      fuel: [...fuel, f("n1", "T1", null, "12"), f("n2", null, "TX", "15"), f("n3", "T2", "TX", "9", { product: "unknown" })],
      rates: rates.filter((x) => x.jurisdiction !== "MO").map((x) => (x.jurisdiction === "OK" ? { ...x, isSample: true } : x)),
      trucks,
      openFlags: { count: 1, ids: ["p1"] }
    });
    expect(r.blockers.map((b) => [b.code, b.count, b.items])).toEqual([
      ["missing_rate", 1, ["MO"]],
      ["open_flags", 1, ["p1"]],
      ["fuel_no_state", 1, ["n1"]],
      ["fuel_no_truck", 1, ["n2"]],
      ["fuel_unknown_product", 1, ["n3"]],
      ["sample_rates", 1, ["OK"]]
    ]);
    // A missing rate leaves that line and the totals blank, never a guessed number.
    expect(r.lines.find((l) => l.jurisdiction === "MO")).toMatchObject({ rate: null, tax: null, total: null });
    expect(r).toMatchObject({ tax: null, surcharge: null, total: null });
    // The fills with no state or no truck are still road diesel in the tanks: in the MPG, not credited where no state is known.
    expect(r.gallons).toBe("748.900");
  });

  test("miles but no road diesel: no MPG, no taxable gallons, a blocker, and nothing divided by zero", () => {
    const r = iftaReturnMath({ miles, fuel: fuel.filter((x) => x.product !== "road_diesel" || x.status !== "settled"), rates, trucks, openFlags: noFlags });
    expect(r.mpg).toBeNull();
    expect(r.lines.every((l) => l.taxableGallons === null && l.tax === null)).toBe(true);
    expect(r.total).toBeNull();
    expect(r.blockers.map((b) => b.code)).toEqual(["no_fuel"]);
  });

  test("fuel but no miles: the credits stand, and it is blocked", () => {
    const r = iftaReturnMath({ miles: [], fuel, rates, trucks, openFlags: noFlags });
    expect(r.mpg).toBeNull();
    expect(r.lines.map((l) => [l.jurisdiction, l.taxableGallons, l.netGallons])).toEqual([
      ["IN", "0", "-250"],
      ["KY", "0", "-51"],
      ["MO", "0", "-20"],
      ["TX", "0", "-300"]
    ]);
    expect(r.blockers.map((b) => b.code)).toEqual(["no_miles"]);
  });

  test("the rounding is one rule: half up, MPG to 2 places, gallons whole, money to the cent", () => {
    expect(IFTA_ROUNDING).toMatchObject({ mpgPlaces: 2, gallonPlaces: 0, moneyPlaces: 2 });
    expect(roundMpg("6.235").toFixed(2)).toBe("6.24");
    expect(roundGallons("50.5").toFixed(0)).toBe("51");
    expect(roundGallons("-185.5").toFixed(0)).toBe("-186");
    expect(roundMoney("22.875").toFixed(2)).toBe("22.88");
    // No float drift: 0.1 + 0.2 stays 0.3.
    expect(iftaReturnMath({ miles: [{ vehicleId: "T", jurisdiction: "TX", miles: "0.1" }, { vehicleId: "T", jurisdiction: "TX", miles: "0.2" }], fuel: [], rates, trucks: [], openFlags: noFlags }).miles).toBe("0.3");
  });
});
