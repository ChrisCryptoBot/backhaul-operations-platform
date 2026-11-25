import { toCsv } from "./csv";
import { IMPORT_MAX_PROBLEMS, IMPORT_MAX_ROWS, asYmd, type ProblemRow } from "./import-csv";
import { LOAD_LIMITS } from "./load-limits";
import { DEFAULT_TZ } from "./tz";
import { parseCentralLocal } from "./zoned";

/**
 * Loading a carrier's history from a spreadsheet or a TMS export: one row per finished load. The file's columns are matched to the desk's fields (a person can change any match), each row is checked, a
 * load that is already on the desk is left out, and what passes becomes a finished load that says it came from a file. Pure: the server reads and writes the database (server/tl/load-import.ts); this decides
 * what a file means.
 *
 * What an imported row becomes is fixed, and the screen says it before anything is written: a finished load with its lane, customer, miles, rate, truck (by name) and, when the file carries them, its invoice and
 * payment. It has no driver (that would put history on driver pay statements), no geocoding, and no frozen floor or detention terms: the cost profile today is not the cost of that day, so the Leak ledger
 * prices its empty miles and its detention from the carrier's intake (lib/leak-intake.ts) and says so on every line. It has no stops unless the file carries stop times: arrival and departure (and, if the file has
 * it, the appointment) at the pickup and the delivery become up to two stops with the wait between them, which is what detention is priced from. A file with no stop times leaves the load with no stops, and
 * the ledger counts it as one it could not check for detention.
 */
export type LoadFieldKey =
  | "loadNumber"
  | "customer"
  | "origin"
  | "destination"
  | "pickupDate"
  | "deliveryDate"
  | "loadedMiles"
  | "pickupEmptyMiles"
  | "returnEmptyMiles"
  | "revenue"
  | "fuelSurcharge"
  | "truck"
  | "invoicedDate"
  | "invoicedAmount"
  | "paidDate"
  | "paidAmount"
  | "pickupArrival"
  | "pickupDeparture"
  | "pickupAppointment"
  | "deliveryArrival"
  | "deliveryDeparture"
  | "deliveryAppointment";

export type LoadField = { key: LoadFieldKey; label: string; required: boolean; aliases: string[]; example: string; hint?: string };

export const LOAD_FIELDS: readonly LoadField[] = [
  { key: "loadNumber", label: "Load number", required: true, aliases: ["loadnumber", "load", "loadno", "loadid", "number", "proid", "pro", "tripnumber", "trip", "reference"], example: "1042" },
  { key: "customer", label: "Customer", required: false, aliases: ["customer", "broker", "brokername", "customername", "shipper", "billto", "bill_to"], example: "Acme Brokerage" },
  { key: "origin", label: "Pickup city", required: true, aliases: ["pickupcity", "origin", "origincity", "pickup", "pickuplocation", "from", "originaddress", "shipfrom"], example: "Dallas, TX" },
  { key: "destination", label: "Delivery city", required: true, aliases: ["deliverycity", "destination", "destinationcity", "delivery", "deliverylocation", "to", "destinationaddress", "shipto", "consignee"], example: "Atlanta, GA" },
  { key: "pickupDate", label: "Pickup date", required: false, aliases: ["pickupdate", "pudate", "shipdate", "pickupon", "datepickedup", "pickupday"], example: "2026-09-14" },
  { key: "deliveryDate", label: "Delivery date", required: true, aliases: ["deliverydate", "deldate", "delivereddate", "deliveredon", "completeddate", "completedon", "dropdate", "deliveryday", "datedelivered"], example: "2026-09-16" },
  { key: "loadedMiles", label: "Loaded miles", required: true, aliases: ["loadedmiles", "miles", "loaded", "milesloaded", "distance", "totalmiles", "loadedmile"], example: "781" },
  { key: "pickupEmptyMiles", label: "Empty miles before pickup", required: false, aliases: ["emptymilesbeforepickup", "pickupdeadhead", "deadheadbefore", "dhpickup", "dhorigin", "deadheadtopickup", "emptybefore", "pickupempty"], example: "42" },
  { key: "returnEmptyMiles", label: "Empty miles after delivery", required: false, aliases: ["emptymilesafterdelivery", "returndeadhead", "deadheadafter", "dhreturn", "deadheadhome", "emptyafter", "returnempty"], example: "0" },
  { key: "revenue", label: "Line haul", required: true, aliases: ["linehaul", "revenue", "rate", "linehaulrevenue", "amount", "gross", "linehaulrate", "ratetotal", "carrierpay"], example: "2150.00", hint: "The agreed rate, without the fuel surcharge." },
  { key: "fuelSurcharge", label: "Fuel surcharge", required: false, aliases: ["fuelsurcharge", "fsc", "fuel", "fuelsurchargeamount"], example: "180.00", hint: "In dollars." },
  { key: "truck", label: "Truck", required: false, aliases: ["truck", "unit", "unitnumber", "tractor", "tractornumber", "equipment", "truckname"], example: "Unit 104", hint: "Matched to a truck on the desk by name; a name the desk does not have leaves the truck blank." },
  { key: "invoicedDate", label: "Invoice date", required: false, aliases: ["invoicedate", "invoicedon", "billeddate", "dateinvoiced"], example: "2026-09-17" },
  { key: "invoicedAmount", label: "Invoiced amount", required: false, aliases: ["invoiceamount", "invoiced", "billed", "billedamount", "invoicetotal"], example: "2330.00" },
  { key: "paidDate", label: "Paid date", required: false, aliases: ["paiddate", "paidon", "datepaid", "paymentdate", "datereceived"], example: "2026-10-12" },
  { key: "paidAmount", label: "Paid amount", required: false, aliases: ["paidamount", "paid", "amountpaid", "payment", "received", "amountreceived"], example: "2330.00" },
  { key: "pickupArrival", label: "Pickup arrival", required: false, aliases: ["pickuparrival", "pickuparrive", "pickuparrived", "pickuparrivaltime", "pickuparrivaldatetime", "pickupcheckin", "pickupin", "pickupintime", "puarrival", "pucheckin", "arrivalatpickup", "shipperarrival", "shipperin", "originarrival"], example: "2026-09-14 08:05", hint: "Date and time the truck got to the shipper. Detention is priced from arrival to departure." },
  { key: "pickupDeparture", label: "Pickup departure", required: false, aliases: ["pickupdeparture", "pickupdepart", "pickupdeparted", "pickupdeparturetime", "pickupdeparturedatetime", "pickupcheckout", "pickupout", "pickupouttime", "pudeparture", "pucheckout", "departureatpickup", "shipperdeparture", "shipperout", "origindeparture"], example: "2026-09-14 11:40" },
  { key: "pickupAppointment", label: "Pickup appointment", required: false, aliases: ["pickupappointment", "pickupappt", "pickupappttime", "puappointment", "puappt", "appointmentatpickup", "shipperappointment", "shipperappt"], example: "2026-09-14 09:00", hint: "When the pickup was booked for. Free time starts at the later of the arrival and this, so an early arrival is not billed." },
  { key: "deliveryArrival", label: "Delivery arrival", required: false, aliases: ["deliveryarrival", "deliveryarrive", "deliveryarrived", "deliveryarrivaltime", "deliveryarrivaldatetime", "deliverycheckin", "deliveryin", "deliveryintime", "delarrival", "delcheckin", "arrivalatdelivery", "consigneearrival", "consigneein", "destinationarrival"], example: "2026-09-16 07:50" },
  { key: "deliveryDeparture", label: "Delivery departure", required: false, aliases: ["deliverydeparture", "deliverydepart", "deliverydeparted", "deliverydeparturetime", "deliverydeparturedatetime", "deliverycheckout", "deliveryout", "deliveryouttime", "deldeparture", "delcheckout", "departureatdelivery", "consigneedeparture", "consigneeout", "destinationdeparture"], example: "2026-09-16 09:15" },
  { key: "deliveryAppointment", label: "Delivery appointment", required: false, aliases: ["deliveryappointment", "deliveryappt", "deliveryappttime", "delappointment", "delappt", "appointmentatdelivery", "consigneeappointment", "consigneeappt"], example: "2026-09-16 08:00" }
];

/** The columns that carry a time at a stop. A match that reads none of them leaves every imported load with no wait, so detention cannot be checked on it. */
export const STOP_TIME_FIELDS: readonly LoadFieldKey[] = ["pickupArrival", "pickupDeparture", "pickupAppointment", "deliveryArrival", "deliveryDeparture", "deliveryAppointment"];

export const FIELD_OF: Readonly<Record<LoadFieldKey, LoadField>> = Object.fromEntries(LOAD_FIELDS.map((f) => [f.key, f])) as Record<LoadFieldKey, LoadField>;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The desk's field for each file column index (or null: not used). */
export type ColumnMap = Record<LoadFieldKey, number | null>;
export const emptyMap = (): ColumnMap => Object.fromEntries(LOAD_FIELDS.map((f) => [f.key, null])) as ColumnMap;

/** A first guess at the match for any list of fields: each file column is used for at most one field, a field takes the first column that names it, and exact names beat loose ones. */
export function matchHeader<K extends string>(header: readonly string[], fields: ReadonlyArray<{ key: K; label: string; aliases: readonly string[] }>): Record<K, number | null> {
  const map = Object.fromEntries(fields.map((f) => [f.key, null])) as Record<K, number | null>;
  const taken = new Set<number>();
  const cells = header.map(norm);
  // Two passes: a column whose whole name is a field's own label first, then any alias.
  for (const exact of [true, false]) {
    for (const f of fields) {
      if (map[f.key] != null) continue;
      const at = cells.findIndex((c, i) => !taken.has(i) && c !== "" && (exact ? c === norm(f.label) : f.aliases.includes(c)));
      if (at >= 0) {
        map[f.key] = at;
        taken.add(at);
      }
    }
  }
  return map;
}

/** A first guess at the match for a file of loads. */
export const autoMap = (header: readonly string[]): ColumnMap => matchHeader(header, LOAD_FIELDS);

/** The required fields that have no column. */
export const missingFields = (map: ColumnMap): LoadField[] => LOAD_FIELDS.filter((f) => f.required && map[f.key] == null);

/** A map that is safe to use against this header: indexes inside the file, and no column used twice (the later field loses it). */
export function cleanMap(map: Partial<Record<LoadFieldKey, number | null>>, width: number): ColumnMap {
  const out = emptyMap();
  const used = new Set<number>();
  for (const f of LOAD_FIELDS) {
    const v = map[f.key];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < width && !used.has(v)) {
      out[f.key] = v;
      used.add(v);
    }
  }
  return out;
}

/** A file with the header the desk names and one example row, for a person to fill in. */
export function loadImportTemplate(): string {
  return toCsv(
    LOAD_FIELDS.map((f) => f.label),
    [LOAD_FIELDS.map((f) => f.example)]
  );
}

// ── Reading a row ────────────────────────────────────────────────────────────────────────────────

/** What one good row becomes. Dates are the calendar day at noon UTC, so the day is the same on every US clock. */
export type LoadDraft = {
  loadNumber: string;
  customer: string | null;
  origin: string;
  destination: string;
  pickupAt: Date | null;
  completedAt: Date;
  loadedMiles: number;
  pickupEmptyMiles: number;
  returnEmptyMiles: number;
  revenue: number;
  fuelSurcharge: number | null;
  truck: string | null;
  invoicedAt: Date | null;
  invoicedAmount: number | null;
  paidAt: Date | null;
  paidAmount: number | null;
  /** Up to two stops (pickup, delivery) when the file carried times for them; none otherwise. */
  stops: DraftStop[];
};

/**
 * A stop the file carried times for. `waitMinutes` is the time between the later of the arrival and the appointment (free time starts there) and the departure, in whole minutes; null when the file has an
 * arrival but no departure, because a wait nobody recorded is not estimated.
 */
export type DraftStop = { role: "pickup" | "delivery"; address: string; arrivedAt: Date | null; waitMinutes: number | null };

/** The most miles one load can plausibly carry, and the most dollars: a cell past these is a typo, not a load. */
export const MAX_MILES = LOAD_LIMITS.miles;
export const MAX_DOLLARS = 1_000_000;

function money(raw: string): number | null | "bad" {
  const t = raw.trim();
  if (t === "") return null;
  const neg = /^\(.*\)$/.test(t) || t.startsWith("-");
  const s = t.replace(/[()$,\s-]/g, "");
  if (!/^\d+(\.\d{1,4})?$/.test(s)) return "bad";
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : "bad";
}

/** A wait longer than this is a typo in a date, not a wait. */
export const MAX_WAIT_MINUTES = 7 * 24 * 60;

/**
 * A date and time from a TMS export as the instant it is on the carrier's clock (`zone`): "2026-09-14 08:05", "2026-09-14T08:05:30", "9/14/2026 8:05 AM", "9-14-2026 17:05", or with an explicit
 * offset ("2026-09-14T08:05:00-05:00", "...Z"). A day with no time is "bad": a wait cannot be read from it. Null when blank.
 */
export function readDateTime(raw: string, zone: string = DEFAULT_TZ): Date | null | "bad" {
  const t = raw.trim();
  if (t === "") return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(t);
  const us = iso ? null : /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i.exec(t);
  if (!iso && !us) return "bad";
  let y: number, mo: number, d: number, h: number, mi: number;
  let offset: string | undefined;
  if (iso) {
    [y, mo, d, h, mi] = [Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4]), Number(iso[5])] as [number, number, number, number, number];
    offset = iso[7];
  } else {
    const m = us!;
    y = Number(m[3]);
    if (m[3]!.length === 2) y += 2000;
    mo = Number(m[1]);
    d = Number(m[2]);
    h = Number(m[4]);
    mi = Number(m[5]);
    const ap = m[7]?.toUpperCase();
    if (ap) {
      if (h < 1 || h > 12) return "bad";
      h = (h % 12) + (ap === "PM" ? 12 : 0);
    }
  }
  if (y < 1990 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return "bad";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (offset) {
    const at = new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== d) return "bad";
    if (offset.toUpperCase() === "Z") return at;
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2));
    return new Date(at.getTime() - sign * minutes * 60_000);
  }
  const ms = parseCentralLocal(`${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}`, zone);
  return ms == null ? "bad" : new Date(ms);
}

function whole(raw: string): number | null | "bad" {
  const t = raw.trim().replace(/,/g, "");
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return "bad";
  return Number(t);
}

/** A calendar day (2026-09-14, 9/14/2026, 09-14-2026) as noon UTC, or null when blank, "bad" when it is not a real day. */
export function readDay(raw: string): Date | null | "bad" {
  const t = asYmd(raw);
  if (t === "") return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (!m) return "bad";
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const at = new Date(Date.UTC(y, mo - 1, d, 12));
  return y >= 1990 && y <= 2100 && at.getUTCMonth() === mo - 1 && at.getUTCDate() === d ? at : "bad";
}

const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(" "));

/**
 * A place as the desk spells a lane ("Dallas, TX") when the file's text ends in a city and a two-letter state (a street, a ZIP and any capitals are dropped or fixed), else the text as given.
 * A city typed all in one case is capitalised; one already in mixed case is left as it is.
 */
export function placeOf(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  // "Dallas, TX", "Dallas, TX 75207", "2300 Irving Blvd, Dallas, TX 75207": the last city and a two-letter state after a comma.
  let m = /([^,]+),\s*([A-Za-z]{2})\b(?:\.)?(?:\s+\d{5}(?:-\d{4})?)?\s*$/.exec(t);
  // "Dallas TX" or "DALLAS TX 75207": no comma, but the last word is a real state.
  if (!m) {
    const loose = /^(.+?)\s+([A-Za-z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(t);
    if (loose && STATES.has(loose[2]!.toUpperCase())) m = loose;
  }
  if (!m) return t;
  let city = m[1]!.trim();
  if (city === city.toLowerCase() || city === city.toUpperCase()) city = city.toLowerCase().replace(/(^|[\s.'-])(\p{L})/gu, (_x, sep: string, c: string) => `${sep}${c.toUpperCase()}`);
  return `${city}, ${m[2]!.toUpperCase()}`;
}

/** Whether a customer already holds a load number: a customer left blank on either side makes two loads the same one. */
const clash = (holders: ReadonlySet<string> | undefined, customer: string | null) => holders != null && (holders.has("") || customer == null || holders.has(customer.toLowerCase()));

export type LoadCheck = {
  /** Rows with something in them. */
  total: number;
  good: Array<{ line: number; item: LoadDraft }>;
  /** Up to IMPORT_MAX_PROBLEMS; `problemCount` is every one. */
  problems: ProblemRow[];
  problemCount: number;
  /** Already on the desk (same number, same or unnamed customer) or twice in the file: left out, counted apart from the mistakes. */
  duplicates: number;
  tooMany: boolean;
  /** What the good rows carry, for the screen's "what you are importing". */
  summary: { revenue: number; miles: number; first: Date | null; last: Date | null; invoiced: number; paid: number; withTruck: number; truckNames: number; /** Good rows with a wait recorded at one stop or more: detention can be priced on these. */ withWaits: number; /** Good rows with an arrival but no departure at a stop: counted, because that wait is not estimated. */ arrivalOnly: number };
};

export type CheckContext = {
  /** "number|customer" for each load already on the desk, lower-cased; a customer left blank on either side makes two loads the same one. */
  existing: ReadonlyMap<string, ReadonlySet<string>>;
  /** Trucks on the desk by lower-cased name. */
  trucks: ReadonlySet<string>;
  /** The carrier's clock, which the times in a file are read on (the workspace's zone). Central when left out. */
  zone?: string;
};

const cell = (row: string[], at: number | null) => (at == null ? "" : (row[at] ?? "").trim());

/** Check every row of the file against the match. Rows are numbered as they are in the file (the header is line 1). */
export function checkLoadRows(table: string[][], map: ColumnMap, ctx: CheckContext): LoadCheck {
  const body = table.slice(1);
  const out: LoadCheck = { total: 0, good: [], problems: [], problemCount: 0, duplicates: 0, tooMany: body.length > IMPORT_MAX_ROWS + 1000, summary: { revenue: 0, miles: 0, first: null, last: null, invoiced: 0, paid: 0, withTruck: 0, truckNames: 0, withWaits: 0, arrivalOnly: 0 } };
  const zone = ctx.zone ?? DEFAULT_TZ;
  if (out.tooMany) return out;
  const seen = new Map<string, Set<string>>();
  const unknownTrucks = new Set<string>();
  body.forEach((row, i) => {
    if (row.every((c) => c.trim() === "")) return;
    out.total += 1;
    const line = i + 2;
    const errors: string[] = [];
    const fail = (msg: string) => errors.push(msg);
    const get = (k: LoadFieldKey) => cell(row, map[k]);

    const loadNumber = get("loadNumber");
    if (loadNumber === "") fail("Load number is empty.");
    if (loadNumber.length > 40) fail("Load number is longer than 40 characters.");
    const origin = placeOf(get("origin"));
    const destination = placeOf(get("destination"));
    if (origin === "") fail("Pickup city is empty.");
    if (destination === "") fail("Delivery city is empty.");
    if (origin.length > 120 || destination.length > 120) fail("A place is longer than 120 characters.");

    const delivered = readDay(get("deliveryDate"));
    if (delivered === null) fail("Delivery date is empty: a finished load needs the day it finished.");
    else if (delivered === "bad") fail("Delivery date is not a date (use 2026-09-16 or 9/16/2026).");
    else if (delivered.getTime() > Date.now() + 86_400_000) fail("Delivery date is in the future: this imports finished loads only.");
    const picked = readDay(get("pickupDate"));
    if (picked === "bad") fail("Pickup date is not a date (use 2026-09-14 or 9/14/2026).");
    if (picked instanceof Date && delivered instanceof Date && picked.getTime() > delivered.getTime()) fail("Pickup date is after the delivery date.");

    const miles = whole(get("loadedMiles"));
    if (miles === null) fail("Loaded miles is empty.");
    else if (miles === "bad") fail("Loaded miles is not a number.");
    else if (!(miles > 0) || miles > MAX_MILES) fail(`Loaded miles must be over 0 and no more than ${MAX_MILES.toLocaleString("en-US")}.`);
    const before = whole(get("pickupEmptyMiles"));
    const after = whole(get("returnEmptyMiles"));
    for (const [v, what] of [[before, "Empty miles before pickup"], [after, "Empty miles after delivery"]] as const) {
      if (v === "bad") fail(`${what} is not a number.`);
      else if (v != null && v > MAX_MILES) fail(`${what} is more than ${MAX_MILES.toLocaleString("en-US")}.`);
    }

    const revenue = money(get("revenue"));
    if (revenue === null) fail("Line haul is empty.");
    else if (revenue === "bad") fail("Line haul is not a dollar amount.");
    else if (!(revenue > 0) || revenue > MAX_DOLLARS) fail(`Line haul must be over $0 and no more than $${MAX_DOLLARS.toLocaleString("en-US")}.`);
    const fsc = money(get("fuelSurcharge"));
    if (fsc === "bad") fail("Fuel surcharge is not a dollar amount.");
    else if (fsc != null && (fsc < 0 || fsc > MAX_DOLLARS)) fail("Fuel surcharge is out of range.");

    const invoicedAt = readDay(get("invoicedDate"));
    const paidAt = readDay(get("paidDate"));
    if (invoicedAt === "bad") fail("Invoice date is not a date.");
    if (paidAt === "bad") fail("Paid date is not a date.");
    const invoicedAmount = money(get("invoicedAmount"));
    const paidAmount = money(get("paidAmount"));
    if (invoicedAmount === "bad") fail("Invoiced amount is not a dollar amount.");
    else if (invoicedAmount != null && (invoicedAmount < 0 || invoicedAmount > MAX_DOLLARS)) fail("Invoiced amount is out of range.");
    if (paidAmount === "bad") fail("Paid amount is not a dollar amount.");
    else if (paidAmount != null && (paidAmount < 0 || paidAmount > MAX_DOLLARS)) fail("Paid amount is out of range.");
    if (paidAt instanceof Date && invoicedAt instanceof Date && paidAt.getTime() < invoicedAt.getTime()) fail("Paid date is before the invoice date.");

    // Stop times: each side is read when the file has columns for it. A time that is not a date and time, a departure before the arrival, or a wait of more than a week is a mistake in the row.
    const stops: DraftStop[] = [];
    for (const [role, place, labels, arrivalKey, departureKey, appointmentKey] of [
      ["pickup", origin, "Pickup", "pickupArrival", "pickupDeparture", "pickupAppointment"],
      ["delivery", destination, "Delivery", "deliveryArrival", "deliveryDeparture", "deliveryAppointment"]
    ] as const) {
      const arrival = readDateTime(get(arrivalKey), zone);
      const departure = readDateTime(get(departureKey), zone);
      const appointment = readDateTime(get(appointmentKey), zone);
      let bad = false;
      for (const [v, what] of [[arrival, "arrival"], [departure, "departure"], [appointment, "appointment"]] as const) {
        if (v === "bad") {
          fail(`${labels} ${what} is not a date and time (use 2026-09-14 08:05 or 9/14/2026 8:05 AM).`);
          bad = true;
        }
      }
      if (bad || !(arrival instanceof Date)) continue;
      if (departure instanceof Date && departure.getTime() < arrival.getTime()) {
        fail(`${labels} departure is before the arrival.`);
        continue;
      }
      let wait: number | null = null;
      if (departure instanceof Date) {
        // Free time starts at the later of the arrival and the appointment: a truck that came early is not owed for the hours before it.
        const from = appointment instanceof Date && appointment.getTime() > arrival.getTime() ? appointment : arrival;
        wait = Math.max(0, Math.floor((departure.getTime() - from.getTime()) / 60_000));
        if (wait > MAX_WAIT_MINUTES) {
          fail(`${labels} wait is longer than 7 days: check the arrival and departure.`);
          continue;
        }
      }
      stops.push({ role, address: place, arrivedAt: arrival, waitMinutes: wait });
    }

    if (errors.length > 0) {
      out.problemCount += 1;
      if (out.problems.length < IMPORT_MAX_PROBLEMS) out.problems.push({ line, errors, cells: row });
      return;
    }

    const customer = get("customer") || null;
    const truckName = get("truck") || null;
    // Already on the desk, or twice in this file: the same number from the same customer (a blank customer on either side is the same one).
    const n = loadNumber.toLowerCase();
    if (clash(ctx.existing.get(n), customer) || clash(seen.get(n), customer)) {
      out.duplicates += 1;
      return;
    }
    seen.set(n, (seen.get(n) ?? new Set()).add((customer ?? "").toLowerCase()));

    const item: LoadDraft = {
      loadNumber,
      customer,
      origin,
      destination,
      pickupAt: picked instanceof Date ? picked : null,
      completedAt: delivered as Date,
      loadedMiles: miles as number,
      pickupEmptyMiles: typeof before === "number" ? before : 0,
      returnEmptyMiles: typeof after === "number" ? after : 0,
      revenue: revenue as number,
      fuelSurcharge: typeof fsc === "number" ? fsc : null,
      truck: truckName,
      invoicedAt: invoicedAt instanceof Date ? invoicedAt : null,
      invoicedAmount: typeof invoicedAmount === "number" ? invoicedAmount : null,
      paidAt: paidAt instanceof Date ? paidAt : null,
      paidAmount: typeof paidAmount === "number" ? paidAmount : null,
      stops
    };
    if (truckName != null) {
      if (ctx.trucks.has(truckName.toLowerCase())) out.summary.withTruck += 1;
      else unknownTrucks.add(truckName.toLowerCase());
    }
    out.good.push({ line, item });
  });
  for (const g of out.good) {
    const s = out.summary;
    s.revenue += g.item.revenue + (g.item.fuelSurcharge ?? 0);
    s.miles += g.item.loadedMiles;
    if (!s.first || g.item.completedAt < s.first) s.first = g.item.completedAt;
    if (!s.last || g.item.completedAt > s.last) s.last = g.item.completedAt;
    if (g.item.invoicedAt || g.item.invoicedAmount != null || g.item.paidAt) s.invoiced += 1;
    if (g.item.paidAt) s.paid += 1;
    if (g.item.stops.some((st) => st.waitMinutes != null)) s.withWaits += 1;
    else if (g.item.stops.length > 0) s.arrivalOnly += 1;
  }
  out.summary.truckNames = unknownTrucks.size;
  return out;
}

/** The invoice and payment an imported load carries: paid when the file has a paid date, invoiced when it has an invoice date or amount, else neither (the desk will list it as ready to invoice). */
export function paymentOf(d: LoadDraft): { status: "paid" | "invoiced" | null; invoicedAt: Date | null; invoicedAmount: number | null; paidAt: Date | null; paidAmount: number | null } {
  const total = d.revenue + (d.fuelSurcharge ?? 0);
  if (d.paidAt) return { status: "paid", invoicedAt: d.invoicedAt ?? d.completedAt, invoicedAmount: d.invoicedAmount ?? total, paidAt: d.paidAt, paidAmount: d.paidAmount ?? d.invoicedAmount ?? total };
  if (d.invoicedAt || d.invoicedAmount != null) return { status: "invoiced", invoicedAt: d.invoicedAt ?? d.completedAt, invoicedAmount: d.invoicedAmount ?? total, paidAt: null, paidAmount: null };
  return { status: null, invoicedAt: null, invoicedAmount: null, paidAt: null, paidAmount: null };
}

/** The mark an imported load carries in its `channel`, and how to read it back. */
export const importChannel = (batchId: string) => `import:${batchId}`;
export const batchOfChannel = (channel: string | null | undefined): string | null => (channel?.startsWith("import:") ? channel.slice("import:".length) : null);

/** The readers a weekly-tracker file shares with a file of loads. */
export { money as readMoney, whole as readWhole };
