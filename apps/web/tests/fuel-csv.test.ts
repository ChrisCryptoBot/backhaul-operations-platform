import { describe, expect, it } from "vitest";
import { autoFuelMap, checkFuelRows, cleanFuelMap, fuelImportTemplate, missingFuelFields, type FuelCheckContext } from "@/lib/fuel-csv";
import { parseCsv } from "@/lib/import-csv";

const NOW = Date.parse("2026-11-12T18:00:00Z");
const ctx = (over: Partial<FuelCheckContext> = {}): FuelCheckContext => ({
  truckByName: new Map([["unit 101", "t101"], ["unit 102", "t102"]]),
  truckByCard: new Map([["wex-9", "t102"]]),
  existing: new Set(),
  zone: "America/Chicago",
  nowMs: NOW,
  ...over
});
const run = (csv: string, over: Partial<FuelCheckContext> = {}) => {
  const table = parseCsv(csv);
  return checkFuelRows(table, autoFuelMap(table[0]!), ctx(over));
};

describe("fuel CSV import: reading a file (Wave 5 step 2)", () => {
  it("matches a card company's headers, and names what is still needed", () => {
    const map = autoFuelMap(["Transaction Date", "Unit", "Merchant Name", "Merchant State", "Product Description", "Qty", "PPU", "Net Amount", "Transaction ID"]);
    expect(map).toMatchObject({ date: 0, truck: 1, merchant: 2, state: 3, product: 4, gallons: 5, pricePerGallon: 6, amount: 7, transactionId: 8 });
    expect(missingFuelFields(autoFuelMap(["Unit", "Qty"])).map((m) => m.key)).toEqual(["date", "amount"]);
    // A column picked twice keeps the first field only.
    expect(cleanFuelMap({ date: 0, amount: 0, gallons: 9 }, 3)).toMatchObject({ date: 0, amount: null, gallons: null });
    // The template's own header reads back with nothing missing.
    expect(missingFuelFields(autoFuelMap(parseCsv(fuelImportTemplate())[0]!))).toEqual([]);
  });

  it("normalizes state, product, status and tax exactly as a card company's purchases are", () => {
    const c = run(
      [
        "Date,Time,Truck,Where,State,Product,Gallons,Price,Discount per gallon,Charged,Status,Bulk",
        "2026-11-03,2:05 PM,Unit 101,Pilot Flying J,Texas,ULSD,100,3.90,0.25,365.00,POSTED,",
        "2026-11-03,,unit 101,\"Love's, Little Rock, AR\",,Reefer,30,3.90,0.25,109.50,,",
        "2026-11-04,,Unit 102,Yard tank,OK,Diesel,80,3.10,,248.00,,yes",
        "2026-11-05,,Unit 101,Pilot,TX,DEF,5,4.00,,20.00,PENDING,",
        "2026-11-05,,Unit 101,Pilot,TX,Diesel,90,3.90,,351.00,Declined,"
      ].join("\n")
    );
    expect(c.problemCount).toBe(0);
    const [a, b, bulk, def, dec] = c.good.map((g) => g.item);
    expect(a).toMatchObject({ state: "TX", product: "road_diesel", status: "settled", taxPaid: true, truckId: "t101", gallons: 100, discount: 25, amount: 365, location: "Pilot Flying J, TX" });
    expect(a!.purchasedAt!.toISOString()).toBe("2026-11-03T20:05:00.000Z"); // 2:05 PM Central
    expect(b).toMatchObject({ state: "AR", city: "Little Rock", product: "reefer_diesel", location: "Love's, Little Rock, AR", purchasedAt: null });
    expect(bulk).toMatchObject({ taxPaid: false, product: "road_diesel", truckId: "t102" });
    expect(def).toMatchObject({ product: "def", status: "pending" });
    expect(dec).toMatchObject({ status: "declined" });
    // Only settled purchases are in the summary's totals; gallons are kept by product.
    expect(c.summary).toMatchObject({ purchases: 3, notCounted: 2, charged: 722.5, states: 3, first: "2026-11-03", last: "2026-11-05" });
    expect(c.summary.gallons).toEqual({ road_diesel: 180, reefer_diesel: 30 });
  });

  it("finds the truck by its card account when the file has no truck, and counts what it could not tie", () => {
    const c = run(["Date,Card,Unit,State,Product,Charged", "2026-11-03,WEX-9,,TX,Diesel,100", "2026-11-03,NOPE,Unit 999,,,50"].join("\n"));
    expect(c.good[0]!.item.truckId).toBe("t102");
    expect(c.good[1]!.item).toMatchObject({ truckId: null, state: null, product: "unknown" });
    expect(c.warnings).toEqual({ noTruck: 1, noState: 1, noProduct: 1 });
  });

  it("a purchase is kept once: by the file's transaction id, else by the row itself; earlier imports are named so a moved status can be taken", () => {
    const csv = ["Transaction ID,Date,Truck,State,Product,Gallons,Charged,Status", "T-1,2026-11-03,Unit 101,TX,Diesel,100,365,Pending", "T-1,2026-11-03,Unit 101,TX,Diesel,100,365,Posted", "T-2,2026-11-03,Unit 101,TX,Diesel,50,180,"].join("\n");
    const first = run(csv);
    expect(first.good.map((g) => g.item.externalId)).toEqual(["txn:T-1", "txn:T-2"]);
    expect(first.duplicates).toBe(1);
    const again = run(csv, { existing: new Set(["txn:T-1"]) });
    expect(again.good.map((g) => g.item.externalId)).toEqual(["txn:T-2"]);
    expect(again.again).toEqual([{ externalId: "txn:T-1", status: "pending" }]);

    const noId = ["Date,Truck,State,Product,Gallons,Charged", "2026-11-03,Unit 101,TX,Diesel,100,365", "2026-11-03,UNIT 101,tx,diesel,100.000,365.00", "2026-11-03,Unit 101,TX,Diesel,100,366"].join("\n");
    const rows = run(noId);
    expect(rows.good).toHaveLength(2); // the second line is the first one again, written differently
    expect(rows.duplicates).toBe(1);
    expect(rows.good[0]!.item.externalId).toBe("row:unit 101|2026-11-03||100.000|365.00|TX|road_diesel");
  });

  it("leaves out a row it cannot read, saying why, and reads the rest", () => {
    const c = run(
      [
        "Date,Truck,Gallons,Charged,Tax paid",
        ",Unit 101,10,10",
        "13/45/2026,Unit 101,10,10",
        "2026-11-03,Unit 101,ten,10",
        "2026-11-03,Unit 101,10,-10",
        "2026-11-03,Unit 101,99999,10",
        "2030-01-01,Unit 101,10,10",
        "2026-11-03,Unit 101,10,",
        "2026-11-03,Unit 101,10,10,maybe",
        "11/3/2026,Unit 101,10,10"
      ].join("\n")
    );
    expect(c.problems.map((p) => [p.line, p.errors[0]])).toEqual([
      [2, "Date is empty."],
      [3, "Date is not a date (use 2026-11-03 or 11/3/2026)."],
      [4, "Gallons is not a number."],
      [5, "Charged is negative. A reversed purchase is its own row with the status Reversed, not a negative one."],
      [6, "Gallons is more than 2,000, which is a typo, not a purchase."],
      [7, "Date is in the future."],
      [8, "Charged is empty."],
      [9, "Tax paid is not yes or no."]
    ]);
    expect(c.good.map((g) => g.item.on)).toEqual(["2026-11-03"]);
  });

  it("a date with its time in one cell is read on the fleet's clock, or as given with an offset", () => {
    const c = run(["Date,Truck,Charged", "2026-11-03 06:30,Unit 101,10", "\"11/4/2026, 7:15 PM\",Unit 101,11", "2026-11-05T10:00:00Z,Unit 101,12"].join("\n"));
    expect(c.problemCount).toBe(0);
    expect(c.good.map((g) => [g.item.on, g.item.purchasedAt?.toISOString()])).toEqual([
      ["2026-11-03", "2026-11-03T12:30:00.000Z"],
      ["2026-11-04", "2026-11-05T01:15:00.000Z"],
      ["2026-11-05", "2026-11-05T10:00:00.000Z"]
    ]);
  });
});
