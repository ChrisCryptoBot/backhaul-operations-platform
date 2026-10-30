import { computeCostProfileFloorBreakdown, DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE, type CostProfileFloorBreakdown, type CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { PERCENT_MAX } from "./pay";
import { COST_ARCHETYPES, normalizeFscCutAnswer, type CostArchetype, type FscCutAnswer } from "@/truelane/lib/domain/costArchetype";
import { isUnusualValue, needsPercentConfirm, UNUSUAL_VALUE_LIMITS } from "@/truelane/lib/formatNumbers";
import { resolveWizardInsurance } from "@/truelane/lib/insuranceFields";
import { costBuildUp, costProfileHeroMetrics } from "@/truelane/lib/costProfileHero";
import { profileFuelPerMile } from "@/truelane/lib/fuelPriceForRates";
import { ALL_VEHICLE_CATEGORIES, getCostProfileIndustryHydrationStrings, getVehicleCategoryPreset, type VehicleCategory } from "@/truelane/constants/vehicleData";
import { centralInstant, centralParts } from "./zoned";
import { TERMINAL_MAX_LENGTH } from "./terminal";

/**
 * The forms that change who drives and what they drive: a driver, a truck, and a truck's cost profile. Checked here (and again on
 * the server) so a bad value is named next to its field, never silently fixed. The cost profile's floor is TrueLane's own
 * computeCostProfileFloorBreakdown: the preview in the browser and the number the server stores come from the same function.
 */
type Raw = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// ── Drivers ────────────────────────────────────────────────────────────────────────────────────

export type DriverValues = {
  name: string;
  phone: string;
  email: string;
  cdlClass: string;
  /** "2027-03-31", the last day the card is good. */
  cdlExpiry: string;
  medicalCardExpiry: string;
  assignedVehicleId: string;
  /** How they are usually paid: "cpm", "hourly", "flat" (a set amount) or "percent" (of the rate), or blank. A load's assignment starts from it. */
  payKind: string;
  payRate: string;
  /** The yard, branch or region they work out of (free text, up to 40 characters; blank = none). A big fleet is read one terminal at a time. */
  terminal: string;
  /** The carrier authority the driver (or their company) runs under: digits, for the insurance check. Blank when they drive under yours. */
  carrierMc: string;
  carrierDot: string;
  /** Payroll: "employee" or "contractor", and the id the payroll company knows them by. */
  payrollWorkerType: string;
  payrollEmployeeId: string;
};

export const PAY_KINDS = [
  { key: "cpm", label: "Per mile", unit: "$ a mile", max: 5 },
  { key: "hourly", label: "Hourly", unit: "$ an hour", max: 200 },
  { key: "flat", label: "Set amount per load", unit: "$ a load", max: 20000 },
  { key: "percent", label: "Percent of the rate", unit: "% of the rate", max: PERCENT_MAX }
];

export const CDL_CLASSES = ["A", "B", "C"];

/** A date field's "2027-03-31" is the last day the card is good, so it lapses at the end of that Dallas day. */
export function endOfCentralDay(ymd: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number.parseInt(m[1]!, 10), Number.parseInt(m[2]!, 10), Number.parseInt(m[3]!, 10)];
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const t = centralInstant(y, mo - 1, d + 1, 0, 0) - 1;
  const back = centralParts(t);
  return back.y === y && back.m0 === mo - 1 && back.d === d ? new Date(t) : null; // not 31 February
}

/** The "2027-03-31" a stored expiry reads as on the Dallas calendar, for a date field. */
export function ymdOf(d: Date | null | undefined): string {
  if (!d) return "";
  const p = centralParts(d.getTime());
  return `${p.y}-${String(p.m0 + 1).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

export type DriverCheck =
  | { ok: true; value: DriverValues; cdlExpiry: Date | null; medicalCardExpiry: Date | null; payRate: number | null }
  | { ok: false; errors: Partial<Record<keyof DriverValues, string>> };

export function validateDriver(input: Raw): DriverCheck {
  const v: DriverValues = {
    name: str(input.name).replace(/\s+/g, " "),
    phone: str(input.phone),
    email: str(input.email),
    cdlClass: str(input.cdlClass).toUpperCase(),
    cdlExpiry: str(input.cdlExpiry),
    medicalCardExpiry: str(input.medicalCardExpiry),
    assignedVehicleId: str(input.assignedVehicleId),
    payKind: str(input.payKind),
    payRate: str(input.payRate),
    terminal: str(input.terminal).replace(/\s+/g, " "),
    carrierMc: str(input.carrierMc).replace(/^mc[\s-]*/i, ""),
    carrierDot: str(input.carrierDot).replace(/^dot[\s-]*/i, ""),
    payrollWorkerType: str(input.payrollWorkerType),
    payrollEmployeeId: str(input.payrollEmployeeId)
  };
  const errors: Partial<Record<keyof DriverValues, string>> = {};
  if (v.carrierMc && !/^\d{3,8}$/.test(v.carrierMc)) errors.carrierMc = "Digits only, for example 123456.";
  if (v.carrierDot && !/^\d{3,8}$/.test(v.carrierDot)) errors.carrierDot = "Digits only, for example 1234567.";
  if (v.payrollWorkerType && v.payrollWorkerType !== "employee" && v.payrollWorkerType !== "contractor") errors.payrollWorkerType = "Employee or contractor.";
  if (v.payrollEmployeeId.length > 60) errors.payrollEmployeeId = "That id is too long.";
  if (v.terminal.length > TERMINAL_MAX_LENGTH) errors.terminal = "That terminal name is too long.";
  if (v.name.length < 2) errors.name = "Type the driver's name.";
  else if (v.name.length > 80) errors.name = "That name is too long.";
  const digits = v.phone.replace(/\D/g, "");
  if (v.phone && (digits.length < 7 || digits.length > 15 || /[^\d\s()+.\-x]/i.test(v.phone))) errors.phone = "A phone number, for example 555-0142.";
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = "An email address, for example name@example.com.";
  if (v.cdlClass && !CDL_CLASSES.includes(v.cdlClass)) errors.cdlClass = "Class A, B or C.";
  if (v.assignedVehicleId === "?") errors.assignedVehicleId = "Pick a truck from the list, or clear the box.";
  const cdl = v.cdlExpiry ? endOfCentralDay(v.cdlExpiry) : null;
  if (v.cdlExpiry && !cdl) errors.cdlExpiry = "A real date.";
  const med = v.medicalCardExpiry ? endOfCentralDay(v.medicalCardExpiry) : null;
  if (v.medicalCardExpiry && !med) errors.medicalCardExpiry = "A real date.";
  const kind = PAY_KINDS.find((k) => k.key === v.payKind);
  let payRate: number | null = null;
  if (v.payKind && !kind) errors.payKind = "Per mile, hourly, a set amount or a percent of the rate.";
  else if (kind) {
    const n = Number(v.payRate);
    if (v.payRate === "") errors.payRate = "Type the rate.";
    else if (!Number.isFinite(n) || n <= 0 || n > kind.max) errors.payRate = `More than 0 and at most ${kind.max}.`;
    else payRate = n;
  } else if (v.payRate) errors.payKind = "Pick how they are paid.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, cdlExpiry: cdl, medicalCardExpiry: med, payRate };
}

// ── Trucks ─────────────────────────────────────────────────────────────────────────────────────

export type TruckValues = {
  name: string;
  type: string;
  mpg: string;
  fuelType: string;
  homeBaseAddress: string;
  /** The yard, branch or region that runs the truck (free text, up to 40 characters; blank = none). */
  terminal: string;
  /** What the truck is, picked from the phone's own list so its specs fill in: make, model, year, payload and cargo size. */
  make: string;
  model: string;
  year: string;
  payloadLbs: string;
  maxLengthFt: string;
  maxWidthFt: string;
  maxHeightIn: string;
  /** "yes" when the truck has it, blank when not. */
  hasLiftgate: string;
  hasRamp: string;
  hasPalletJack: string;
};
export const BLANK_TRUCK: TruckValues = { name: "", type: "", mpg: "", fuelType: "", homeBaseAddress: "", terminal: "", make: "", model: "", year: "", payloadLbs: "", maxLengthFt: "", maxWidthFt: "", maxHeightIn: "", hasLiftgate: "", hasRamp: "", hasPalletJack: "" };

/** The numbers a truck's specs come to once checked. */
export type TruckSpecs = { year: number | null; payloadLbs: number | null; maxLengthFt: number | null; maxWidthFt: number | null; maxHeightIn: number | null };

/** The phone's vehicle categories, so the type means the same here (and picks the same industry numbers). */
export const TRUCK_TYPES = [
  { key: "cargo_van", label: "Cargo van" },
  { key: "passenger_van", label: "Passenger van" },
  { key: "pickup", label: "Pickup" },
  { key: "sprinter", label: "Sprinter" },
  { key: "box_truck", label: "Box truck" },
  { key: "heavy_duty", label: "Heavy duty (tractor)" }
];
const LEGACY_TRUCK_TYPES: Record<string, string> = { tractor: "heavy_duty", straight_truck: "box_truck", medium_duty: "box_truck" };
/** A stored type with an old value read as its current one; null when blank. */
export const canonicalTruckType = (t: string | null | undefined): string | null => {
  const x = (t ?? "").trim();
  return x === "" ? null : (LEGACY_TRUCK_TYPES[x] ?? x);
};
export const FUEL_TYPES = [
  { key: "diesel", label: "Diesel" },
  { key: "gasoline", label: "Gasoline" }
];

export type TruckCheck = { ok: true; value: TruckValues; mpg: number | null; specs: TruckSpecs } | { ok: false; errors: Partial<Record<keyof TruckValues, string>> };

export function validateTruck(input: Raw): TruckCheck {
  const v: TruckValues = {
    name: str(input.name).replace(/\s+/g, " "),
    type: canonicalTruckType(str(input.type)) ?? "",
    mpg: str(input.mpg),
    fuelType: str(input.fuelType) === "gas" ? "gasoline" : str(input.fuelType),
    homeBaseAddress: str(input.homeBaseAddress),
    terminal: str(input.terminal).replace(/\s+/g, " "),
    make: str(input.make),
    model: str(input.model),
    year: str(input.year),
    payloadLbs: str(input.payloadLbs).replace(/,/g, ""),
    maxLengthFt: str(input.maxLengthFt),
    maxWidthFt: str(input.maxWidthFt),
    maxHeightIn: str(input.maxHeightIn),
    hasLiftgate: str(input.hasLiftgate) === "yes" ? "yes" : "",
    hasRamp: str(input.hasRamp) === "yes" ? "yes" : "",
    hasPalletJack: str(input.hasPalletJack) === "yes" ? "yes" : ""
  };
  const errors: Partial<Record<keyof TruckValues, string>> = {};
  if (v.name.length < 1) errors.name = "Give the truck a name, for example Unit 104.";
  else if (v.name.length > 40) errors.name = "That name is too long.";
  if (v.type && !TRUCK_TYPES.some((t) => t.key === v.type)) errors.type = "Pick a type from the list.";
  if (v.fuelType && !FUEL_TYPES.some((t) => t.key === v.fuelType)) errors.fuelType = "Pick a fuel from the list.";
  let mpg: number | null = null;
  if (v.mpg) {
    const n = Number(v.mpg);
    if (!Number.isFinite(n) || n < 2 || n > 40) errors.mpg = "Miles per gallon between 2 and 40.";
    else mpg = n;
  }
  if (v.terminal.length > TERMINAL_MAX_LENGTH) errors.terminal = "That terminal name is too long.";
  if (v.make.length > 60) errors.make = "That make is too long.";
  if (v.model.length > 60) errors.model = "That model is too long.";
  const spec = (key: "year" | "payloadLbs" | "maxLengthFt" | "maxWidthFt" | "maxHeightIn", min: number, max: number, whole: boolean, message: string): number | null => {
    if (!v[key]) return null;
    const n = Number(v[key]);
    if (!Number.isFinite(n) || n < min || n > max || (whole && !Number.isInteger(n))) {
      errors[key] = message;
      return null;
    }
    return n;
  };
  const specs: TruckSpecs = {
    year: spec("year", 1980, new Date().getFullYear() + 2, true, "A model year, for example 2022."),
    payloadLbs: spec("payloadLbs", 1, 100000, true, "Payload in whole pounds, 1 to 100,000."),
    maxLengthFt: spec("maxLengthFt", 1, 60, false, "Cargo length in feet, 1 to 60."),
    maxWidthFt: spec("maxWidthFt", 1, 10, false, "Cargo width in feet, 1 to 10."),
    maxHeightIn: spec("maxHeightIn", 1, 200, false, "Cargo height in inches, 1 to 200.")
  };
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, mpg, specs };
}

// ── Cost profile ───────────────────────────────────────────────────────────────────────────────

export type ProfileKey =
  | "monthlyInsurance"
  | "insuranceLiabilityMonthly"
  | "insurancePhysicalDamageMonthly"
  | "insuranceCargoMonthly"
  | "insuranceGeneralLiabilityMonthly"
  | "insuranceOtherMonthly"
  | "monthlyAuthority"
  | "monthlyPhoneSubscriptions"
  | "monthlyLoanPayment"
  | "truckReplacementMonthly"
  | "annualFixedCosts"
  | "otherFixedMonthly"
  | "estimatedMonthlyMiles"
  | "maintenanceReservePerMile"
  | "tireReservePerMile"
  | "lastFuelPricePerGallon"
  | "driverHourlyTarget"
  | "hiredDriverHourlyRate"
  | "hiredDriverRatePerMile"
  | "laborBurdenPct"
  | "carrierCutPct"
  | "factoringFeePct"
  | "dailyRevenueTarget"
  | "routeBaseMinimum"
  | "routeIncludedMiles"
  | "routeIncludedStops"
  | "routeOveragePerMile"
  | "routeOveragePerStop"
  | "detentionHourlyRate"
  | "freeGraceMinutes";

export type ProfileGroup = "insurance" | "fixed" | "miles" | "driving" | "labor" | "targets" | "route" | "dock";

export type ProfileField = {
  key: ProfileKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  whole?: boolean;
  /** Typed as a percent (18) and stored as a fraction (0.18), as the phone does. */
  percent?: boolean;
  group: ProfileGroup;
  hint?: string;
};

export const PROFILE_FIELDS: ProfileField[] = [
  { key: "monthlyInsurance", label: "Insurance", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "insuranceLiabilityMonthly", label: "Liability", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "insurancePhysicalDamageMonthly", label: "Physical damage", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "insuranceCargoMonthly", label: "Cargo", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "insuranceGeneralLiabilityMonthly", label: "General liability", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "insuranceOtherMonthly", label: "Other insurance", unit: "$ a month", min: 0, max: 20000, step: 10, group: "insurance" },
  { key: "monthlyAuthority", label: "Operating authority", unit: "$ a month", min: 0, max: 5000, step: 5, group: "fixed" },
  { key: "monthlyPhoneSubscriptions", label: "Phone and subscriptions", unit: "$ a month", min: 0, max: 5000, step: 5, group: "fixed" },
  { key: "monthlyLoanPayment", label: "Truck payment", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed" },
  { key: "truckReplacementMonthly", label: "Set aside to replace the truck", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed", hint: "An owned truck still wears out." },
  { key: "annualFixedCosts", label: "Once-a-year bills", unit: "$ a year", min: 0, max: 100000, step: 50, group: "fixed", hint: "Permits, plates, the highway-use tax. Spread over twelve months." },
  { key: "otherFixedMonthly", label: "Other fixed costs", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed" },
  { key: "estimatedMonthlyMiles", label: "Miles driven in a month", unit: "miles", min: 500, max: 25000, step: 100, whole: true, group: "miles", hint: "The fixed costs are spread over these." },
  { key: "maintenanceReservePerMile", label: "Maintenance set aside", unit: "$ a mile", min: 0, max: 2.5, step: 0.01, group: "miles" },
  { key: "tireReservePerMile", label: "Tires set aside", unit: "$ a mile", min: 0, max: 1.5, step: 0.01, group: "miles" },
  { key: "lastFuelPricePerGallon", label: "Fuel price", unit: "$ a gallon", min: 0.5, max: 25, step: 0.01, group: "driving", hint: "Each verdict adds fuel for the load's own miles at this price. Blank gives no verdict until fuel is known." },
  { key: "driverHourlyTarget", label: "Pay target", unit: "$ an hour", min: 1, max: 200, step: 1, group: "driving", hint: "A load whose profit per hour falls below this is flagged, and extra dock wait is priced at it." },
  { key: "hiredDriverHourlyRate", label: "Driver's hourly pay", unit: "$ an hour", min: 0, max: 200, step: 0.5, group: "labor", hint: "Paid for every hour on a trip: driving and waiting." },
  { key: "hiredDriverRatePerMile", label: "Driver's pay per mile", unit: "$ a mile", min: 0, max: 5, step: 0.01, group: "labor", hint: "Counted on every mile of the trip except a covered way home." },
  { key: "laborBurdenPct", label: "Payroll burden on the driver", unit: "%", min: 0, max: 100, step: 1, percent: true, group: "labor", hint: "Payroll taxes, workers' comp and the rest on top of pay. 18 is typical." },
  { key: "carrierCutPct", label: "Carrier's cut", unit: "%", min: 0, max: 100, step: 1, percent: true, group: "labor", hint: "What the carrier keeps of each load. Type 0 if there is none." },
  { key: "factoringFeePct", label: "Factoring fee", unit: "%", min: 0, max: 100, step: 0.1, percent: true, group: "labor", hint: "Each new load starts from this. Blank means not factoring." },
  { key: "dailyRevenueTarget", label: "Daily revenue target", unit: "$ a day", min: 1, max: 20000, step: 25, group: "targets", hint: "Blank uses 350." },
  { key: "routeBaseMinimum", label: "Route minimum", unit: "$", min: 0, max: 20000, step: 5, group: "route", hint: "What a route must pay before the overages count." },
  { key: "routeIncludedMiles", label: "Miles it includes", unit: "miles", min: 0, max: 5000, step: 5, group: "route" },
  { key: "routeIncludedStops", label: "Stops it includes", unit: "stops", min: 0, max: 100, step: 1, whole: true, group: "route" },
  { key: "routeOveragePerMile", label: "Per extra mile", unit: "$ a mile", min: 0, max: 20, step: 0.05, group: "route" },
  { key: "routeOveragePerStop", label: "Per extra stop", unit: "$ a stop", min: 0, max: 500, step: 1, group: "route" },
  { key: "detentionHourlyRate", label: "Detention rate", unit: "$ an hour", min: 0, max: 300, step: 5, group: "dock", hint: "What a customer pays for waiting past the free time." },
  { key: "freeGraceMinutes", label: "Free time at each stop", unit: "minutes", min: 0, max: 480, step: 15, whole: true, group: "dock", hint: "Blank uses the free time in Settings." }
];

const FIELD = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f])) as Record<ProfileKey, ProfileField>;
export const profileField = (k: ProfileKey) => FIELD[k];

const INSURANCE_BUCKETS: ProfileKey[] = ["insuranceLiabilityMonthly", "insurancePhysicalDamageMonthly", "insuranceCargoMonthly", "insuranceGeneralLiabilityMonthly", "insuranceOtherMonthly"];
const ROUTE_KEYS: ProfileKey[] = ["routeBaseMinimum", "routeIncludedMiles", "routeIncludedStops", "routeOveragePerMile", "routeOveragePerStop"];

/** The answers that are not numbers. The form keeps them as strings ("1" for a switch that is on); the server reads them the same way. */
export type ProfileChoices = {
  archetype: CostArchetype;
  payKind: "hourly" | "cpm";
  fscCut: FscCutAnswer | null;
  insuranceItemised: boolean;
  routeMinimumOn: boolean;
};
export type ProfileValues = Record<ProfileKey, string> & { archetype: string; payKind: string; fscCut: string; insuranceItemised: string; routeMinimumOn: string };
export type ProfileNumbers = Record<ProfileKey, number | null>;
export type ProfileErrorKey = ProfileKey | "archetype" | "payKind" | "fscCut";

/** The numbers the form shows: false for a field that the current answers do not use, so it is neither checked nor saved. */
export function profileFieldApplies(key: ProfileKey, c: ProfileChoices): boolean {
  if (INSURANCE_BUCKETS.includes(key)) return c.insuranceItemised;
  if (key === "monthlyInsurance") return true;
  if (ROUTE_KEYS.includes(key)) return c.routeMinimumOn;
  if (key === "hiredDriverHourlyRate") return c.archetype === "hired_driver" && c.payKind === "hourly";
  if (key === "hiredDriverRatePerMile") return c.archetype === "hired_driver" && c.payKind === "cpm";
  if (key === "laborBurdenPct") return c.archetype === "hired_driver";
  if (key === "carrierCutPct") return c.archetype === "leased_on";
  return true;
}

export type ProfileCheck =
  | { ok: true; numbers: ProfileNumbers; choices: ProfileChoices }
  | { ok: false; errors: Partial<Record<ProfileErrorKey, string>> };

/** The payroll burden a new Owner + driver profile starts from (the phone's DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE, as a percent). */
export const DEFAULT_BURDEN_PERCENT = DEFAULT_LABOR_BURDEN_PCT_NEW_PROFILE * 100;
/** The carrier's cut a leased-on truck starts from (the phone's wizard prefills 20%). It is only a start: the form still needs it confirmed. */
export const DEFAULT_CARRIER_CUT_PERCENT = 20;

export function readChoices(input: Raw): { choices: ProfileChoices; errors: Partial<Record<ProfileErrorKey, string>> } {
  const errors: Partial<Record<ProfileErrorKey, string>> = {};
  const a = str(input.archetype);
  const archetype = (COST_ARCHETYPES.find((x) => x.value === a)?.value ?? (a === "" ? "solo_owner" : null)) as CostArchetype | null;
  if (!archetype) errors.archetype = "Pick one of the three.";
  const p = str(input.payKind);
  const payKind = p === "cpm" ? "cpm" : "hourly";
  const f = str(input.fscCut);
  const fscCut = normalizeFscCutAnswer(f);
  if (f !== "" && !fscCut) errors.fscCut = "Yes, No or Not sure.";
  return {
    choices: { archetype: archetype ?? "solo_owner", payKind, fscCut, insuranceItemised: str(input.insuranceItemised) === "1", routeMinimumOn: str(input.routeMinimumOn) === "1" },
    errors
  };
}

export function validateProfile(input: Raw): ProfileCheck {
  const read = readChoices(input);
  const choices = read.choices;
  const errors: Partial<Record<ProfileErrorKey, string>> = { ...read.errors };
  const numbers = {} as ProfileNumbers;
  for (const f of PROFILE_FIELDS) {
    if (!profileFieldApplies(f.key, choices)) {
      numbers[f.key] = null;
      continue;
    }
    const raw = str(input[f.key]);
    if (raw === "") {
      numbers[f.key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) errors[f.key] = "A number.";
    else if (f.whole && !Number.isInteger(n)) errors[f.key] = "Whole numbers only.";
    else if (n < f.min || n > f.max) errors[f.key] = `Between ${f.min} and ${f.max}.`;
    else numbers[f.key] = n;
  }
  const need = (k: ProfileKey, message = "Required.") => {
    if (errors[k]) return;
    const v = numbers[k];
    if (v == null || !(v > 0)) errors[k] = message;
  };
  need("estimatedMonthlyMiles");
  need("driverHourlyTarget");
  if (choices.archetype === "hired_driver") {
    need(choices.payKind === "cpm" ? "hiredDriverRatePerMile" : "hiredDriverHourlyRate", "Required: what the driver is paid.");
    if (!errors.laborBurdenPct && numbers.laborBurdenPct == null) numbers.laborBurdenPct = DEFAULT_BURDEN_PERCENT;
  }
  if (choices.archetype === "leased_on") {
    if (!errors.carrierCutPct && numbers.carrierCutPct == null) errors.carrierCutPct = "Required. Type 0 if there is no cut.";
    if (!choices.fscCut && !errors.fscCut) errors.fscCut = "Answer this: it decides what the cut is taken from.";
  }
  if (choices.routeMinimumOn) need("routeBaseMinimum", "Required when the route minimum is on.");
  if (choices.insuranceItemised && !Object.keys(errors).some((k) => INSURANCE_BUCKETS.includes(k as ProfileKey))) {
    numbers.monthlyInsurance = INSURANCE_BUCKETS.reduce((s, k) => s + (numbers[k] ?? 0), 0);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, numbers, choices };
}

/**
 * The floor for a set of form values. `base` carries what the form does not edit (the self-employment reserve), so changing one
 * number moves the floor exactly as it would on the phone. Insurance is the typed total, or the sum of its five buckets when they are
 * shown, resolved by the phone's own rule.
 */
export function profileFloors(numbers: ProfileNumbers, choices: ProfileChoices, base: Partial<CostProfileMathInput> = {}): CostProfileFloorBreakdown {
  const n = (k: ProfileKey) => numbers[k] ?? 0;
  const ins = resolveWizardInsurance(
    n("monthlyInsurance"),
    { liability: n("insuranceLiabilityMonthly"), physicalDamage: n("insurancePhysicalDamageMonthly"), cargo: n("insuranceCargoMonthly"), generalLiability: n("insuranceGeneralLiabilityMonthly"), other: n("insuranceOtherMonthly") },
    choices.insuranceItemised
  );
  return computeCostProfileFloorBreakdown({
    ...base,
    monthlyInsurance: ins.monthlyInsurance,
    insuranceLiabilityMonthly: ins.categories.liability,
    insurancePhysicalDamageMonthly: ins.categories.physicalDamage,
    insuranceCargoMonthly: ins.categories.cargo,
    insuranceGeneralLiabilityMonthly: ins.categories.generalLiability,
    insuranceOtherMonthly: ins.categories.other,
    monthlyAuthority: n("monthlyAuthority"),
    monthlyPhoneSubscriptions: n("monthlyPhoneSubscriptions"),
    monthlyLoanPayment: n("monthlyLoanPayment"),
    estimatedMonthlyMiles: n("estimatedMonthlyMiles"),
    maintenanceReservePerMile: n("maintenanceReservePerMile"),
    tireReservePerMile: n("tireReservePerMile"),
    truckReplacementMonthly: n("truckReplacementMonthly"),
    annualFixedCosts: n("annualFixedCosts"),
    otherFixedMonthly: n("otherFixedMonthly"),
    archetype: choices.archetype
  });
}

/**
 * What to confirm before saving, in the phone's own words and limits: a percent of 50 or more is almost always a typo (100 for 10),
 * and a fuel price or reserve outside its plausible range is often a comma read as a decimal point.
 */
export function profileWarnings(numbers: ProfileNumbers, choices: ProfileChoices): string[] {
  const out: string[] = [];
  const burden = numbers.laborBurdenPct;
  if (choices.archetype === "hired_driver" && burden != null && needsPercentConfirm(burden / 100)) out.push(`Payroll burden on the driver is ${burden}%. Typical is about 18%.`);
  const cut = numbers.carrierCutPct;
  if (choices.archetype === "leased_on" && cut != null && needsPercentConfirm(cut / 100)) out.push(`The carrier's cut is ${cut}%. Most take far less.`);
  const fuel = numbers.lastFuelPricePerGallon;
  if (isUnusualValue("fuelPrice", fuel)) out.push(`Fuel price of $${fuel} a gallon is above the usual range (under $${UNUSUAL_VALUE_LIMITS.fuelPrice.max}).`);
  const maint = numbers.maintenanceReservePerMile;
  if (isUnusualValue("reservePerMile", maint)) out.push(`Maintenance set aside of $${maint} a mile is above the usual range (under $${UNUSUAL_VALUE_LIMITS.reservePerMile.max}).`);
  const tires = numbers.tireReservePerMile;
  if (isUnusualValue("reservePerMile", tires)) out.push(`Tires set aside of $${tires} a mile is above the usual range (under $${UNUSUAL_VALUE_LIMITS.reservePerMile.max}).`);
  return out;
}

/** A stored vehicle type as one the presets know, the way the phone reads an old value ("tractor" is a heavy-duty truck). */
export function presetCategory(type: string | null | undefined): VehicleCategory {
  const t = canonicalTruckType(type);
  return t && (ALL_VEHICLE_CATEGORIES as readonly string[]).includes(t) ? (t as VehicleCategory) : "cargo_van";
}

/** The form's starting numbers for a truck type: the phone's industry figures, which "Fill with industry numbers" puts back. */
export function industryValues(type: string | null | undefined): Partial<Record<ProfileKey, string>> {
  const h = getCostProfileIndustryHydrationStrings(presetCategory(type));
  return {
    monthlyInsurance: h.monthlyInsurance,
    monthlyAuthority: h.monthlyAuthority,
    monthlyPhoneSubscriptions: h.monthlyPhoneSubscriptions,
    estimatedMonthlyMiles: h.estimatedMonthlyMiles,
    maintenanceReservePerMile: h.maintenanceReservePerMile,
    tireReservePerMile: h.tireReservePerMile,
    laborBurdenPct: String(DEFAULT_BURDEN_PERCENT)
  };
}

/** The typical ranges for a truck type, for the hint under a field ("Typical 300 to 600"). */
export function typicalBands(type: string | null | undefined): Partial<Record<ProfileKey, string>> {
  const p = getVehicleCategoryPreset(presetCategory(type));
  const band = (b: readonly [number, number]) => `Typical ${b[0]} to ${b[1]}.`;
  return { monthlyInsurance: band(p.typicalInsurance), maintenanceReservePerMile: band(p.typicalMaintenanceCpm), tireReservePerMile: band(p.typicalTireCpm), estimatedMonthlyMiles: band(p.typicalEstimatedMonthlyMiles) };
}

/** Both the hero card and the build-up under it, from the phone's own functions, so the numbers read the way they do there. */
export function profileSummary(floors: CostProfileFloorBreakdown, numbers: ProfileNumbers, mpg: number | null, mpgIsTypical: boolean) {
  const miles = numbers.estimatedMonthlyMiles ?? 0;
  const fuel = profileFuelPerMile({ typedPrice: numbers.lastFuelPricePerGallon, estimatePrice: null, mpg, mpgIsTypical, truckCostPerMile: floors.breakEvenRpm });
  return {
    fuel,
    hero: costProfileHeroMetrics({ truckCostPerMile: floors.breakEvenRpm, billsPerMile: floors.totalFixedCpm, estimatedMiles: miles, milesText: miles > 0 ? String(miles) : "", fuel }),
    buildUp: costBuildUp({ insuranceMonthly: floors.totalInsuranceMonthly, fixedMonthly: floors.totalFixedMonthly, estimatedMiles: miles, maintenancePerMile: floors.maintenanceCpm, tiresPerMile: floors.tireCpm, truckCostPerMile: floors.breakEvenRpm, fuel })
  };
}

/**
 * The floor for whatever is typed so far, ignoring what is not yet valid, so the preview stays live while a labour field is still blank.
 * Null until there are miles to spread the fixed costs over.
 */
export function previewOf(input: Raw, base: Partial<CostProfileMathInput> = {}): { numbers: ProfileNumbers; choices: ProfileChoices; floors: CostProfileFloorBreakdown } | null {
  const { choices } = readChoices(input);
  const numbers = {} as ProfileNumbers;
  for (const f of PROFILE_FIELDS) {
    const raw = str(input[f.key]);
    const n = Number(raw);
    numbers[f.key] = raw !== "" && Number.isFinite(n) && n >= 0 && profileFieldApplies(f.key, choices) ? n : null;
  }
  if (choices.insuranceItemised) numbers.monthlyInsurance = INSURANCE_BUCKETS.reduce((s, k) => s + (numbers[k] ?? 0), 0);
  if (!((numbers.estimatedMonthlyMiles ?? 0) > 0)) return null;
  return { numbers, choices, floors: profileFloors(numbers, choices, base) };
}

/** The truck's own miles per gallon, or the type's typical one (said so on screen) when none is set. */
export function truckMpg(type: string | null | undefined, mpg: number | null | undefined): { mpg: number; typical: boolean } {
  if (mpg != null && mpg > 0) return { mpg, typical: false };
  return { mpg: getVehicleCategoryPreset(presetCategory(type)).defaultMpg, typical: true };
}
