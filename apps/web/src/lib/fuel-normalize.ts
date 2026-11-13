/**
 * Fuel purchases read cleanly, whatever source they came from (a card company's API, a CSV file): the jurisdiction they were bought in, what was pumped, and where the purchase stands. Pure, so
 * the card adapters, the CSV importer and the database backfill (prisma/migrations/20261221000000_fuel_purchase_state) all agree, and state totals for fuel tax come out the same every time.
 */

export const US_STATES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming"
};

export const CA_PROVINCES: Readonly<Record<string, string>> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador", NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario",
  PE: "Prince Edward Island", QC: "Quebec", SK: "Saskatchewan", YT: "Yukon"
};

/** Every code a purchase's state can be stored as. The migration's backfill holds the same list. */
export const JURISDICTION_CODES: readonly string[] = [...Object.keys(US_STATES), ...Object.keys(CA_PROVINCES)];
const CODES = new Set(JURISDICTION_CODES);
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
const BY_NAME = new Map<string, string>([...Object.entries(US_STATES), ...Object.entries(CA_PROVINCES)].map(([code, name]) => [squash(name), code]));
// Names a source writes that are not the formal one.
for (const [alias, code] of [["washingtondc", "DC"], ["quebec", "QC"], ["newfoundland", "NL"], ["pei", "PE"], ["yukonterritory", "YT"]] as const) BY_NAME.set(alias, code);

/** A jurisdiction's two-letter code from "TX", "tx", "Texas", "TX 75201" or "Texas 75201". Anything else is null: a state is never guessed. */
export function stateCode(text: string | null | undefined): string | null {
  if (text == null) return null;
  const t = text.trim().replace(/\s+\d{5}(?:-\d{4})?$/, "").replace(/\s+[A-Za-z]\d[A-Za-z]\s?\d[A-Za-z]\d$/, "").trim();
  if (t === "") return null;
  if (/^[A-Za-z]{2}$/.test(t)) {
    const code = t.toUpperCase();
    return CODES.has(code) ? code : null;
  }
  return BY_NAME.get(squash(t)) ?? null;
}

/**
 * The city and state at the end of a place line: "Pilot Flying J, Dallas, TX", "Dallas, TX 75201", "Amarillo, Texas". The state is the last part, the city the part before it (null when the
 * line has only a state). A line whose last part is not a jurisdiction gives nothing.
 */
export function placeParts(location: string | null | undefined): { city: string | null; state: string | null } {
  if (location == null) return { city: null, state: null };
  const parts = location.trim().split(/\s*,\s*/).filter((p) => p !== "");
  if (parts.length === 0) return { city: null, state: null };
  const state = stateCode(parts[parts.length - 1]);
  if (!state) return { city: null, state: null };
  return { city: parts.length >= 2 ? parts[parts.length - 2]! : null, state };
}

export const FUEL_PRODUCTS = ["road_diesel", "reefer_diesel", "def", "gasoline", "other", "unknown"] as const;
export type FuelProduct = (typeof FUEL_PRODUCTS)[number];
export const PRODUCT_LABEL: Record<FuelProduct, string> = { road_diesel: "Diesel", reefer_diesel: "Reefer diesel", def: "DEF", gasoline: "Gasoline", other: "Other", unknown: "Not said" };

/**
 * What was pumped, from a source's product code or words. Reefer and dyed (off-road) diesel are the trailer unit's fuel and DEF is exhaust fluid: neither is the tractor's road diesel, which is
 * all fuel tax counts. A code that names nothing known is "other"; a blank one is "unknown". Checked in order, so "reefer diesel" is reefer and "diesel exhaust fluid" is DEF.
 */
export function productOf(code: string | null | undefined): FuelProduct {
  if (code == null) return "unknown";
  const t = code.trim().toLowerCase().replace(/[_\-./]+/g, " ").replace(/\s+/g, " ");
  if (t === "") return "unknown";
  if (/\bdef\b|exhaust fluid|adblue/.test(t)) return "def";
  if (/reefer|\bdyed\b|off ?road|\bred diesel\b/.test(t)) return "reefer_diesel";
  if (/diesel|\bulsd\b|\blsd\b|\bdsl\b|#\s?[12]\b|\bno\.? ?2\b|\bbiodiesel\b|\bb\d{1,2}\b/.test(t)) return "road_diesel";
  if (/unleaded|gasoline|\bgas\b|\bunl\b|\bregular\b|\bpremium\b|\bmidgrade\b|\be(10|15|85)\b/.test(t)) return "gasoline";
  return "other";
}

/** Gallons that are fuel (everything but DEF): what the Fuel screen's gallons and its price a gallon are over. */
export const isFuelGallons = (p: string): boolean => p !== "def";

export const FUEL_STATUSES = ["settled", "pending", "declined", "void"] as const;
export type FuelStatus = (typeof FUEL_STATUSES)[number];
export const STATUS_LABEL: Record<FuelStatus, string> = { settled: "Settled", pending: "Pending", declined: "Declined", void: "Void" };

/**
 * Where a purchase stands, from a source's status word. A source that sends no status lists only posted purchases, so blank is settled. A word that is not known is pending: it is kept and
 * shown, but not counted or offered on a statement until the source says it settled.
 */
export function statusOf(code: string | null | undefined): FuelStatus {
  if (code == null) return "settled";
  const t = code.trim().toLowerCase();
  if (t === "") return "settled";
  if (/^(posted|settled|complete|completed|approved|cleared|captured|final)$/.test(t)) return "settled";
  if (/^(declined|denied|rejected|failed)$/.test(t)) return "declined";
  if (/^(void|voided|reversed|reversal|refunded|cancelled|canceled)$/.test(t)) return "void";
  return "pending";
}

/**
 * How a kept purchase's status may move when the source reports it again. A pending one becomes whatever the source now says; a settled one can only be reversed (void), never back to pending
 * or declined; declined and void are final. Null is "leave it".
 */
export function nextStatus(had: string, now: FuelStatus): FuelStatus | null {
  if (had === now) return null;
  if (had === "pending") return now;
  if (had === "settled" && now === "void") return "void";
  return null;
}

/** Only settled purchases are offered on a driver statement or counted in fuel and fuel-tax totals. */
export const isCounted = (status: string): boolean => status === "settled";
