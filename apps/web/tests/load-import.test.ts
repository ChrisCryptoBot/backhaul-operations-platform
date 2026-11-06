import { describe, expect, test } from "vitest";
import { parseCsv } from "@/lib/import-csv";
import { autoMap, batchOfChannel, checkLoadRows, cleanMap, emptyMap, importChannel, LOAD_FIELDS, loadImportTemplate, missingFields, paymentOf, placeOf, readDay, type CheckContext, type ColumnMap } from "@/lib/load-import";

const HEADER = ["Load #", "Broker", "Pickup City", "Delivery City", "Pickup Date", "Delivery Date", "Miles", "DH Pickup", "DH Return", "Line Haul", "FSC", "Unit", "Invoice Date", "Invoice Amount", "Paid Date", "Paid Amount"];
const ctx = (over: Partial<CheckContext> = {}): CheckContext => ({ existing: new Map(), trucks: new Set(["unit 104"]), ...over });
const row = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = { "Load #": "1042", Broker: "Acme", "Pickup City": "dallas, tx", "Delivery City": "Atlanta, GA", "Pickup Date": "9/14/2026", "Delivery Date": "2026-09-16", Miles: "781", "DH Pickup": "42", "DH Return": "", "Line Haul": "$2,150.00", FSC: "180", Unit: "Unit 104", "Invoice Date": "", "Invoice Amount": "", "Paid Date": "", "Paid Amount": "", ...over };
  return HEADER.map((h) => base[h] ?? "");
};
const table = (...rows: string[][]) => [HEADER, ...rows];
const mapOf = () => autoMap(HEADER);

describe("matching the file's columns to the desk's fields", () => {
  test("a tracker's own words are matched, each column once", () => {
    const m = autoMap(HEADER);
    expect(m.loadNumber).toBe(0);
    expect(m.customer).toBe(1);
    expect(m.origin).toBe(2);
    expect(m.destination).toBe(3);
    expect(m.pickupDate).toBe(4);
    expect(m.deliveryDate).toBe(5);
    expect(m.loadedMiles).toBe(6);
    expect(m.pickupEmptyMiles).toBe(7);
    expect(m.returnEmptyMiles).toBe(8);
    expect(m.revenue).toBe(9);
    expect(m.fuelSurcharge).toBe(10);
    expect(m.truck).toBe(11);
    expect(m.invoicedDate).toBe(12);
    expect(m.paidAmount).toBe(15);
    const used = Object.values(m).filter((v): v is number => v != null);
    expect(new Set(used).size).toBe(used.length);
  });

  test("the desk's own template matches itself", () => {
    const header = parseCsv(loadImportTemplate())[0]!;
    const m = autoMap(header);
    expect(LOAD_FIELDS.every((f) => m[f.key] != null)).toBe(true);
    expect(missingFields(m)).toEqual([]);
  });

  test("required fields with no column are named", () => {
    const m = autoMap(["Load number", "Customer"]);
    expect(missingFields(m).map((f) => f.key)).toEqual(["origin", "destination", "deliveryDate", "loadedMiles", "revenue"]);
    expect(missingFields(emptyMap()).length).toBe(6);
  });

  test("a hand-edited match is cleaned: out-of-file columns dropped, no column used twice", () => {
    const m = cleanMap({ loadNumber: 0, customer: 0, origin: 99, destination: 2, revenue: -1 }, 4);
    expect(m.loadNumber).toBe(0);
    expect(m.customer).toBeNull(); // column 0 is taken
    expect(m.origin).toBeNull();
    expect(m.destination).toBe(2);
    expect(m.revenue).toBeNull();
  });
});

describe("reading values", () => {
  test("days: ISO, US slashes and dashes; a real calendar day only", () => {
    expect((readDay("2026-09-16") as Date).toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect((readDay("9/16/2026") as Date).toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect((readDay("09-16-2026") as Date).toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect(readDay("")).toBeNull();
    expect(readDay("2026-02-30")).toBe("bad");
    expect(readDay("Sept 16")).toBe("bad");
    expect(readDay("1/1/1850")).toBe("bad");
  });

  test("places: a city and state is spelled the desk's way; anything else is kept as typed", () => {
    expect(placeOf("  dallas,   tx ")).toBe("Dallas, TX");
    expect(placeOf("ST. LOUIS, mo")).toBe("St. Louis, MO");
    expect(placeOf("McKinney, tx")).toBe("McKinney, TX"); // mixed case is left alone
    expect(placeOf("2300 Irving Blvd, Dallas, TX 75207")).toBe("Dallas, TX");
    expect(placeOf("dallas tx")).toBe("Dallas, TX"); // no comma, but the last word is a state
    expect(placeOf("LOS ANGELES CA 90001")).toBe("Los Angeles, CA");
    expect(placeOf("Fort Worth")).toBe("Fort Worth"); // "Worth" is not a state
    expect(placeOf("Salt Lake to Provo")).toBe("Salt Lake to Provo");
    expect(placeOf("Port of Long Beach")).toBe("Port of Long Beach");
  });
});

describe("checking rows", () => {
  test("a good row becomes a finished load with its figures read: dollars, miles, days, the lane spelled the desk's way", () => {
    const c = checkLoadRows(table(row()), mapOf(), ctx());
    expect(c).toMatchObject({ total: 1, problemCount: 0, duplicates: 0 });
    const d = c.good[0]!.item;
    expect(d).toMatchObject({ loadNumber: "1042", customer: "Acme", origin: "Dallas, TX", destination: "Atlanta, GA", loadedMiles: 781, pickupEmptyMiles: 42, returnEmptyMiles: 0, revenue: 2150, fuelSurcharge: 180, truck: "Unit 104" });
    expect(d.completedAt.toISOString()).toBe("2026-09-16T12:00:00.000Z");
    expect(d.pickupAt!.toISOString()).toBe("2026-09-14T12:00:00.000Z");
    expect(c.summary).toMatchObject({ revenue: 2330, miles: 781, withTruck: 1, truckNames: 0, invoiced: 0, paid: 0 });
  });

  test("every mistake is named with its line, the header is line 1, and a blank line is not a row", () => {
    const c = checkLoadRows(table(row(), HEADER.map(() => ""), row({ "Load #": "", Miles: "abc", "Delivery Date": "" }), row({ "Line Haul": "free", "Pickup Date": "9/20/2026", "Load #": "7" }), row({ "Load #": "8", Miles: "99999" })), mapOf(), ctx());
    expect(c.total).toBe(4);
    expect(c.good.map((g) => g.line)).toEqual([2]);
    expect(c.problemCount).toBe(3);
    expect(c.problems[0]).toMatchObject({ line: 4 });
    expect(c.problems[0]!.errors.join(" ")).toMatch(/Load number is empty.*Delivery date is empty.*Loaded miles is not a number/s);
    expect(c.problems[1]!.errors.join(" ")).toMatch(/Pickup date is after the delivery date.*Line haul is not a dollar amount/s);
    expect(c.problems[2]!.errors.join(" ")).toMatch(/Loaded miles must be over 0 and no more than 6,000/);
  });

  test("a delivery in the future is refused: this loads history", () => {
    const next = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    expect(checkLoadRows(table(row({ "Delivery Date": next, "Pickup Date": "" })), mapOf(), ctx()).problems[0]!.errors.join(" ")).toMatch(/in the future/);
  });

  test("money: dollar signs, commas and parentheses read; text and zero are refused", () => {
    const c = checkLoadRows(table(row({ "Line Haul": "$1,234.50" }), row({ "Load #": "2", "Line Haul": "0" }), row({ "Load #": "3", "Line Haul": "(100)" })), mapOf(), ctx());
    expect(c.good).toHaveLength(1);
    expect(c.good[0]!.item.revenue).toBe(1234.5);
    expect(c.problemCount).toBe(2);
  });

  test("duplicates: a load already on the desk (the same number from the same or an unnamed customer) or twice in the file is left out and counted apart from the mistakes", () => {
    const existing = new Map([["1042", new Set(["acme"])], ["2000", new Set([""])], ["3000", new Set(["globex"])]]);
    const c = checkLoadRows(
      table(row(), row({ "Load #": "1042", Broker: "Other Co" }), row({ "Load #": "2000", Broker: "Anyone" }), row({ "Load #": "3000", Broker: "Acme" }), row({ "Load #": "4000" }), row({ "Load #": "4000" }), row({ "Load #": "4000", Broker: "Zeta" }), row({ "Load #": "5000", Broker: "" }), row({ "Load #": "5000", Broker: "Acme" })),
      mapOf(),
      ctx({ existing })
    );
    // 1042/Acme is on the desk; 1042/Other Co is another customer's load; 2000 is held by an unnamed customer so anyone's is the same; 3000/Acme is not Globex's; 4000 twice from Acme is one; 4000/Zeta is another; 5000 with no customer then 5000/Acme is the same.
    expect(c.good.map((g) => `${g.item.loadNumber}/${g.item.customer ?? ""}`)).toEqual(["1042/Other Co", "3000/Acme", "4000/Acme", "4000/Zeta", "5000/"]);
    expect(c.duplicates).toBe(4);
    expect(c.problemCount).toBe(0);
  });

  test("the truck is matched by name; a name the desk does not have is counted, not refused", () => {
    const c = checkLoadRows(table(row(), row({ "Load #": "2", Unit: "Unit 999" }), row({ "Load #": "3", Unit: "" })), mapOf(), ctx());
    expect(c.good).toHaveLength(3);
    expect(c.summary).toMatchObject({ withTruck: 1, truckNames: 1 });
  });

  test("a file that is too big is refused whole", () => {
    const big = Array.from({ length: 21_500 }, (_, i) => row({ "Load #": String(i) }));
    expect(checkLoadRows(table(...big), mapOf(), ctx())).toMatchObject({ tooMany: true, total: 0 });
  });

  test("a match with a missing column reads that field as empty, and the row says so", () => {
    const m: ColumnMap = { ...mapOf(), revenue: null };
    expect(checkLoadRows(table(row()), m, ctx()).problems[0]!.errors).toContain("Line haul is empty.");
  });
});

describe("what an imported load becomes", () => {
  const draft = (over: Partial<Parameters<typeof paymentOf>[0]> = {}) => ({ ...checkLoadRows(table(row()), mapOf(), ctx()).good[0]!.item, ...over });

  test("paid when the file has a paid date; the invoice and the payment fill from the rate when they are blank", () => {
    const d = draft({ paidAt: new Date("2026-10-12T12:00:00Z") });
    expect(paymentOf(d)).toMatchObject({ status: "paid", invoicedAmount: 2330, paidAmount: 2330 });
    expect(paymentOf(d).invoicedAt!.toISOString()).toBe("2026-09-16T12:00:00.000Z"); // the delivery day when the file has no invoice date
  });

  test("invoiced when the file has an invoice date or amount but no payment", () => {
    expect(paymentOf(draft({ invoicedAmount: 2400 }))).toMatchObject({ status: "invoiced", invoicedAmount: 2400, paidAt: null });
    expect(paymentOf(draft({ invoicedAt: new Date("2026-09-20T12:00:00Z") }))).toMatchObject({ status: "invoiced", invoicedAmount: 2330 });
  });

  test("neither when the file says nothing about billing: the desk will list it as ready to invoice", () => {
    expect(paymentOf(draft())).toEqual({ status: null, invoicedAt: null, invoicedAmount: null, paidAt: null, paidAmount: null });
  });

  test("the mark an import leaves on its loads reads back to its batch", () => {
    expect(batchOfChannel(importChannel("abc123"))).toBe("abc123");
    expect(batchOfChannel("rate_con")).toBeNull();
    expect(batchOfChannel(null)).toBeNull();
  });
});
