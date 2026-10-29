import type { AcceptGate, MarketBand } from "@/truelane/lib/domain/marketVerdict";
import { fuelSurchargeDollars, type FuelSurchargeUnit } from "@/truelane/lib/fuelSurcharge";
import { isUnusualValue } from "@/truelane/lib/formatNumbers";
import { parseCentralLocal } from "./zoned";
import type { LoadSpecs } from "./load-fit";

/**
 * A quote is the phone's Calculate screen as a dispatcher uses it: an offer on a load that is not booked yet, priced against a truck's cost
 * floor and the market. This file is the form's side: the values as typed, the checks (strict to save or book, lenient to price as you type),
 * and the phone's own wording for the verdict band and for the question asked before a load that needs one is accepted. Pure: the browser and
 * the server both run it.
 */
export type QuoteStopRole = "pickup" | "delivery";
export type QuoteStop = { role: QuoteStopRole; address: string; /** "2026-10-30T08:00" on the Dallas clock, or blank. */ appointment: string };

export type QuoteValues = {
  stops: QuoteStop[];
  broker: string;
  /** The broker's paperwork, kept on the load when it is booked. All optional. */
  brokerMc: string;
  loadNumber: string;
  poNumber: string;
  brokerPhone: string;
  brokerEmail: string;
  trailer: string;
  /** What the load is, so a truck that cannot carry it is not offered. All optional; blank checks nothing. */
  weightLbs: string;
  lengthFt: string;
  widthFt: string;
  heightIn: string;
  hazmatClass: string;
  requiresLiftgate: boolean;
  requiresRamp: boolean;
  requiresPalletJack: boolean;
  offer: string;
  fsc: string;
  fscUnit: FuelSurchargeUnit;
  /** What the load would pay at market, as a total for the load (typed by hand, as on the phone). */
  marketRate: string;
  loadedMiles: string;
  /** Empty miles from the truck to the pickup. The same for every truck unless one is typed for it in `emptyByTruck`. */
  emptyToPickup: string;
  /** Empty miles home after the last delivery. */
  emptyHome: string;
  /** "I have a load back": the way home is covered, so it counts as no empty miles. */
  loadBack: boolean;
  payTermsDays: string;
  /** Blank uses the truck's own factoring fee. */
  factoringPct: string;
  emptyByTruck: Record<string, string>;
  /** Empty miles home after the last delivery, for one truck (measured from its base). A typed `emptyHome` replaces all of them. */
  emptyHomeByTruck: Record<string, string>;
  /** Drive hours for the loaded miles as measured on the road. Blank: the verdict assumes 50 mph over every mile. Cleared when the loaded miles are typed by hand. */
  loadedHours: string;
};

export const BLANK_QUOTE: QuoteValues = {
  stops: [
    { role: "pickup", address: "", appointment: "" },
    { role: "delivery", address: "", appointment: "" }
  ],
  broker: "",
  brokerMc: "",
  loadNumber: "",
  poNumber: "",
  brokerPhone: "",
  brokerEmail: "",
  trailer: "",
  weightLbs: "",
  lengthFt: "",
  widthFt: "",
  heightIn: "",
  hazmatClass: "",
  requiresLiftgate: false,
  requiresRamp: false,
  requiresPalletJack: false,
  offer: "",
  fsc: "",
  fscUnit: "percent",
  marketRate: "",
  loadedMiles: "",
  emptyToPickup: "",
  emptyHome: "",
  loadBack: false,
  payTermsDays: "",
  factoringPct: "",
  emptyByTruck: {},
  emptyHomeByTruck: {},
  loadedHours: ""
};

export type QuoteInput = {
  stops: Array<{ role: QuoteStopRole; address: string; appointment: number | null }>;
  broker: string | null;
  brokerMc: string | null;
  loadNumber: string | null;
  poNumber: string | null;
  brokerPhone: string | null;
  brokerEmail: string | null;
  trailer: string | null;
  specs: LoadSpecs;
  offer: number;
  fsc: number;
  fscUnit: FuelSurchargeUnit;
  marketTotal: number | null;
  loadedMiles: number;
  emptyToPickup: number;
  emptyHome: number;
  loadBack: boolean;
  payTermsDays: number | null;
  factoringFraction: number | null;
  emptyByTruck: Record<string, number>;
  emptyHomeByTruck: Record<string, number>;
  loadedHours: number | null;
};

export type QuoteErrors = Record<string, string>;
export type QuoteCheck = { ok: true; input: QuoteInput; warnings: string[] } | { ok: false; errors: QuoteErrors };

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (s: string): number | null => {
  if (s === "") return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

/** The number in a field, or null when it is blank or not a number. For the live price, which never stops for a stray field. */
const positive = (s: string): number | null => {
  const n = num(str(s));
  return n != null && n > 0 ? n : null;
};

/** Everything the price needs and nothing it does not: an offer and loaded miles. Null until both are typed. */
export function readQuote(values: QuoteValues): QuoteInput | null {
  const offer = positive(values.offer);
  const loadedMiles = positive(values.loadedMiles);
  if (offer == null || loadedMiles == null) return null;
  const nonNeg = (s: string) => {
    const n = num(str(s));
    return n != null && n >= 0 ? n : 0;
  };
  const byTruck: Record<string, number> = {};
  for (const [k, v] of Object.entries(values.emptyByTruck ?? {})) {
    const n = num(str(v));
    if (n != null && n >= 0) byTruck[k] = n;
  }
  const homeByTruck: Record<string, number> = {};
  for (const [k, v] of Object.entries(values.emptyHomeByTruck ?? {})) {
    const n = num(str(v));
    if (n != null && n >= 0) homeByTruck[k] = n;
  }
  const fsc = nonNeg(values.fsc);
  const market = positive(values.marketRate);
  const factoring = num(str(values.factoringPct));
  return {
    stops: values.stops.map((s) => ({ role: s.role, address: str(s.address), appointment: s.appointment ? parseCentralLocal(s.appointment) : null })),
    broker: str(values.broker) || null,
    brokerMc: str(values.brokerMc).replace(/^mc[\s-]*/i, "") || null,
    loadNumber: str(values.loadNumber) || null,
    poNumber: str(values.poNumber) || null,
    brokerPhone: str(values.brokerPhone) || null,
    brokerEmail: str(values.brokerEmail) || null,
    trailer: str(values.trailer) || null,
    specs: {
      weightLbs: positive(values.weightLbs ?? ""),
      lengthFt: positive(values.lengthFt ?? ""),
      widthFt: positive(values.widthFt ?? ""),
      heightIn: positive(values.heightIn ?? ""),
      hazmatClass: str(values.hazmatClass ?? "") || null,
      requiresLiftgate: values.requiresLiftgate === true,
      requiresRamp: values.requiresRamp === true,
      requiresPalletJack: values.requiresPalletJack === true
    },
    offer,
    fsc,
    fscUnit: values.fscUnit === "per_mile" ? "per_mile" : "percent",
    marketTotal: market,
    loadedMiles,
    emptyToPickup: nonNeg(values.emptyToPickup),
    emptyHome: nonNeg(values.emptyHome),
    loadBack: values.loadBack === true,
    payTermsDays: num(str(values.payTermsDays)),
    factoringFraction: factoring != null && factoring >= 0 && factoring <= 100 ? factoring / 100 : null,
    emptyByTruck: byTruck,
    emptyHomeByTruck: homeByTruck,
    loadedHours: positive(values.loadedHours ?? "")
  };
}

/** The check to save a quote or book it: every field that was typed must be right, and the route must be a route. */
export function validateQuote(values: QuoteValues): QuoteCheck {
  const errors: QuoteErrors = {};
  const stops = values.stops;
  if (stops.length < 2) errors.stops = "A load needs a pickup and a delivery.";
  else {
    if (stops[0]!.role !== "pickup") errors.stops = "The first stop is the pickup.";
    else if (stops[stops.length - 1]!.role !== "delivery") errors.stops = "The last stop is a delivery.";
  }
  stops.forEach((s, i) => {
    if (str(s.address).length < 2) errors[`stop${i}`] = "Where is this stop? A city and state is enough.";
    if (s.appointment && parseCentralLocal(s.appointment) == null) errors[`stop${i}Time`] = "A real date and time.";
  });
  const mc = str(values.brokerMc).replace(/^mc[\s-]*/i, "");
  if (mc !== "" && !/^\d{3,8}$/.test(mc)) errors.brokerMc = "Digits only, for example 123456.";
  if (str(values.loadNumber).length > 40) errors.loadNumber = "At most 40 characters.";
  if (str(values.poNumber).length > 40) errors.poNumber = "At most 40 characters.";
  const phone = str(values.brokerPhone);
  if (phone !== "" && (phone.replace(/\D/g, "").length < 7 || phone.replace(/\D/g, "").length > 15 || /[^\d\s()+.\-x]/i.test(phone))) errors.brokerPhone = "A phone number, for example 555-0142.";
  const email = str(values.brokerEmail);
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.brokerEmail = "An email address, for example name@example.com.";
  for (const [key, label, max, whole] of [["weightLbs", "Weight in pounds", 200000, true], ["lengthFt", "Length in feet", 120, false], ["widthFt", "Width in feet", 30, false], ["heightIn", "Height in inches", 300, false]] as const) {
    const raw = str(values[key] ?? "");
    if (raw === "") continue;
    const n = num(raw);
    if (n == null || !(n > 0) || n > max || (whole && !Number.isInteger(n))) errors[key] = `${label}: ${whole ? "a whole number" : "a number"} above 0 and up to ${max.toLocaleString("en-US")}.`;
  }
  if (str(values.hazmatClass ?? "").length > 20) errors.hazmatClass = "At most 20 characters.";
  const offer = num(str(values.offer));
  if (offer == null || !(offer > 0)) errors.offer = "Type what the load pays.";
  else if (offer > 100000) errors.offer = "That is a lot for one load. Check it.";
  const miles = num(str(values.loadedMiles));
  if (miles == null || !(miles > 0)) errors.loadedMiles = "Type the loaded miles.";
  else if (miles > 5000) errors.loadedMiles = "Under 5,000 miles.";
  for (const [key, label] of [["emptyToPickup", "Empty miles to the pickup"], ["emptyHome", "Empty miles home"]] as const) {
    const raw = str(values[key]);
    if (raw !== "") {
      const n = num(raw);
      if (n == null || n < 0 || n > 5000) errors[key] = `${label}: a number from 0 to 5,000.`;
    }
  }
  for (const [truck, raw] of Object.entries(values.emptyByTruck ?? {})) {
    const r = str(raw);
    if (r !== "") {
      const n = num(r);
      if (n == null || n < 0 || n > 5000) errors[`empty:${truck}`] = "A number from 0 to 5,000.";
    }
  }
  for (const [truck, raw] of Object.entries(values.emptyHomeByTruck ?? {})) {
    const r = str(raw);
    if (r !== "") {
      const n = num(r);
      if (n == null || n < 0 || n > 5000) errors[`emptyHome:${truck}`] = "A number from 0 to 5,000.";
    }
  }
  const hoursRaw = str(values.loadedHours ?? "");
  if (hoursRaw !== "") {
    const n = num(hoursRaw);
    if (n == null || !(n > 0) || n > 200) errors.loadedHours = "Drive hours, above 0 and under 200.";
  }
  const fscRaw = str(values.fsc);
  if (fscRaw !== "") {
    const n = num(fscRaw);
    if (n == null || n < 0) errors.fsc = "A number, 0 or more.";
    else if (values.fscUnit === "percent" && n > 100) errors.fsc = "A percent from 0 to 100.";
  }
  const marketRaw = str(values.marketRate);
  if (marketRaw !== "") {
    const n = num(marketRaw);
    if (n == null || !(n > 0)) errors.marketRate = "A total for the load, more than 0.";
  }
  const terms = str(values.payTermsDays);
  if (terms !== "") {
    const n = num(terms);
    if (n == null || !Number.isInteger(n) || n < 0 || n > 120) errors.payTermsDays = "Whole days, 0 to 120.";
  }
  const fact = str(values.factoringPct);
  if (fact !== "") {
    const n = num(fact);
    if (n == null || n < 0 || n > 100) errors.factoringPct = "A percent from 0 to 100.";
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const input = readQuote(values)!;
  return { ok: true, input, warnings: quoteWarnings(input) };
}

/**
 * What the phone asks "did you mean" about on this screen: a market rate that works out under $0.50 or over $15 a mile (the usual slip is
 * a per-mile rate typed where the total goes), and a per-mile surcharge over $3.
 */
export function quoteWarnings(input: QuoteInput): string[] {
  const out: string[] = [];
  const miles = input.emptyToPickup + input.loadedMiles + (input.loadBack ? 0 : input.emptyHome);
  if (input.marketTotal != null && miles > 0) {
    const perMile = input.marketTotal / miles;
    if (perMile < 0.5 || perMile > 15) out.push(`A market rate of $${input.marketTotal.toLocaleString("en-US")} over ${Math.round(miles).toLocaleString("en-US")} miles is $${perMile.toFixed(2)} a mile. The market rate is the total for the load, not a rate per mile.`);
  }
  if (input.fscUnit === "per_mile" && isUnusualValue("fscPerMile", input.fsc)) out.push(`A fuel surcharge of $${input.fsc} a loaded mile is above the usual range (under $3).`);
  return out;
}

/** The surcharge in dollars, whichever way it was typed: a percent of the offer or dollars per loaded mile, as the phone adds it. */
export function surchargeDollars(input: Pick<QuoteInput, "offer" | "loadedMiles" | "fsc" | "fscUnit">): number {
  return fuelSurchargeDollars({ offerDollars: input.offer, loadedMiles: input.loadedMiles, amount: input.fsc, unit: input.fscUnit });
}

/** The verdict band's wording on the phone's Calculate header, and the tone it takes here. */
export const BAND_LABEL: Record<MarketBand, { label: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  below_floor: { label: "Below your cost", tone: "bad" },
  needs_fuel: { label: "Add mpg and fuel price", tone: "warn" },
  strong_caution: { label: "Strong caution", tone: "bad" },
  negotiate: { label: "Negotiate up", tone: "warn" },
  at_market: { label: "At market", tone: "info" },
  above_market: { label: "Above market", tone: "ok" },
  no_benchmark: { label: "Add a market rate", tone: "warn" }
};

/** The question asked before a load is accepted that needs a reason, as the phone words it. */
export function gateTitle(gate: AcceptGate): string {
  if (gate === "needs_fuel") return "Book without knowing the fuel cost?";
  if (gate === "no_market") return "Book without knowing the market rate?";
  if (gate === "under_market") return "Book this below-market load?";
  return "Why book a load that does not cover its costs?";
}

/** Why a quote was passed on, in the order the dialog offers them. */
export const PASS_REASONS = ["Rate too low", "Lost to another carrier", "Broker pulled it", "Cannot cover it", "Other"] as const;

/** The phone's override reasons, in its order. */
export const OVERRIDE_REASONS = ["Relationship", "Positioning for return load", "Cash flow", "Other"] as const;
export type OverrideReason = (typeof OVERRIDE_REASONS)[number];

/**
 * What booking needs that pricing does not: a time at both ends. The desk cannot yet edit a stop, and a load with no times cannot be planned
 * or chased, so it is asked for here rather than booked without.
 */
export function missingTimes(stops: Array<{ appointment: string | number | null }>): QuoteErrors {
  const out: QuoteErrors = {};
  const last = stops.length - 1;
  const blank = (v: string | number | null | undefined) => v == null || v === "";
  if (stops.length > 0 && blank(stops[0]!.appointment)) out.stop0Time = "Add the pickup time to book it, so it can be planned.";
  if (stops.length > 1 && blank(stops[last]!.appointment)) out[`stop${last}Time`] = "Add the delivery time to book it.";
  return out;
}

/** Whether there is a load to decide on: an offer and miles. Over an empty form there is nothing to book. */
export const hasSomethingToBook = (input: QuoteInput | null) => input != null && input.offer > 0 && input.loadedMiles > 0;
