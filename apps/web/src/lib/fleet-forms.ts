import { computeCostProfileFloorBreakdown, type CostProfileFloorBreakdown, type CostProfileMathInput } from "@/truelane/lib/domain/calculators";
import { centralInstant, centralParts } from "./zoned";

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
};

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
  | { ok: true; value: DriverValues; cdlExpiry: Date | null; medicalCardExpiry: Date | null }
  | { ok: false; errors: Partial<Record<keyof DriverValues, string>> };

export function validateDriver(input: Raw): DriverCheck {
  const v: DriverValues = {
    name: str(input.name).replace(/\s+/g, " "),
    phone: str(input.phone),
    email: str(input.email),
    cdlClass: str(input.cdlClass).toUpperCase(),
    cdlExpiry: str(input.cdlExpiry),
    medicalCardExpiry: str(input.medicalCardExpiry),
    assignedVehicleId: str(input.assignedVehicleId)
  };
  const errors: Partial<Record<keyof DriverValues, string>> = {};
  if (v.name.length < 2) errors.name = "Type the driver's name.";
  else if (v.name.length > 80) errors.name = "That name is too long.";
  const digits = v.phone.replace(/\D/g, "");
  if (v.phone && (digits.length < 7 || digits.length > 15 || /[^\d\s()+.\-x]/i.test(v.phone))) errors.phone = "A phone number, for example 555-0142.";
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = "An email address, for example name@example.com.";
  if (v.cdlClass && !CDL_CLASSES.includes(v.cdlClass)) errors.cdlClass = "Class A, B or C.";
  const cdl = v.cdlExpiry ? endOfCentralDay(v.cdlExpiry) : null;
  if (v.cdlExpiry && !cdl) errors.cdlExpiry = "A real date.";
  const med = v.medicalCardExpiry ? endOfCentralDay(v.medicalCardExpiry) : null;
  if (v.medicalCardExpiry && !med) errors.medicalCardExpiry = "A real date.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, cdlExpiry: cdl, medicalCardExpiry: med };
}

// ── Trucks ─────────────────────────────────────────────────────────────────────────────────────

export type TruckValues = { name: string; type: string; mpg: string; fuelType: string; homeBaseAddress: string };

export const TRUCK_TYPES = [
  { key: "tractor", label: "Tractor" },
  { key: "box_truck", label: "Box truck" },
  { key: "straight_truck", label: "Straight truck" },
  { key: "cargo_van", label: "Cargo van" }
];
export const FUEL_TYPES = [
  { key: "diesel", label: "Diesel" },
  { key: "gas", label: "Gasoline" }
];

export type TruckCheck = { ok: true; value: TruckValues; mpg: number | null } | { ok: false; errors: Partial<Record<keyof TruckValues, string>> };

export function validateTruck(input: Raw): TruckCheck {
  const v: TruckValues = { name: str(input.name).replace(/\s+/g, " "), type: str(input.type), mpg: str(input.mpg), fuelType: str(input.fuelType), homeBaseAddress: str(input.homeBaseAddress) };
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
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: v, mpg };
}

// ── Cost profile ───────────────────────────────────────────────────────────────────────────────

export type ProfileKey =
  | "monthlyInsurance"
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
  | "detentionHourlyRate"
  | "freeGraceMinutes";

export type ProfileField = { key: ProfileKey; label: string; unit: string; min: number; max: number; step: number; whole?: boolean; group: "fixed" | "miles" | "driving" | "dock"; hint?: string };

export const PROFILE_FIELDS: ProfileField[] = [
  { key: "monthlyInsurance", label: "Insurance", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed" },
  { key: "monthlyAuthority", label: "Operating authority", unit: "$ a month", min: 0, max: 5000, step: 5, group: "fixed" },
  { key: "monthlyPhoneSubscriptions", label: "Phone and subscriptions", unit: "$ a month", min: 0, max: 5000, step: 5, group: "fixed" },
  { key: "monthlyLoanPayment", label: "Truck payment", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed" },
  { key: "truckReplacementMonthly", label: "Set aside to replace the truck", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed", hint: "An owned truck still wears out." },
  { key: "annualFixedCosts", label: "Once-a-year bills", unit: "$ a year", min: 0, max: 100000, step: 50, group: "fixed", hint: "Permits, plates, the highway-use tax. Spread over twelve months." },
  { key: "otherFixedMonthly", label: "Other fixed costs", unit: "$ a month", min: 0, max: 20000, step: 10, group: "fixed" },
  { key: "estimatedMonthlyMiles", label: "Miles driven in a month", unit: "miles", min: 500, max: 25000, step: 100, whole: true, group: "miles", hint: "The fixed costs are spread over these." },
  { key: "maintenanceReservePerMile", label: "Maintenance set aside", unit: "$ a mile", min: 0, max: 2, step: 0.01, group: "miles" },
  { key: "tireReservePerMile", label: "Tires set aside", unit: "$ a mile", min: 0, max: 1, step: 0.01, group: "miles" },
  { key: "lastFuelPricePerGallon", label: "Fuel price", unit: "$ a gallon", min: 0.5, max: 15, step: 0.01, group: "driving", hint: "Each verdict adds fuel for the load's own miles at this price." },
  { key: "driverHourlyTarget", label: "What the driver should earn", unit: "$ an hour", min: 0, max: 200, step: 1, group: "driving" },
  { key: "detentionHourlyRate", label: "Detention rate", unit: "$ an hour", min: 0, max: 300, step: 5, group: "dock", hint: "What a broker pays for waiting past the free time." },
  { key: "freeGraceMinutes", label: "Free time at each stop", unit: "minutes", min: 0, max: 480, step: 15, whole: true, group: "dock", hint: "Blank uses the free time in Settings." }
];

export type ProfileValues = Record<ProfileKey, string>;
/** Fields the form cannot be left without; the rest may be blank (blank means 0, or the Settings default for free time). */
const REQUIRED: ProfileKey[] = ["estimatedMonthlyMiles"];

export type ProfileCheck =
  | { ok: true; numbers: Record<ProfileKey, number | null> }
  | { ok: false; errors: Partial<Record<ProfileKey, string>> };

export function validateProfile(input: Raw): ProfileCheck {
  const errors: Partial<Record<ProfileKey, string>> = {};
  const numbers = {} as Record<ProfileKey, number | null>;
  for (const f of PROFILE_FIELDS) {
    const raw = str(input[f.key]);
    if (raw === "") {
      if (REQUIRED.includes(f.key)) errors[f.key] = "Required.";
      numbers[f.key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) errors[f.key] = "A number.";
    else if (f.whole && !Number.isInteger(n)) errors[f.key] = "Whole numbers only.";
    else if (n < f.min || n > f.max) errors[f.key] = `Between ${f.min} and ${f.max}.`;
    else numbers[f.key] = n;
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, numbers };
}

/**
 * The floor for a set of form values. `base` carries what the form does not edit (itemised insurance, the archetype, the hired-driver
 * terms), so changing one number moves the floor exactly as it would on the phone.
 */
export function profileFloors(numbers: Record<ProfileKey, number | null>, base: Partial<CostProfileMathInput> = {}): CostProfileFloorBreakdown {
  const n = (k: ProfileKey) => numbers[k] ?? 0;
  return computeCostProfileFloorBreakdown({
    ...base,
    monthlyInsurance: n("monthlyInsurance"),
    monthlyAuthority: n("monthlyAuthority"),
    monthlyPhoneSubscriptions: n("monthlyPhoneSubscriptions"),
    monthlyLoanPayment: n("monthlyLoanPayment"),
    estimatedMonthlyMiles: n("estimatedMonthlyMiles"),
    maintenanceReservePerMile: n("maintenanceReservePerMile"),
    tireReservePerMile: n("tireReservePerMile"),
    truckReplacementMonthly: n("truckReplacementMonthly"),
    annualFixedCosts: n("annualFixedCosts"),
    otherFixedMonthly: numbers.otherFixedMonthly ?? base.otherFixedMonthly ?? 0
  });
}
