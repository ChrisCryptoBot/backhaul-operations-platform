import { describe, expect, it } from "vitest";
import { FLAG_CODES, fuelFlags, type FlagRow } from "@/lib/fuel-exceptions";

const T0 = Date.parse("2026-11-03T14:00:00Z");
let n = 0;
const R = (over: Partial<FlagRow> = {}): FlagRow => ({
  id: `f${++n}`,
  vehicleId: "t1",
  tankGallons: 200,
  product: "road_diesel",
  status: "settled",
  gallons: 100,
  amount: 365,
  pricePerGallon: 3.9,
  discountPerGallon: 0.25,
  discount: 25,
  at: T0,
  day: "2026-11-03",
  state: "TX",
  ...over
});
const codes = (rows: FlagRow[], id: string) => (fuelFlags(rows).flags.get(id) ?? []).map((f) => f.code);

describe("fuel exception flags (Wave 5 step 3)", () => {
  it("a clean purchase has no flag", () => {
    const a = R();
    expect(codes([a], a.id)).toEqual([]);
  });

  it("over tank size only when the truck has a tank size typed; otherwise it is counted as not checked, never guessed", () => {
    const over = R({ gallons: 215, amount: 784.75 }); // 200 gal tanks, 5% tolerance = 210
    const within = R({ id: "w", gallons: 209, amount: 762.85, at: T0 + 3 * 3_600_000 });
    const noTank = R({ id: "nt", vehicleId: "t2", tankGallons: null, gallons: 500, amount: 1825 });
    const reefer = R({ id: "rf", product: "reefer_diesel", gallons: 260, amount: 949, at: T0 + 6 * 3_600_000 });
    const res = fuelFlags([over, within, noTank, reefer]);
    expect(res.flags.get(over.id)?.map((f) => f.code)).toEqual(["over_capacity"]);
    expect(res.flags.get(over.id)?.[0]?.detail).toBe("215 gal into tanks that hold 200 gal.");
    expect(res.flags.get("w")).toBeUndefined();
    expect(res.flags.get("nt")).toBeUndefined();
    expect(res.flags.get("rf")).toBeUndefined(); // the reefer's own tank, not the tractor's
    expect(res.tankUnknown).toBe(1);
  });

  it("a declined swipe and the settled retry at the same pump are not a duplicate; two settled fills are, both ways", () => {
    const declined = R({ id: "d", status: "declined" });
    const retry = R({ id: "r", at: T0 + 2 * 60_000 });
    expect(codes([declined, retry], "r")).toEqual([]);
    expect(codes([declined, retry], "d")).toEqual([]);
    const voided = R({ id: "v", status: "void" });
    expect(codes([voided, retry], "r")).toEqual([]);

    const twice = R({ id: "t", at: T0 + 12 * 60_000, amount: 365.5 });
    const res = fuelFlags([retry, twice]);
    expect(res.flags.get("r")).toEqual([{ code: "duplicate", detail: "Same truck, gallons and charge as another purchase 10 min apart.", otherId: "t" }]);
    expect(res.flags.get("t")?.[0]).toMatchObject({ code: "duplicate", otherId: "r" });
    // A pending one counts too (seen before it settles).
    expect(codes([retry, R({ id: "p", status: "pending", at: T0 + 5 * 60_000 })], "p")).toEqual(["duplicate"]);
  });

  it("not a duplicate: another truck, another product, other gallons, other charge, or far apart; with no times, the same day is close", () => {
    const a = R({ id: "a" });
    expect(codes([a, R({ vehicleId: "t2" })], "a")).toEqual([]);
    expect(codes([a, R({ product: "reefer_diesel" })], "a")).toEqual([]);
    expect(codes([a, R({ gallons: 101, amount: 368.65 })], "a")).toEqual([]);
    expect(codes([a, R({ amount: 366.5 })], "a")).toEqual([]);
    expect(codes([a, R({ at: T0 + 31 * 60_000 })], "a")).toEqual([]);
    expect(codes([R({ id: "x", at: null }), R({ id: "y", at: null })], "x")).toEqual(["duplicate"]);
    expect(codes([R({ id: "x2", at: null }), R({ id: "y2", at: null, day: "2026-11-04" })], "x2")).toEqual([]);
  });

  it("price: far from the state's middle when it has enough purchases, else the product's; too few, no verdict", () => {
    const base = [0, 1, 2, 3, 4].map((i) => R({ id: `b${i}`, vehicleId: `v${i}`, pricePerGallon: 3.9 + i * 0.01, amount: (3.9 + i * 0.01 - 0.25) * 100, at: T0 + i * 3_600_000 }));
    const high = R({ id: "hi", vehicleId: "vh", pricePerGallon: 4.75, amount: 450 });
    const low = R({ id: "lo", vehicleId: "vl", pricePerGallon: 3.0, amount: 275 });
    const rows = [...base, high, low];
    expect(codes(rows, "hi")).toEqual(["price_high"]);
    expect(fuelFlags(rows).flags.get("hi")?.[0]?.detail).toBe("$4.750 a gallon, 21% above the $3.920 middle for diesel in TX.");
    expect(codes(rows, "lo")).toEqual(["price_low"]);
    expect(codes(rows, "b0")).toEqual([]);
    // Four purchases are not enough for a middle price.
    expect(codes([...base.slice(0, 3), high], "hi")).toEqual([]);
    // A declined swipe's price is not counted and not flagged.
    expect(codes([...base, R({ id: "dh", status: "declined", vehicleId: "vd", pricePerGallon: 9 })], "dh")).toEqual([]);
  });

  it("the charge must add up to (price - discount) x gallons; a discount at or over the price is its own flag", () => {
    expect(codes([R({ id: "c1", amount: 365.9 })], "c1")).toEqual([]); // within $1
    expect(codes([R({ id: "c2", amount: 390 })], "c2")).toEqual(["charge_mismatch"]);
    expect(codes([R({ id: "c3", discountPerGallon: null, discount: 25, amount: 365 })], "c3")).toEqual([]);
    expect(codes([R({ id: "c4", discountPerGallon: 4, discount: 400, amount: 10 })], "c4")).toEqual(["discount_over_price"]);
  });

  it("gasoline or other products on the card, and a purchase with nothing charged, are flagged unless declined or void", () => {
    expect(codes([R({ id: "g", product: "gasoline", tankGallons: null })], "g")).toEqual(["non_diesel"]);
    expect(codes([R({ id: "o", product: "other" })], "o")).toEqual(["non_diesel"]);
    expect(codes([R({ id: "gd", product: "gasoline", status: "declined" })], "gd")).toEqual([]);
    expect(codes([R({ id: "z", amount: 0, pricePerGallon: null })], "z")).toEqual(["zero_amount"]);
  });

  it("no state and no truck are flagged on settled purchases only, and no state only where fuel tax needs one", () => {
    expect(codes([R({ id: "s1", state: null })], "s1")).toEqual(["no_state"]);
    expect(codes([R({ id: "s2", state: null, product: "unknown" })], "s2")).toEqual(["no_state"]);
    expect(codes([R({ id: "s3", state: null, product: "def" })], "s3")).toEqual([]);
    expect(codes([R({ id: "s4", state: null, status: "pending" })], "s4")).toEqual([]);
    expect(codes([R({ id: "s5", state: null, status: "declined" })], "s5")).toEqual([]);
    expect(codes([R({ id: "u1", vehicleId: null, tankGallons: null })], "u1")).toEqual(["no_truck"]);
    expect(codes([R({ id: "u2", vehicleId: null, status: "void" })], "u2")).toEqual([]);
  });

  it("a purchase can carry several flags, each its own, in one fixed order", () => {
    const a = R({ id: "m", vehicleId: null, state: null, gallons: 300, amount: 999 });
    expect(codes([a], "m")).toEqual(["charge_mismatch", "no_state", "no_truck"]);
    expect([...FLAG_CODES]).toHaveLength(10);
  });
});
