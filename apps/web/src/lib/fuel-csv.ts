import { toCsv } from "./csv";
import { placeParts, productOf, stateCode, statusOf, type FuelProduct, type FuelStatus } from "./fuel-normalize";
import { IMPORT_MAX_PROBLEMS, IMPORT_MAX_ROWS, type ProblemRow } from "./import-csv";
import { matchHeader, readDateTime, readDay, readMoney, readWhole } from "./load-import";

/**
 * Loading fuel purchases from a CSV file, for a fleet or a card with no API the desk reads (Wave 5 step 2). A card company's transaction export, or a fleet's own fuel log: one row per purchase.
 * Every row is read with the same rules as a card company's purchases (lib/fuel-normalize.ts): the state, what was pumped and where it stands come out identically, so fuel-tax totals do not
 * depend on how a purchase arrived. Pure: the server reads and writes the database (server/partners/fuel-import.ts); this decides what a file means.
 *
 * A purchase is kept once. Its key is the file's own transaction id when the file has one, else a key made from the row itself (truck or card, day, time, gallons, amount, state, product):
 * the same row twice in a file, or in a file loaded again, is a duplicate and is left out.
 */
export type FuelFieldKey =
  | "date"
  | "time"
  | "truck"
  | "card"
  | "transactionId"
  | "merchant"
  | "city"
  | "state"
  | "product"
  | "gallons"
  | "pricePerGallon"
  | "discountPerGallon"
  | "discount"
  | "amount"
  | "status"
  | "taxPaid"
  | "taxFree";

export type FuelField = { key: FuelFieldKey; label: string; required: boolean; aliases: string[]; example: string; hint?: string };

export const FUEL_FIELDS: readonly FuelField[] = [
  { key: "date", label: "Date", required: true, aliases: ["date", "transactiondate", "trandate", "transdate", "purchasedate", "posted", "posteddate", "postdate", "datetime", "transactiondatetime"], example: "2026-11-03", hint: "The day of the purchase. A date with a time (2026-11-03 14:05) is read on the fleet's clock." },
  { key: "time", label: "Time", required: false, aliases: ["time", "transactiontime", "trantime", "purchasetime"], example: "14:05" },
  { key: "truck", label: "Truck", required: false, aliases: ["truck", "unit", "unitnumber", "unitno", "vehicle", "vehicleid", "tractor", "truckid", "trucknumber", "equipment"], example: "Unit 101", hint: "The truck's name on the desk. Or give the card account below, and the truck with that card is used." },
  { key: "card", label: "Card account", required: false, aliases: ["card", "cardaccount", "account", "accountnumber", "cardid", "fuelcard"], example: "WEX-9", hint: "Matched against the card account set on each truck's page. It is read to find the truck and is not kept." },
  { key: "transactionId", label: "Transaction id", required: false, aliases: ["transactionid", "transaction", "txnid", "txn", "transno", "tranno", "trannumber", "transactionnumber", "ticket", "ticketnumber", "receipt", "receiptnumber", "reference", "referencenumber", "invoice", "invoicenumber"], example: "T-884213", hint: "The card company's own id for the purchase. With it, the same purchase in two files is kept once." },
  { key: "merchant", label: "Where", required: false, aliases: ["merchant", "merchantname", "location", "truckstop", "site", "sitename", "station", "vendor", "stop", "place"], example: "Pilot Flying J, Dallas, TX", hint: "The merchant. If it ends with the city and state, those are read from it when there is no State column." },
  { key: "city", label: "City", required: false, aliases: ["city", "merchantcity", "sitecity", "locationcity"], example: "Dallas" },
  { key: "state", label: "State", required: false, aliases: ["state", "st", "merchantstate", "sitestate", "locationstate", "jurisdiction", "province", "stateprovince"], example: "TX", hint: "Where it was bought: fuel tax credits the gallons to this state. A code (TX) or a name (Texas)." },
  { key: "product", label: "Product", required: false, aliases: ["product", "productcode", "producttype", "productdescription", "item", "itemdescription", "fueltype", "fuel", "description", "category"], example: "Diesel", hint: "Diesel, reefer (or dyed), DEF, gasoline. Reefer fuel and DEF are kept apart from the tractor's road diesel." },
  { key: "gallons", label: "Gallons", required: false, aliases: ["gallons", "gal", "qty", "quantity", "units", "volume", "gallonspurchased"], example: "112.4" },
  { key: "pricePerGallon", label: "Price a gallon", required: false, aliases: ["pricepergallon", "ppg", "ppu", "price", "priceperunit", "unitprice", "retailprice", "pumpprice", "retailppu"], example: "3.899", hint: "The posted price, before the card's discount." },
  { key: "discountPerGallon", label: "Discount a gallon", required: false, aliases: ["discountpergallon", "discountperunit", "discountppu", "ppudiscount", "rebatepergallon", "savingspergallon"], example: "0.25" },
  { key: "discount", label: "Discount", required: false, aliases: ["discount", "discountamount", "totaldiscount", "savings", "rebate", "rebateamount"], example: "28.10", hint: "In dollars. Worked out from the discount a gallon when the file has only that." },
  { key: "amount", label: "Charged", required: true, aliases: ["charged", "amount", "total", "totalamount", "net", "netamount", "amountcharged", "netcost", "totalcost", "invoiceamount", "billedamount"], example: "410.15", hint: "What the card was charged, after the discount." },
  { key: "status", label: "Status", required: false, aliases: ["status", "transactionstatus", "posting", "postingstatus"], example: "Posted", hint: "Posted or settled counts; pending, declined or reversed is kept but not counted. Blank is settled." },
  { key: "taxPaid", label: "Tax paid", required: false, aliases: ["taxpaid", "taxpaidflag", "taxincluded", "fueltaxpaid"], example: "yes", hint: "Yes when fuel tax was paid at the pump (every retail purchase). Blank is yes." },
  { key: "taxFree", label: "Tax-free or bulk", required: false, aliases: ["taxfree", "taxexempt", "exempt", "bulk", "bulkfuel", "untaxed", "nontaxed"], example: "", hint: "Yes for fuel from the fleet's own tank or bought tax-free: it counts toward miles to the gallon but earns no tax-paid credit." }
];

export const FUEL_FIELD_OF: Readonly<Record<FuelFieldKey, FuelField>> = Object.fromEntries(FUEL_FIELDS.map((f) => [f.key, f])) as Record<FuelFieldKey, FuelField>;

export type FuelMap = Record<FuelFieldKey, number | null>;
export const emptyFuelMap = (): FuelMap => Object.fromEntries(FUEL_FIELDS.map((f) => [f.key, null])) as FuelMap;
export const autoFuelMap = (header: readonly string[]): FuelMap => matchHeader(header, FUEL_FIELDS);

/** A map that is safe to use against this header: indexes inside the file, no column used twice (the later field loses it). */
export function cleanFuelMap(map: Partial<Record<FuelFieldKey, number | null>>, width: number): FuelMap {
  const out = emptyFuelMap();
  const used = new Set<number>();
  for (const f of FUEL_FIELDS) {
    const v = map[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < width && !used.has(v)) {
      out[f.key] = v;
      used.add(v);
    }
  }
  return out;
}

export const missingFuelFields = (map: FuelMap): Array<{ key: FuelFieldKey; label: string }> => FUEL_FIELDS.filter((f) => f.required && map[f.key] == null).map((f) => ({ key: f.key, label: f.label }));

export function fuelImportTemplate(): string {
  const cols = FUEL_FIELDS.filter((f) => f.key !== "city" && f.key !== "taxFree");
  return toCsv(
    cols.map((f) => f.label),
    [cols.map((f) => f.example)]
  );
}

// ── Reading a row ────────────────────────────────────────────────────────────────────────────────

/** Past these a cell is a typo, not a purchase at a pump. */
export const MAX_FUEL_GALLONS = 2_000;
export const MAX_FUEL_DOLLARS = 20_000;
export const MAX_FUEL_PRICE = 25;

export type FuelDraft = {
  /** The key the purchase is kept by: "txn:<id>" from the file's transaction id, else "row:<...>". */
  externalId: string;
  /** The calendar day (YYYY-MM-DD) and, when the file gives a time, the moment. */
  on: string;
  purchasedAt: Date | null;
  truckId: string | null;
  location: string | null;
  state: string | null;
  city: string | null;
  product: FuelProduct;
  status: FuelStatus;
  taxPaid: boolean;
  gallons: number | null;
  pricePerGallon: number | null;
  discountPerGallon: number | null;
  discount: number | null;
  amount: number;
};

export type FuelCheckContext = {
  /** Desk trucks by lower-case name, and by lower-case card account set on the truck's page. */
  truckByName: ReadonlyMap<string, string>;
  truckByCard: ReadonlyMap<string, string>;
  /** Keys already kept from earlier files (provider "csv"). */
  existing: ReadonlySet<string>;
  /** The fleet's time zone, for a date with a time and no offset. */
  zone: string;
  nowMs: number;
};

export type FuelCheck = {
  total: number;
  good: Array<{ line: number; item: FuelDraft }>;
  problems: ProblemRow[];
  problemCount: number;
  /** Already imported, or twice in this file: left out, counted apart from the mistakes. Each `existing` one is listed so a status the source has moved can be taken. */
  duplicates: number;
  again: Array<{ externalId: string; status: FuelStatus }>;
  tooMany: boolean;
  /** Kept, but worth a look: no truck found, no state read, product not said. Step 3's flags pick these up. */
  warnings: { noTruck: number; noState: number; noProduct: number };
  summary: { purchases: number; gallons: Partial<Record<FuelProduct, number>>; charged: number; notCounted: number; states: number; first: string | null; last: string | null };
};

const cell = (row: string[], at: number | null) => (at == null ? "" : (row[at] ?? "").trim());
const YES = /^(y|yes|true|t|1|x)$/i;
const NO = /^(n|no|false|f|0)$/i;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const squash = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
/** Whole cents, so a key made from a row never differs by a float's last digit. */
const keyNum = (n: number | null, places: number) => (n == null ? "" : (Math.round(n * 10 ** places) / 10 ** places).toFixed(places));

function readTime(raw: string): string | null | "bad" {
  if (raw === "") return null;
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(raw);
  if (!m) return "bad";
  let h = Number(m[1]);
  const mi = Number(m[2]);
  const ap = m[4]?.toUpperCase();
  if (ap) {
    if (h < 1 || h > 12) return "bad";
    h = (h % 12) + (ap === "PM" ? 12 : 0);
  }
  if (h > 23 || mi > 59) return "bad";
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function checkFuelRows(table: string[][], map: FuelMap, ctx: FuelCheckContext): FuelCheck {
  const body = table.slice(1);
  const out: FuelCheck = {
    total: 0,
    good: [],
    problems: [],
    problemCount: 0,
    duplicates: 0,
    again: [],
    tooMany: body.length > IMPORT_MAX_ROWS + 1000,
    warnings: { noTruck: 0, noState: 0, noProduct: 0 },
    summary: { purchases: 0, gallons: {}, charged: 0, notCounted: 0, states: 0, first: null, last: null }
  };
  if (out.tooMany) return out;
  const seen = new Set<string>();
  const states = new Set<string>();
  let chargedCents = 0;
  const gallonsMilli: Partial<Record<FuelProduct, number>> = {};

  body.forEach((row, i) => {
    if (row.every((c) => c.trim() === "")) return;
    out.total += 1;
    const line = i + 2;
    const errors: string[] = [];
    const fail = (m: string) => errors.push(m);
    const get = (k: FuelFieldKey) => cell(row, map[k]);

    // The day, and the moment when there is one: a time in the date cell or in its own column, on the fleet's clock.
    let on: string | null = null;
    let purchasedAt: Date | null = null;
    const rawDate = get("date");
    const time = readTime(get("time"));
    if (time === "bad") fail("Time is not a time (use 14:05 or 2:05 PM).");
    if (rawDate === "") fail("Date is empty.");
    else {
      const withTime = readDateTime(rawDate, ctx.zone);
      if (withTime instanceof Date) {
        purchasedAt = withTime;
        const day = readDay(rawDate.split(/[T ,]/)[0]!);
        if (day instanceof Date) on = ymd(day);
        else fail("Date is not a date (use 2026-11-03 or 11/3/2026).");
      } else {
        const day = readDay(rawDate);
        if (day === "bad" || day === null) fail("Date is not a date (use 2026-11-03 or 11/3/2026).");
        else {
          on = ymd(day);
          if (typeof time === "string") {
            const at = readDateTime(`${on} ${time}`, ctx.zone);
            if (at instanceof Date) purchasedAt = at;
          }
        }
      }
      if (on && Date.parse(`${on}T00:00:00Z`) > ctx.nowMs + 86_400_000) fail("Date is in the future.");
    }

    const num = (k: FuelFieldKey, label: string, max: number, places: number): number | null => {
      const raw = get(k);
      const v = k === "gallons" ? readWhole(raw) : readMoney(raw);
      if (v === null) return null;
      if (v === "bad") {
        fail(`${label} is not a number.`);
        return null;
      }
      if (v < 0) {
        fail(`${label} is negative. A reversed purchase is its own row with the status Reversed, not a negative one.`);
        return null;
      }
      if (v > max) {
        fail(`${label} is more than ${max.toLocaleString("en-US")}, which is a typo, not a purchase.`);
        return null;
      }
      return Math.round(v * 10 ** places) / 10 ** places;
    };
    const amount = num("amount", "Charged", MAX_FUEL_DOLLARS, 2);
    if (get("amount") === "") fail("Charged is empty.");
    const gallons = num("gallons", "Gallons", MAX_FUEL_GALLONS, 3);
    const pricePerGallon = num("pricePerGallon", "Price a gallon", MAX_FUEL_PRICE, 4);
    const discountPerGallon = num("discountPerGallon", "Discount a gallon", MAX_FUEL_PRICE, 4);
    let discount = num("discount", "Discount", MAX_FUEL_DOLLARS, 2);
    if (discount == null && discountPerGallon != null && gallons != null) discount = Math.round(discountPerGallon * gallons * 100) / 100;

    // Tax paid unless the file says otherwise, by either column.
    let taxPaid = true;
    const paid = get("taxPaid");
    const free = get("taxFree");
    if (paid !== "") {
      if (NO.test(paid)) taxPaid = false;
      else if (!YES.test(paid)) fail("Tax paid is not yes or no.");
    }
    if (free !== "") {
      if (YES.test(free)) taxPaid = false;
      else if (!NO.test(free)) fail("Tax-free is not yes or no.");
    }

    if (errors.length > 0) {
      out.problemCount += 1;
      if (out.problems.length < IMPORT_MAX_PROBLEMS) out.problems.push({ line, errors, cells: row });
      return;
    }

    // Where: the State column first, else the end of the Where line; the city likewise.
    const merchant = get("merchant");
    const fromLine = placeParts(merchant);
    const state = stateCode(get("state")) ?? (get("state") === "" ? fromLine.state : null);
    const city = get("city") || (state != null && state === fromLine.state ? fromLine.city : null);
    const product = productOf(get("product"));
    const status = statusOf(get("status"));

    // The truck: by its name, else by the card account set on its page.
    const truckId = ctx.truckByName.get(squash(get("truck"))) ?? ctx.truckByCard.get(squash(get("card"))) ?? null;

    const txn = get("transactionId");
    const externalId = txn
      ? `txn:${txn.slice(0, 100)}`
      : `row:${[squash(get("truck")) || squash(get("card")), on, purchasedAt ? purchasedAt.toISOString().slice(11, 16) : "", keyNum(gallons, 3), keyNum(amount, 2), state ?? "", product].join("|")}`.slice(0, 200);
    if (seen.has(externalId) || ctx.existing.has(externalId)) {
      out.duplicates += 1;
      if (!seen.has(externalId)) out.again.push({ externalId, status });
      seen.add(externalId);
      return;
    }
    seen.add(externalId);

    if (!truckId) out.warnings.noTruck += 1;
    if (!state) out.warnings.noState += 1;
    if (product === "unknown") out.warnings.noProduct += 1;

    const location = [merchant, city && !merchant.includes(city) ? city : null, state && !fromLine.state ? state : null].filter(Boolean).join(", ") || null;
    out.good.push({ line, item: { externalId, on: on!, purchasedAt, truckId, location, state, city: city || null, product, status, taxPaid, gallons, pricePerGallon, discountPerGallon, discount, amount: amount! } });

    if (status === "settled") {
      out.summary.purchases += 1;
      chargedCents += Math.round(amount! * 100);
      if (gallons != null) gallonsMilli[product] = (gallonsMilli[product] ?? 0) + Math.round(gallons * 1000);
      if (state) states.add(state);
    } else out.summary.notCounted += 1;
    if (!out.summary.first || on! < out.summary.first) out.summary.first = on;
    if (!out.summary.last || on! > out.summary.last) out.summary.last = on;
  });

  out.summary.charged = chargedCents / 100;
  out.summary.states = states.size;
  for (const [p, v] of Object.entries(gallonsMilli)) out.summary.gallons[p as FuelProduct] = v / 1000;
  return out;
}
